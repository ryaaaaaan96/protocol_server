//! Portable, project-scoped PostgreSQL custom archives. Uploaded SQL is never executed.
use crate::{
    error::{AppError, Result},
    topology,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

const MAX_DECODED: u64 = 64 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;

// Restore processing rows before their forwarding references.
const INSERT_ORDER: &[&str] = &["process_points", "collect_points", "transmit_points"];

// Legacy archives have two point tables; v6 adds collection mappings. Only
// these explicit version pairs are compatible with the portable restore path.
fn supported_archive(payload: &Value) -> bool {
    (payload["schema_version"] == 4 && payload["migration_version"] == 1)
        || (payload["schema_version"] == 5 && payload["migration_version"] == 2)
        || (payload["schema_version"] == 6 && payload["migration_version"] == 3)
        || (payload["schema_version"] == 7 && payload["migration_version"] == 4)
}

fn columns(table: &str) -> String {
    let fields = match table {
        "process_points" => crate::native_points::PROCESS_COLUMNS,
        "transmit_points" => crate::native_points::TRANSMIT_COLUMNS,
        "collect_points" => crate::native_protocol::COLLECT_COLUMNS,
        _ => unreachable!("dump table allowlist"),
    };
    format!("id,project_id,board_key,{fields}")
}
fn references(table: &str) -> &'static [(&'static str, &'static str)] {
    match table {
        "transmit_points" | "collect_points" => &[("process_point_id", "process_points")],
        _ => &[],
    }
}

fn positive(value: &Value) -> Option<i64> {
    value.as_i64().filter(|id| *id > 0)
}

/// Structural and referential checks before any database writes.
pub fn validate(payload: &Value, expected_key: &str) -> Result<()> {
    if payload["format"] != "protocol-studio-project"
        || payload["version"] != 1
        || payload["key"] != expected_key
        || positive(&payload["migration_version"]).is_none()
    {
        return Err(AppError::bad(
            "Dump 格式、版本或项目 key 不匹配；请使用 scripts/export-project.mjs 导出项目",
        ));
    }
    if !supported_archive(payload) {
        return Err(AppError::bad(
            "Dump 结构或迁移版本不兼容；仅接受 4/1、5/2、6/3、7/4 的项目归档",
        ));
    }
    let tables = payload["tables"]
        .as_object()
        .ok_or_else(|| AppError::bad("Dump 缺少业务表数据"))?;
    let expected: BTreeSet<_> = topology::TABLES
        .iter()
        .copied()
        .filter(|t| {
            *t != "collect_points" || payload["schema_version"].as_i64().is_some_and(|v| v >= 6)
        })
        .collect();
    if tables.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected {
        return Err(AppError::bad("Dump 业务表清单不完整或包含不支持的表"));
    }
    let mut ids: BTreeMap<&str, BTreeSet<i64>> = BTreeMap::new();
    let mut source_project = None;
    let mut count = 0;
    for &table in INSERT_ORDER {
        if table == "collect_points" && payload["schema_version"].as_i64().is_some_and(|v| v < 6) {
            continue;
        }
        let rows = tables[table]
            .as_array()
            .ok_or_else(|| AppError::bad(format!("Dump {table} 必须为数组")))?;
        count += rows.len();
        if count > MAX_ROWS {
            return Err(AppError::bad("Dump 超过 100000 条业务记录限制"));
        }
        let allowed_columns = columns(table);
        let allowed: BTreeSet<_> = allowed_columns.split(',').collect();
        let mut table_ids = BTreeSet::new();
        for row in rows {
            let object = row
                .as_object()
                .ok_or_else(|| AppError::bad(format!("Dump {table} 行必须为对象")))?;
            if object.keys().any(|key| !allowed.contains(key.as_str())) {
                return Err(AppError::bad(format!(
                    "Dump {table} 包含未知字段，请使用匹配版本的导出脚本"
                )));
            }
            let id = positive(&row["id"])
                .ok_or_else(|| AppError::bad(format!("Dump {table} id 无效")))?;
            let pid = positive(&row["project_id"])
                .ok_or_else(|| AppError::bad(format!("Dump {table} project_id 无效")))?;
            if !table_ids.insert(id) {
                return Err(AppError::bad(format!("Dump {table} 存在重复 id")));
            }
            if source_project.is_some_and(|old| old != pid) {
                return Err(AppError::bad("Dump 包含多个项目的数据"));
            }
            source_project = Some(pid);
        }
        ids.insert(table, table_ids);
    }
    for &table in INSERT_ORDER {
        for row in topology::rows(&payload["tables"], table) {
            for &(column, target) in references(table) {
                if !positive(&row[column]).is_some_and(|id| ids[target].contains(&id)) {
                    return Err(AppError::bad(format!(
                        "Dump {table}.{column} 引用了不存在的 {target} 记录"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn copy_unescape(input: &str) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(ch) = chars.next() {
        if ch != b'\\' {
            output.push(ch);
            continue;
        }
        let escaped = chars
            .next()
            .ok_or_else(|| AppError::bad("Dump COPY 转义不完整"))?;
        output.push(match escaped {
            b'\\' => b'\\',
            b'b' => 8,
            b'f' => 12,
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'v' => 11,
            _ => return Err(AppError::bad("Dump COPY 包含不支持的转义")),
        });
    }
    Ok(output)
}

fn parse_output(output: &[u8], expected_key: &str) -> Result<Value> {
    let text = std::str::from_utf8(output).map_err(|_| AppError::bad("Dump 数据不是 UTF-8"))?;
    let marker = "COPY public.protocol_studio_project_dump (payload) FROM stdin;";
    let mut found = None;
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line != marker {
            continue;
        }
        if found.is_some() {
            return Err(AppError::bad("Dump 包含重复数据段"));
        }
        let row = lines
            .next()
            .ok_or_else(|| AppError::bad("Dump 缺少项目数据行"))?;
        if row.contains('\t') || lines.next() != Some("\\.") {
            return Err(AppError::bad("Dump 必须包含一条项目数据记录"));
        }
        found = Some(serde_json::from_slice::<Value>(&copy_unescape(row)?)?);
    }
    let payload = found.ok_or_else(|| {
        AppError::bad("不支持整库或普通表 Dump；请使用 scripts/export-project.mjs 导出单项目 Dump")
    })?;
    validate(&payload, expected_key)?;
    Ok(payload)
}

/// pg_restore only renders the selected COPY data to stdout, without a DB connection.
/// Output/time limits bound archive decompression. No emitted SQL is executed.
pub async fn decode(path: &Path, expected_key: &str) -> Result<Value> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| AppError::bad("无法读取项目 Dump"))?;
    let mut signature = [0; 5];
    file.read_exact(&mut signature)
        .await
        .map_err(|_| AppError::bad("项目 Dump 文件不完整"))?;
    if &signature != b"PGDMP" {
        return Err(AppError::bad(
            "项目 Dump 必须是 pg_dump -Fc 生成的 custom 归档",
        ));
    }
    let executable = std::env::var_os("PG_RESTORE_BIN").unwrap_or_else(|| "pg_restore".into());
    let mut child = Command::new(executable)
        .args([
            "--format=custom",
            "--data-only",
            "--no-owner",
            "--no-privileges",
            "--schema=public",
            "--table=protocol_studio_project_dump",
            "--file=-",
            "--",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C")
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            AppError::bad("无法启动 pg_restore；请安装 PostgreSQL 客户端或配置 PG_RESTORE_BIN")
        })?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let read = |stream: Box<dyn tokio::io::AsyncRead + Unpin + Send>, limit: u64| async move {
            let mut data = Vec::new();
            stream
                .take(limit + 1)
                .read_to_end(&mut data)
                .await
                .map_err(|_| AppError::bad("读取 pg_restore 输出失败"))?;
            if data.len() as u64 > limit {
                return Err(AppError::bad("Dump 解压内容超过大小限制"));
            }
            Ok(data)
        };
        let (output, errors) = tokio::try_join!(
            read(Box::new(stdout), MAX_DECODED),
            read(Box::new(stderr), 64 * 1024)
        )?;
        let status = child
            .wait()
            .await
            .map_err(|_| AppError::bad("pg_restore 执行失败"))?;
        if !status.success() {
            tracing::warn!(detail=%String::from_utf8_lossy(&errors), "project dump decode failed");
            return Err(AppError::bad(
                "无法解析 Dump；请检查文件完整性及 pg_restore 客户端版本",
            ));
        }
        parse_output(&output, expected_key)
    })
    .await;
    result.map_err(|_| AppError::bad("Dump 解析超时"))?
}

/// Caller owns the transaction, admin/edit-lock/revision checks, preview rollback,
/// topology validation, revision bump and audit. This never commits independently.
pub async fn replace(tx: &mut PgConnection, pid: i64, payload: &Value) -> Result<Value> {
    let (key, schema_version): (Option<String>, i32) =
        sqlx::query_as("SELECT config_key,schema_version FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    validate(payload, key.as_deref().unwrap_or_default())?;
    if schema_version != 7 {
        return Err(AppError::bad("请先将目标项目迁移到 v7，再导入 Dump"));
    }
    for table in INSERT_ORDER.iter().rev() {
        sqlx::query(&format!("DELETE FROM points.{table} WHERE project_id=$1"))
            .bind(pid)
            .execute(&mut *tx)
            .await?;
    }
    let mut mappings: BTreeMap<&str, BTreeMap<i64, i64>> = BTreeMap::new();
    let mut counts = serde_json::Map::new();
    for &table in INSERT_ORDER {
        let rows = topology::rows(&payload["tables"], table);
        let allocated: Vec<i64> = sqlx::query_scalar(
            "SELECT nextval(pg_get_serial_sequence($1,'id')) FROM generate_series(1,$2::int)",
        )
        .bind(format!("points.{table}"))
        .bind(rows.len() as i32)
        .fetch_all(&mut *tx)
        .await?;
        let mapping: BTreeMap<_, _> = rows
            .iter()
            .zip(allocated)
            .map(|(row, id)| (row["id"].as_i64().unwrap(), id))
            .collect();
        let mut remapped = Vec::with_capacity(rows.len());
        for row in rows {
            let mut next = row.clone();
            if table == "transmit_points"
                && payload["schema_version"].as_i64().is_some_and(|v| v < 6)
            {
                next["register_type"] = json!("HOLDING");
                next["metadata"] = json!({});
            }
            let id = mapping[&row["id"].as_i64().unwrap()];
            next["id"] = json!(id);
            next["project_id"] = json!(pid);
            for &(column, target) in references(table) {
                if let Some(old) = row[column].as_i64() {
                    next[column] = json!(mappings[target][&old]);
                }
            }
            remapped.push(next);
        }
        if !remapped.is_empty() {
            let cols = columns(table);
            sqlx::query(&format!("INSERT INTO points.{table} ({cols}) SELECT {cols} FROM jsonb_populate_recordset(NULL::points.{table},$1::jsonb)"))
                .bind(json!(remapped)).execute(&mut *tx).await?;
        }
        counts.insert(table.into(), json!(rows.len()));
        mappings.insert(table, mapping);
    }
    Ok(json!({"tables":counts,"source_revision":payload["source_revision"]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> Value {
        let tables: serde_json::Map<_, _> = ["process_points", "transmit_points"]
            .iter()
            .map(|table| ((*table).into(), json!([])))
            .collect();
        json!({"format":"protocol-studio-project","version":1,"schema_version":5,"migration_version":2,"key":"example","tables":tables})
    }
    #[test]
    fn accepts_only_explicitly_compatible_archive_versions() {
        let mut data = empty();
        assert!(validate(&data, "example").is_ok());
        data["schema_version"] = json!(4);
        data["migration_version"] = json!(1);
        assert!(validate(&data, "example").is_ok());
        data["migration_version"] = json!(2);
        assert!(validate(&data, "example").is_err());
        data["schema_version"] = json!(3);
        data["migration_version"] = json!(1);
        assert!(validate(&data, "example").is_err());
        data["schema_version"] = json!(5);
        data["migration_version"] = json!(999999);
        assert!(validate(&data, "example").is_err());
    }
    #[test]
    fn collection_archives_require_v6_and_valid_process_references() {
        let mut data = empty();
        data["tables"]["collect_points"] = json!([]);
        assert!(validate(&data, "example").is_err());
        data["schema_version"] = json!(6);
        data["migration_version"] = json!(3);
        assert!(validate(&data, "example").is_ok());
        data["tables"]["process_points"] = json!([{"id":1,"project_id":5,"board_key":"UPM"}]);
        data["tables"]["collect_points"] =
            json!([{"id":2,"project_id":5,"board_key":"UPM","process_point_id":1}]);
        assert!(validate(&data, "example").is_ok());
        data["tables"]["collect_points"][0]["process_point_id"] = json!(3);
        assert!(validate(&data, "example").is_err());
        data["tables"]
            .as_object_mut()
            .unwrap()
            .remove("collect_points");
        assert!(validate(&data, "example").is_err());
    }
    #[test]
    fn only_project_payload_is_accepted() {
        let data = empty();
        assert!(validate(&data, "example").is_ok());
        assert!(validate(&data, "other").is_err());
        let mut invalid = data.clone();
        invalid["tables"]["users"] = json!([]);
        assert!(validate(&invalid, "example").is_err());
        let encoded = serde_json::to_string(&data).unwrap().replace('\\', "\\\\");
        let sql = format!(
            "-- irrelevant SQL is never executed\nDROP DATABASE ignored;\nCOPY public.protocol_studio_project_dump (payload) FROM stdin;\n{encoded}\n\\.\n"
        );
        assert_eq!(parse_output(sql.as_bytes(), "example").unwrap(), data);
        assert!(parse_output(b"COPY public.users (id) FROM stdin;\n1\n\\.\n", "example").is_err());
        assert!(parse_output(sql.replace("\\.\n", "{}\n\\.\n").as_bytes(), "example").is_err());
    }
    #[test]
    fn project_boundaries_and_foreign_keys_are_checked() {
        let mut data = empty();
        data["tables"]["process_points"] = json!([{"id":1,"project_id":5,"board_key":"DSP"}]);
        data["tables"]["transmit_points"] = json!([{"id":2,"project_id":5,"process_point_id":1}]);
        assert!(validate(&data, "example").is_ok());
        data["tables"]["transmit_points"][0]["project_id"] = json!(6);
        assert!(validate(&data, "example").is_err());
        data["tables"]["transmit_points"][0]["project_id"] = json!(5);
        data["tables"]["transmit_points"][0]["process_point_id"] = json!(9);
        assert!(validate(&data, "example").is_err());
    }
    #[test]
    fn postgres_copy_escapes_preserve_json_and_unicode() {
        let source = json!({"label":"DSP 中文\nline\tsecond", "literal":"\\u1234"});
        let text = serde_json::to_string(&source).unwrap();
        let copied = text.replace('\\', "\\\\");
        assert_eq!(
            serde_json::from_slice::<Value>(&copy_unescape(&copied).unwrap()).unwrap(),
            source
        );
        assert!(copy_unescape("trailing\\").is_err());
    }
}
