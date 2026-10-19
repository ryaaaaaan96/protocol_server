//! Portable, project-scoped PostgreSQL custom archives. Uploaded SQL is never executed.
use crate::{
    db,
    error::{AppError, Result},
    topology,
};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

const MAX_DECODED: u64 = 64 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;

fn supported_migration_version() -> i64 {
    sqlx::migrate!()
        .iter()
        .map(|migration| migration.version)
        .max()
        .expect("application includes database migrations")
}
// Dependency order; platform signal_id is a protocol number, not a signals FK.
const INSERT_ORDER: &[&str] = &[
    "platform_signals",
    "board_models",
    "boards",
    "data_items",
    "signal_groups",
    "signals",
    "signal_ranges",
    "device_contexts",
    "protocol_contracts",
    "protocol_fields",
    "endpoints",
    "signal_bindings",
    "board_links",
    "passthrough_routes",
    "source_records",
    "process_points",
    "transmit_points",
];

fn columns(table: &str) -> String {
    let extra = match table {
        "process_points" => {
            return format!(
                "id,project_id,board_key,{}",
                crate::dsp_points::PROCESS_COLUMNS
            );
        }
        "transmit_points" => {
            return format!(
                "id,project_id,board_key,{}",
                crate::dsp_points::TRANSMIT_COLUMNS
            );
        }
        "data_items" => {
            "name,data_type,byte_length,unit,default_value,min_value,max_value,notes,source_sheet,source_row,raw_json"
        }
        "source_records" => "sheet,row_number,cells,classification",
        "signals" => {
            "group_id,data_item_id,name,enum_name,sig_id,sig_symbol,flags,callback,process_enabled,internal_type,display_order"
        }
        "signal_bindings" => {
            "endpoint_id,context_id,field_id,signal_id,poll_interval,set_priority,scan_priority,display_order"
        }
        _ => topology::columns(table).expect("dump table allowlist"),
    };
    format!("id,project_id,{extra}")
}

fn references(table: &str) -> &'static [(&'static str, &'static str)] {
    match table {
        "transmit_points" => &[("process_point_id", "process_points")],
        "boards" | "signal_groups" => &[("model_id", "board_models")],
        "signals" => &[
            ("group_id", "signal_groups"),
            ("data_item_id", "data_items"),
        ],
        "signal_ranges" => &[("signal_id", "signals")],
        "device_contexts" => &[("model_id", "board_models"), ("group_id", "signal_groups")],
        "protocol_fields" => &[
            ("contract_id", "protocol_contracts"),
            ("data_item_id", "data_items"),
        ],
        "endpoints" => &[
            ("model_id", "board_models"),
            ("contract_id", "protocol_contracts"),
        ],
        "signal_bindings" => &[
            ("endpoint_id", "endpoints"),
            ("context_id", "device_contexts"),
            ("field_id", "protocol_fields"),
            ("signal_id", "signals"),
        ],
        "board_links" => &[
            ("client_board_id", "boards"),
            ("server_board_id", "boards"),
            ("client_endpoint_id", "endpoints"),
            ("server_endpoint_id", "endpoints"),
            ("client_context_id", "device_contexts"),
        ],
        "passthrough_routes" => &[
            ("server_endpoint_id", "endpoints"),
            ("client_endpoint_id", "endpoints"),
            ("context_id", "device_contexts"),
        ],
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
        || payload["schema_version"] != 2
        || payload["key"] != expected_key
        || positive(&payload["migration_version"]).is_none()
    {
        return Err(AppError::bad(
            "Dump 格式、版本或项目 key 不匹配；请使用 scripts/export-project.mjs 导出项目",
        ));
    }
    let tables = payload["tables"]
        .as_object()
        .ok_or_else(|| AppError::bad("Dump 缺少业务表数据"))?;
    let expected: BTreeSet<_> = topology::TABLES.iter().copied().collect();
    if tables.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected {
        return Err(AppError::bad("Dump 业务表清单不完整或包含不支持的表"));
    }
    let mut ids: BTreeMap<&str, BTreeSet<i64>> = BTreeMap::new();
    let mut source_project = None;
    let mut count = 0;
    for &table in INSERT_ORDER {
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
    let symbols: BTreeSet<_> = topology::rows(&payload["tables"], "platform_signals")
        .iter()
        .filter_map(|row| row["symbol"].as_str())
        .collect();
    for &table in INSERT_ORDER {
        for row in topology::rows(&payload["tables"], table) {
            for &(column, target) in references(table) {
                if table == "device_contexts" && column == "group_id" && row[column].is_null() {
                    continue;
                }
                if !positive(&row[column]).is_some_and(|id| ids[target].contains(&id)) {
                    return Err(AppError::bad(format!(
                        "Dump {table}.{column} 引用了不存在的 {target} 记录"
                    )));
                }
            }
            if table == "signals"
                && !row["sig_symbol"].is_null()
                && !row["sig_symbol"]
                    .as_str()
                    .is_some_and(|value| symbols.contains(value))
            {
                return Err(AppError::bad(
                    "Dump signals.sig_symbol 引用了不存在的平台信号",
                ));
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
pub async fn replace(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    payload: &Value,
) -> Result<Value> {
    let (key, schema_version): (Option<String>, i32) =
        sqlx::query_as("SELECT config_key,schema_version FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut **tx)
            .await?;
    validate(payload, key.as_deref().unwrap_or_default())?;
    if schema_version != 2 {
        return Err(AppError::bad("请先将目标项目迁移到 v2，再导入 Dump"));
    }
    // SQLx owns its migration ledger. The runtime role deliberately cannot read
    // that private table; the archive must match this application's embedded schema.
    let migration = supported_migration_version();
    if payload["migration_version"] != migration {
        return Err(AppError::bad(format!(
            "Dump 迁移版本与当前程序支持版本 {migration} 不一致，请先统一版本再导出"
        )));
    }
    let grants = db::all_json(tx, "SELECT to_jsonb(g) || jsonb_build_object('model_code',m.code,'contract_code',c.code) FROM project_member_grants g JOIN board_models m ON m.project_id=g.project_id AND m.id=g.model_id LEFT JOIN protocol_contracts c ON c.project_id=g.project_id AND c.id=g.contract_id WHERE g.project_id=$1", pid).await?;
    for grant in &grants {
        for (table, column) in [
            ("board_models", "model_code"),
            ("protocol_contracts", "contract_code"),
        ] {
            if grant[column].is_null() {
                continue;
            }
            if !topology::rows(&payload["tables"], table)
                .iter()
                .any(|row| row["code"] == grant[column])
            {
                return Err(AppError::bad(format!(
                    "Dump 缺少已有成员授权对应的 {}，请先调整成员权限",
                    grant[column]
                )));
            }
        }
    }
    for table in INSERT_ORDER.iter().rev() {
        sqlx::query(&format!("DELETE FROM {table} WHERE project_id=$1"))
            .bind(pid)
            .execute(&mut **tx)
            .await?;
    }
    let mut mappings: BTreeMap<&str, BTreeMap<i64, i64>> = BTreeMap::new();
    let mut counts = serde_json::Map::new();
    let mut imported_codes: BTreeMap<&str, BTreeMap<String, i64>> = BTreeMap::new();
    for &table in INSERT_ORDER {
        let rows = topology::rows(&payload["tables"], table);
        let allocated: Vec<i64> = sqlx::query_scalar(
            "SELECT nextval(pg_get_serial_sequence($1,'id')) FROM generate_series(1,$2::int)",
        )
        .bind(table)
        .bind(rows.len() as i32)
        .fetch_all(&mut **tx)
        .await?;
        let mapping: BTreeMap<_, _> = rows
            .iter()
            .zip(allocated)
            .map(|(row, id)| (row["id"].as_i64().unwrap(), id))
            .collect();
        let mut remapped = Vec::with_capacity(rows.len());
        let mut codes = BTreeMap::new();
        for row in rows {
            let mut next = row.clone();
            let id = mapping[&row["id"].as_i64().unwrap()];
            next["id"] = json!(id);
            next["project_id"] = json!(pid);
            for &(column, target) in references(table) {
                if let Some(old) = row[column].as_i64() {
                    next[column] = json!(mappings[target][&old]);
                }
            }
            if let Some(code) = row["code"].as_str() {
                codes.insert(code.to_owned(), id);
            }
            remapped.push(next);
        }
        if !remapped.is_empty() {
            let cols = columns(table);
            sqlx::query(&format!("INSERT INTO {table} ({cols}) SELECT {cols} FROM jsonb_populate_recordset(NULL::{table},$1::jsonb)"))
                .bind(json!(remapped)).execute(&mut **tx).await?;
        }
        counts.insert(table.into(), json!(rows.len()));
        imported_codes.insert(table, codes);
        mappings.insert(table, mapping);
    }
    // Preserve scoped member permissions using stable codes instead of imported IDs.
    for grant in grants {
        let model = imported_codes["board_models"][grant["model_code"].as_str().unwrap()];
        let contract = grant["contract_code"]
            .as_str()
            .map(|code| imported_codes["protocol_contracts"][code]);
        sqlx::query("INSERT INTO project_member_grants(project_id,user_id,model_id,scope,contract_id) VALUES($1,$2,$3,$4,$5)")
            .bind(pid).bind(grant["user_id"].as_i64().unwrap()).bind(model).bind(grant["scope"].as_str().unwrap()).bind(contract)
            .execute(&mut **tx).await?;
    }
    Ok(json!({"tables":counts,"source_revision":payload["source_revision"]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> Value {
        let tables: serde_json::Map<_, _> = topology::TABLES
            .iter()
            .map(|table| ((*table).into(), json!([])))
            .collect();
        json!({"format":"protocol-studio-project","version":1,"schema_version":2,"migration_version":supported_migration_version(),"key":"example","tables":tables})
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
        data["tables"]["board_models"] = json!([{"id":1,"project_id":5,"code":"DSP"}]);
        data["tables"]["boards"] = json!([{"id":2,"project_id":5,"model_id":1}]);
        assert!(validate(&data, "example").is_ok());
        data["tables"]["boards"][0]["project_id"] = json!(6);
        assert!(validate(&data, "example").is_err());
        data["tables"]["boards"][0]["project_id"] = json!(5);
        data["tables"]["boards"][0]["model_id"] = json!(9);
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
