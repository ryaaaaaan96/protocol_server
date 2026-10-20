//! Transaction-scoped table definitions and the shared lifecycle for table plugins.
//! Definitions are request snapshots, never stored in topology or point rows.
use crate::{
    error::{AppError, Result},
    topology::{num, rows, strv},
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;

pub async fn bind(
    tx: &mut PgConnection,
    pid: i64,
    files: &crate::project_files::ProjectFiles,
) -> Result<Value> {
    let key: Option<String> =
        sqlx::query_scalar("SELECT config_key FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    let definitions = files
        .definition(key.as_deref())
        .map_err(|e| AppError::bad(format!("{e:#}")))?;
    set(tx, pid, &definitions["boards"]).await?;
    Ok(definitions["boards"].clone())
}
pub async fn set(tx: &mut PgConnection, pid: i64, boards: &Value) -> Result<()> {
    sqlx::query("SELECT set_config('app.table_definitions',$1,true)")
        .bind(json!({"project_id":pid,"boards":boards}).to_string())
        .execute(&mut *tx)
        .await?;
    Ok(())
}
pub async fn definitions(tx: &mut PgConnection, pid: i64) -> Result<Value> {
    let value: Option<Value> = sqlx::query_scalar(
        "SELECT NULLIF(current_setting('app.table_definitions',true),'')::jsonb",
    )
    .fetch_one(&mut *tx)
    .await?;
    Ok(value
        .filter(|v| v["project_id"] == pid)
        .map(|v| v["boards"].clone())
        .unwrap_or(json!({})))
}
pub async fn board_definitions(tx: &mut PgConnection, pid: i64, board: &str) -> Result<Value> {
    let value: Option<Value> = sqlx::query_scalar("SELECT CASE WHEN (NULLIF(current_setting('app.table_definitions',true),'')::jsonb->>'project_id')::bigint=$1 THEN NULLIF(current_setting('app.table_definitions',true),'')::jsonb->'boards'->$2 ELSE NULL END")
        .bind(pid).bind(board).fetch_one(&mut *tx).await?;
    Ok(value.unwrap_or(Value::Null))
}
pub fn validate_declarations(kind: &str, definition: &Value) -> Result<()> {
    let rule = &definition["behavior"];
    let allowed = crate::point_tables::writable(kind);
    // Display hooks cannot replace protocol data and then validate/export the
    // replacement. Legacy compatibility values must be explicitly script-owned.
    for field in rule["project_fields"].as_array().into_iter().flatten() {
        let key = field.as_str().unwrap_or("");
        if allowed.contains(key)
            && !(["name", "enabled", "conversion", "byte_order"].contains(&key)
                && rule["owned_fields"]
                    .as_array()
                    .is_some_and(|v| v.contains(field)))
        {
            return Err(AppError::bad(format!(
                "project_fields 不能覆盖存储字段 {key}；请使用独立展示列"
            )));
        }
    }
    for field in rule["owned_fields"].as_array().into_iter().flatten() {
        let key = field.as_str().unwrap_or("");
        if !allowed.contains(key)
            || [
                "process_point_id",
                "endpoint_key",
                "group_key",
                "address",
                "wire_length",
                "wire_type",
                "scale",
            ]
            .contains(&key)
        {
            return Err(AppError::bad(format!(
                "behavior.owned_fields 不支持 {key}；引用、人工协议设置和布局不可由联动规则覆盖"
            )));
        }
    }
    for field in rule["linked_fields"].as_array().into_iter().flatten() {
        if kind != "forward" || field != "address" || definition.get("calculation").is_some() {
            return Err(AppError::bad(
                "linked_fields 仅支持未配置 calculation 的转发表 address",
            ));
        }
    }
    for field in rule["editable_fields"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(rule["project_fields"].as_array().into_iter().flatten())
    {
        if definition["fields"]
            .get(field.as_str().unwrap_or(""))
            .is_none()
        {
            return Err(AppError::bad("behavior 声明的字段须同时在 fields 中定义"));
        }
    }
    if definition["editor"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|f| {
            rule["owned_fields"]
                .as_array()
                .is_some_and(|v| v.contains(f))
        })
    {
        return Err(AppError::bad("脚本联动字段不能同时配置为编辑字段"));
    }
    Ok(())
}
pub fn check_updates(kind: &str, values: &Map<String, Value>) -> Result<()> {
    let allowed = crate::point_tables::writable(kind);
    for key in values.keys() {
        if key != "metadata" && !allowed.contains(key.as_str()) {
            return Err(AppError::bad(format!(
                "表脚本不能写入 {key}，记录身份、来源与系统字段只读"
            )));
        }
    }
    Ok(())
}
pub fn sources(definitions: &Value, source: &[Value]) -> Result<Vec<Value>> {
    let mut projected = source.to_vec();
    crate::table_behavior::project(&definitions["process"], &mut projected, &[])?;
    Ok(projected)
}
fn source_tables(definitions: &Value) -> std::collections::BTreeSet<&str> {
    ["process", "collect", "forward"]
        .into_iter()
        .flat_map(|kind| {
            definitions[kind]["behavior"]["source_tables"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
        })
        .collect()
}
/// Related mappings are read-only script context. IDs remain native record IDs.
pub fn related_sources(
    definitions: &Value,
    source: &[Value],
    collect: &[Value],
    forward: &[Value],
    endpoints: &[Value],
) -> Result<Vec<Value>> {
    let mut projected = sources(definitions, source)?;
    let requested = source_tables(definitions);
    if requested.is_empty() {
        return Ok(projected);
    }
    for point in &mut projected {
        point["endpoints"] = json!(endpoints);
        for (kind, key, mappings) in [
            ("collect", "collections", collect),
            ("forward", "transmissions", forward),
        ] {
            if !requested.contains(kind) {
                continue;
            }
            point[key] = json!(
                mappings
                    .iter()
                    .filter(|row| row["process_point_id"] == point["id"]
                        || row["process_enum"] == point["enum_name"]
                            && row["process_group"] == point["group_key"])
                    .map(|row| {
                        let mut row = row.clone();
                        row["protocol"] = endpoints
                            .iter()
                            .find(|endpoint| endpoint["code"] == row["endpoint_key"])
                            .map(|endpoint| endpoint["protocol"].clone())
                            .unwrap_or(Value::Null);
                        row
                    })
                    .collect::<Vec<_>>()
            );
        }
    }
    Ok(projected)
}
pub fn graph_sources(graph: &Value, board: &Value) -> Result<Vec<Value>> {
    let code = strv(board, "code");
    let points = rows(graph, "process_points")
        .iter()
        .filter(|row| row["board_key"] == code)
        .cloned()
        .collect::<Vec<_>>();
    let collect = rows(graph, "collect_points")
        .iter()
        .filter(|row| row["board_key"] == code)
        .cloned()
        .collect::<Vec<_>>();
    let forward = rows(graph, "transmit_points")
        .iter()
        .filter(|row| row["board_key"] == code)
        .cloned()
        .collect::<Vec<_>>();
    related_sources(
        &graph["table_definitions"][code],
        &points,
        &collect,
        &forward,
        rows(board, "point_endpoints"),
    )
}
/// Process projections may use other rows in the same board. Always project
/// the complete source table before selecting a linked row or mapping subset.
pub async fn all_sources(tx: &mut PgConnection, pid: i64, board: &Value) -> Result<Vec<Value>> {
    let points: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM points.process_points p WHERE project_id=$1 AND board_key=$2 ORDER BY p.id",
    )
    .bind(pid)
    .bind(strv(board, "code"))
    .fetch_all(&mut *tx)
    .await?;
    let requested = source_tables(&board["table_definitions"]);
    let collect: Vec<Value> = if requested.contains("collect") {
        sqlx::query_scalar("SELECT to_jsonb(c) FROM points.collect_points c WHERE project_id=$1 AND board_key=$2 ORDER BY c.id")
        .bind(pid).bind(strv(board, "code")).fetch_all(&mut *tx).await?
    } else {
        vec![]
    };
    let forward: Vec<Value> = if requested.contains("forward") {
        sqlx::query_scalar("SELECT to_jsonb(t) FROM points.transmit_points t WHERE project_id=$1 AND board_key=$2 ORDER BY t.id")
        .bind(pid).bind(strv(board, "code")).fetch_all(&mut *tx).await?
    } else {
        vec![]
    };
    related_sources(
        &board["table_definitions"],
        &points,
        &collect,
        &forward,
        rows(board, "point_endpoints"),
    )
}
pub async fn source(tx: &mut PgConnection, pid: i64, board: &Value, id: i64) -> Result<Value> {
    all_sources(tx, pid, board)
        .await?
        .into_iter()
        .find(|point| num(point, "id") == id)
        .ok_or_else(|| AppError::bad("映射必须关联当前板卡的处理点"))
}
/// Effective copies for protocol validation/generation; the persisted graph remains untouched.
pub fn effective(graph: &Value) -> Result<Value> {
    let mut result = graph.clone();
    for board in rows(&graph["project_config"], "board_types") {
        let code = strv(board, "code");
        let defs = &graph["table_definitions"][code];
        let source = graph_sources(graph, board)?;
        for (kind, entity) in [
            ("process", "process_points"),
            ("collect", "collect_points"),
            ("forward", "transmit_points"),
        ] {
            let mut projected: Vec<_> = rows(graph, entity)
                .iter()
                .filter(|p| p["board_key"] == code)
                .cloned()
                .collect();
            crate::table_behavior::project(
                &defs[kind],
                &mut projected,
                if kind == "process" { &[] } else { &source },
            )?;
            for original in result[entity]
                .as_array_mut()
                .into_iter()
                .flatten()
                .filter(|p| p["board_key"] == code)
            {
                if let Some(row) = projected.iter().find(|p| p["id"] == original["id"]) {
                    *original = row.clone();
                }
            }
        }
    }
    Ok(result)
}
pub fn issues(graph: &Value) -> Result<Vec<Value>> {
    let mut issues = vec![];
    for board in rows(&graph["project_config"], "board_types") {
        let code = strv(board, "code");
        let defs = &graph["table_definitions"][code];
        let source = graph_sources(graph, board)?;
        for (kind, entity) in [
            ("process", "process_points"),
            ("collect", "collect_points"),
            ("forward", "transmit_points"),
        ] {
            let data: Vec<_> = rows(graph, entity)
                .iter()
                .filter(|p| p["board_key"] == code)
                .cloned()
                .collect();
            let reported = crate::table_behavior::issues(&defs[kind], &data, &source, entity)?;
            let invalid = reported.iter().any(|issue| issue["level"] == "error");
            for mut issue in reported {
                issue["key"] = json!(format!(
                    "behavior:{code}:{}",
                    issue["key"].as_str().unwrap_or("")
                ));
                issue["board_key"] = json!(code);
                issues.push(issue);
            }
            if invalid {
                continue;
            }
            for (id, values) in crate::table_behavior::reconcile(&defs[kind], &data, &source)? {
                let original = data.iter().find(|row| num(row, "id") == id).unwrap();
                for (field, value) in values {
                    if !["name", "enabled", "conversion", "byte_order"].contains(&field.as_str())
                        && original[&field] != value
                    {
                        issues.push(json!({"key":format!("behavior:{code}:{entity}:{id}:stale:{field}"),"level":"error","entity":entity,"id":id,"name":original["name"],"board_key":code,"code":"behavior_stale","field":field,"message":"已保存数据与表规则不一致，请重算表规则并预览保存"}));
                    }
                }
            }
        }
    }
    Ok(issues)
}
/// Once per complete change, before layouts, permissions and history. No read path calls this.
pub async fn reconcile(tx: &mut PgConnection, pid: i64, board: &str) -> Result<()> {
    reconcile_kinds(
        tx,
        pid,
        board,
        &[
            ("process", "process_points"),
            ("collect", "collect_points"),
            ("forward", "transmit_points"),
        ],
    )
    .await
}

/// A source subset update only reruns the receiver's collection rules.
/// Do not recalculate unrelated internal points, transmit rows or their layout.
pub async fn reconcile_collect(tx: &mut PgConnection, pid: i64, board: &str) -> Result<()> {
    reconcile_kinds(tx, pid, board, &[("collect", "collect_points")]).await
}

async fn reconcile_kinds(
    tx: &mut PgConnection,
    pid: i64,
    board: &str,
    kinds: &[(&str, &str)],
) -> Result<()> {
    let defs = board_definitions(tx, pid, board).await?;
    let mut graph = crate::topology::snapshot(tx, pid, false).await?;
    for &(kind, entity) in kinds {
        let config = rows(&graph["project_config"], "board_types")
            .iter()
            .find(|item| item["code"] == board)
            .ok_or(AppError::bad("联动板卡不存在"))?;
        let source = graph_sources(&graph, config)?;
        let data: Vec<_> = rows(&graph, entity)
            .iter()
            .filter(|p| p["board_key"] == board)
            .cloned()
            .collect();
        for (id, values) in crate::table_behavior::reconcile(&defs[kind], &data, &source)? {
            check_updates(kind, &values)?;
            let Some(old) = data.iter().find(|p| num(p, "id") == id) else {
                return Err(AppError::bad("联动记录不存在"));
            };
            let changed: Map<_, _> = values.into_iter().filter(|(k, v)| old[k] != *v).collect();
            if changed.is_empty() {
                continue;
            }
            let columns = changed.keys().cloned().collect::<Vec<_>>();
            let assigned = columns.join(",");
            let selected = columns
                .iter()
                .map(|k| format!("x.{k}"))
                .collect::<Vec<_>>()
                .join(",");
            sqlx::query(&format!("UPDATE points.{entity} t SET ({assigned})=(SELECT {selected} FROM jsonb_populate_record(NULL::points.{entity},$4) x) WHERE project_id=$1 AND board_key=$2 AND id=$3"))
                .bind(pid).bind(board).bind(id).bind(json!(changed)).execute(&mut *tx).await?;
        }
        if kind == "process" {
            graph = crate::topology::snapshot(tx, pid, false).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_scripts_cannot_replace_physical_protocol_or_storage_fields() {
        for (kind, fields) in [
            (
                "process",
                vec![
                    "internal_type",
                    "byte_length",
                    "element_count",
                    "sig_id",
                    "min_value",
                ],
            ),
            (
                "collect",
                vec!["address", "wire_type", "wire_length", "upp_model", "scale"],
            ),
            (
                "forward",
                vec!["address", "wire_type", "wire_length", "upp_model", "scale"],
            ),
        ] {
            for field in fields {
                let definition = json!({"behavior":{"project_fields":[field],"owned_fields":[field]},"fields":{field:{"label":field}},"editor":[]});
                assert!(
                    validate_declarations(kind, &definition).is_err(),
                    "{kind}.{field}"
                );
            }
        }
        let compatibility = json!({"behavior":{"project_fields":["name","enabled","conversion","byte_order"],"owned_fields":["name","enabled","conversion","byte_order"]},"fields":{"name":{"label":"name"},"enabled":{"label":"enabled"},"conversion":{"label":"conversion"},"byte_order":{"label":"byte_order"}},"editor":[]});
        assert!(validate_declarations("forward", &compatibility).is_ok());
    }

    #[test]
    fn table_level_script_issues_are_scoped_to_their_board() {
        let definition = json!({"behavior":{"engine":"javascript","script_file":"rules.js","script":"export function behavior(ctx) { if(ctx.action === 'validate') return [{id:0,code:'incomplete',level:'error',message:'needs data'}]; return ctx.rows.map(row=>({id:row.id,values:{}})); }","parameters":{}}});
        let graph = json!({"project_config":{"board_types":[{"code":"ALPHA"},{"code":"BETA"}]},"table_definitions":{"ALPHA":{"process":definition},"BETA":{"process":definition}},"process_points":[],"collect_points":[],"transmit_points":[]});
        let found = issues(&graph).unwrap();
        assert_eq!(found.len(), 2);
        assert_ne!(found[0]["key"], found[1]["key"]);
        assert_eq!(found[0]["board_key"], "ALPHA");
        assert_eq!(found[1]["board_key"], "BETA");
    }
}
