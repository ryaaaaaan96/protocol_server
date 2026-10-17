//! Business point tables: presentation is configured independently of storage.
use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
    topology::{self, Change},
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeSet;

const PROCESS: &str = "group_id,data_item_id,name,enum_name,sig_id,sig_symbol,internal_type,flags,callback,process_enabled";
const RANGE: &str = "default_value,min_value,max_value,boot_restore,manual_restore";
const BINDING: &str = "endpoint_id,context_id,field_id,signal_id";
const COLLECTION: &str = "poll_interval,set_priority,scan_priority";

pub fn entity(kind: &str) -> Result<&'static str> {
    match kind {
        "process" => Ok("process_points"),
        "collect" => Ok("collect_points"),
        "forward" => Ok("forward_points"),
        _ => Err(AppError::not_found()),
    }
}
pub fn is_point_entity(entity: &str) -> bool {
    matches!(
        entity,
        "process_points" | "collect_points" | "forward_points"
    )
}
fn keys(csv: &str) -> BTreeSet<&str> {
    csv.split(',').collect()
}
pub(crate) fn writable(kind: &str) -> BTreeSet<&str> {
    match kind {
        "process" => keys(PROCESS).union(&keys(RANGE)).copied().collect(),
        "collect" => keys(BINDING).union(&keys(COLLECTION)).copied().collect(),
        _ => keys(BINDING),
    }
}
fn readable(kind: &str) -> BTreeSet<&str> {
    let common = keys("id,model_id,unit,data_type,byte_length,resolved_sig_id,enum_name");
    let extra = if kind == "process" {
        keys("group_name,contexts,collection_count,forward_count,range_inherited")
    } else {
        keys(
            "signal_name,field_name,context_name,dev_id,endpoint_name,protocol,transport,port,upp_model,effective_address,address_length,effective_type,effective_length,register_type,access,scale,byte_order,default_value,min_value,max_value",
        )
    };
    writable(kind)
        .union(&common)
        .copied()
        .collect::<BTreeSet<_>>()
        .union(&extra)
        .copied()
        .collect()
}
pub fn validate_definition(v: &Value) -> Result<()> {
    if v["version"] != 1 {
        return Err(AppError::bad("点表展示配置 version 必须为 1"));
    }
    if let Some(workspace) = v.get("workspace") {
        let object = workspace
            .as_object()
            .ok_or(AppError::bad("workspace 必须为对象"))?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "default_tables" | "boards"))
        {
            return Err(AppError::bad("workspace 只支持 default_tables 和 boards"));
        }
        validate_workspace_tables(&workspace["default_tables"], "workspace.default_tables")?;
        if let Some(boards) = workspace.get("boards") {
            let boards = boards
                .as_object()
                .ok_or(AppError::bad("workspace.boards 必须为对象"))?;
            for (code, board) in boards {
                if code.trim().is_empty() || code.trim() != code {
                    return Err(AppError::bad(
                        "workspace.boards 的板卡类型代码不能为空或包含首尾空格",
                    ));
                }
                let path = format!("workspace.boards.{code}");
                let object = board
                    .as_object()
                    .ok_or(AppError::bad(format!("{path} 必须为对象")))?;
                if object
                    .keys()
                    .any(|key| !matches!(key.as_str(), "tables" | "labels" | "rules"))
                {
                    return Err(AppError::bad(format!(
                        "{path} 只支持 tables、labels 和 rules"
                    )));
                }
                validate_workspace_tables(&board["tables"], &format!("{path}.tables"))?;
                if let Some(labels) = board.get("labels") {
                    let labels = labels
                        .as_object()
                        .ok_or(AppError::bad(format!("{path}.labels 必须为对象")))?;
                    validate_workspace_tables(
                        &json!(labels.keys().collect::<Vec<_>>()),
                        &format!("{path}.labels"),
                    )?;
                    if labels
                        .values()
                        .any(|label| label.as_str().is_none_or(|s| s.trim().is_empty()))
                    {
                        return Err(AppError::bad(format!(
                            "{path}.labels 的标题必须为非空字符串"
                        )));
                    }
                }
                if let Some(rules) = board.get("rules") {
                    let rules = rules
                        .as_object()
                        .ok_or(AppError::bad("板卡 rules 必须为对象"))?;
                    for (kind, patch) in rules {
                        entity(kind)?;
                        let patch = patch
                            .as_object()
                            .ok_or(AppError::bad("单表规则必须为对象"))?;
                        if patch
                            .keys()
                            .any(|k| !matches!(k.as_str(), "ordering" | "inline"))
                        {
                            return Err(AppError::bad("单表规则只支持 ordering 和 inline"));
                        }
                        let mut table = v["tables"][kind].clone();
                        crate::project_files::merge(&mut table, &json!(patch));
                        validate_interaction(kind, &table)?;
                    }
                }
            }
        }
    }
    let fields = v["fields"]
        .as_object()
        .ok_or(AppError::bad("点表配置缺少字段目录 fields"))?;
    for (key, field) in fields {
        if !["process", "collect", "forward"]
            .iter()
            .any(|kind| readable(kind).contains(key.as_str()))
            || field["label"].as_str().is_none_or(|s| s.is_empty())
        {
            return Err(AppError::bad(format!("未知字段或无标题字段：{key}")));
        }
    }
    for kind in ["process", "collect", "forward"] {
        let table = &v["tables"][kind];
        validate_interaction(kind, table)?;
        if table["label"].as_str().is_none_or(|s| s.is_empty()) {
            return Err(AppError::bad(format!("{kind} 缺少标题")));
        }
        for section in ["columns", "editor"] {
            let items = table[section]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or(AppError::bad("点表 columns/editor 不能为空"))?;
            let mut seen = BTreeSet::new();
            for item in items {
                let key = item.as_str().ok_or(AppError::bad("点表列必须为字段标识"))?;
                if !fields.contains_key(key)
                    || !seen.insert(key)
                    || !readable(kind).contains(key)
                    || (section == "editor" && !writable(kind).contains(key))
                {
                    return Err(AppError::bad(format!(
                        "{kind}.{section} 的字段不存在、重复或不可编辑：{key}"
                    )));
                }
            }
        }
    }
    Ok(())
}
fn validate_interaction(kind: &str, table: &Value) -> Result<()> {
    if let Some(ordering) = table.get("ordering") {
        crate::point_order::validate_rule(kind, ordering)?;
    }
    if let Some(inline) = table.get("inline") {
        let inline = inline
            .as_object()
            .ok_or(AppError::bad("inline 必须为列与编辑字段的映射"))?;
        for (column, field) in inline {
            let Some(field) = field.as_str() else {
                return Err(AppError::bad("inline 编辑字段必须为字符串"));
            };
            let alias = match column.as_str() {
                "group_name" => "group_id",
                "resolved_sig_id" => "sig_id",
                "data_type" => "internal_type",
                "signal_name" => "signal_id",
                "context_name" => "context_id",
                "endpoint_name" => "endpoint_id",
                "field_name" => "field_id",
                _ => column.as_str(),
            };
            if alias != field
                || !readable(kind).contains(column.as_str())
                || !writable(kind).contains(field)
                || !table["editor"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!(field)))
            {
                return Err(AppError::bad(format!(
                    "{kind}.inline 不支持 {column} → {field}"
                )));
            }
        }
    }
    Ok(())
}
fn validate_workspace_tables(value: &Value, path: &str) -> Result<()> {
    let tables = value
        .as_array()
        .ok_or(AppError::bad(format!("{path} 必须为表格标识数组")))?;
    let allowed = keys(
        "process,collect,forward,fields,data,routes,expansion,links,endpoints,contexts,groups",
    );
    let mut seen = BTreeSet::new();
    for table in tables {
        let key = table
            .as_str()
            .ok_or(AppError::bad(format!("{path} 表格标识必须为字符串")))?;
        if key == "ranges" {
            return Err(AppError::bad(format!(
                "{path}：ranges 已合并到 process，请移除 ranges 并通过 process 维护范围和恢复策略"
            )));
        }
        if !allowed.contains(key) || !seen.insert(key) {
            return Err(AppError::bad(format!("{path} 的表格不存在或重复：{key}")));
        }
    }
    Ok(())
}
fn definition(config: &Value, kind: &str, code: &str) -> Value {
    let mut result = config["tables"][kind].clone();
    if let Some(patch) = config["workspace"]["boards"][code]["rules"].get(kind) {
        crate::project_files::merge(&mut result, patch);
    }
    if let Some(label) = config["workspace"]["boards"][code]["labels"].get(kind) {
        result["label"] = label.clone();
    }
    if result.get("ordering").is_none() {
        result["ordering"] = json!({"mode":"disabled","group_by":[]});
    }
    if result.get("inline").is_none() {
        result["inline"] = json!({});
    }
    let allowed = readable(kind);
    result["fields"] = Value::Object(
        config["fields"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| allowed.contains(key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    );
    result
}
pub(crate) async fn board_definition(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    mid: i64,
    kind: &str,
    files: &crate::project_files::ProjectFiles,
) -> Result<Value> {
    entity(kind)?;
    let model = board(tx, pid, mid).await?;
    let (key, topology): (Option<String>, Option<Value>) =
        sqlx::query_as("SELECT config_key,topology_config FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut **tx)
            .await?;
    let code = topology
        .as_ref()
        .and_then(|v| v["board_types"].as_array())
        .and_then(|types| types.iter().find(|t| t["model_code"] == model["code"]))
        .and_then(|t| t["code"].as_str())
        .unwrap_or(model["code"].as_str().unwrap_or(""));
    Ok(definition(files.definition(key.as_deref()), kind, code))
}
pub fn load_definition() -> anyhow::Result<Value> {
    let path =
        std::env::var("POINT_TABLE_CONFIG").unwrap_or_else(|_| "config/point-tables.json".into());
    let config: Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("读取点表展示配置 {path} 失败：{e}"))?,
    )?;
    validate_definition(&config).map_err(|e| anyhow::anyhow!("{}: {}", path, e.1))?;
    Ok(config)
}
pub async fn schema(State(s): State<AppState>, _u: User) -> Json<Value> {
    Json(s.project_files.definition(None).clone())
}
pub async fn project_schema(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let key: Option<String> = sqlx::query_scalar("SELECT config_key FROM projects WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    Ok(Json(s.project_files.definition(key.as_deref()).clone()))
}
async fn board(tx: &mut Transaction<'_, Postgres>, pid: i64, mid: i64) -> Result<Value> {
    Ok(
        sqlx::query_scalar("SELECT to_jsonb(m) FROM board_models m WHERE project_id=$1 AND id=$2")
            .bind(pid)
            .bind(mid)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(AppError::not_found())?,
    )
}
pub async fn read(
    State(s): State<AppState>,
    u: User,
    Path((pid, mid, kind)): Path<(i64, i64, String)>,
) -> Result<Json<Value>> {
    entity(&kind)?;
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    // Repeatable-read also works for viewers, unlike row locks under UPDATE RLS.
    let revision: i32 = sqlx::query_scalar("SELECT revision FROM projects WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    board(&mut tx, pid, mid).await?;
    let definition = board_definition(&mut tx, pid, mid, &kind, &s.project_files).await?;
    let mut data = table_rows(&mut tx, pid, mid, &kind).await?;
    crate::point_order::sort_rows(&mut data, &definition["ordering"]);
    let mut options = json!({});
    for (key, sql) in [
        (
            "groups",
            "SELECT to_jsonb(t) FROM signal_groups t WHERE project_id=$1 AND model_id=$2 ORDER BY id",
        ),
        (
            "contexts",
            "SELECT to_jsonb(t) FROM device_contexts t WHERE project_id=$1 AND model_id=$2 ORDER BY id",
        ),
        (
            "endpoints",
            "SELECT to_jsonb(t) FROM endpoints t WHERE project_id=$1 AND model_id=$2 ORDER BY id",
        ),
        (
            "signals",
            "SELECT jsonb_build_object('id',id,'name',name,'group_id',group_id,'sig_id',resolved_sig_id) FROM v_signals WHERE project_id=$1 AND model_id=$2 ORDER BY id",
        ),
        (
            "fields",
            "SELECT to_jsonb(f) FROM v_protocol_fields f WHERE project_id=$1 AND contract_id IN (SELECT contract_id FROM endpoints WHERE project_id=$1 AND model_id=$2) ORDER BY id",
        ),
    ] {
        let values: Vec<Value> = sqlx::query_scalar(sql)
            .bind(pid)
            .bind(mid)
            .fetch_all(&mut *tx)
            .await?;
        options[key] = json!(values);
    }
    // Definitions may be shared with another board; offer names/types, never source workbook blobs.
    options["data"] = json!(db::all_json(&mut tx,
        "SELECT jsonb_build_object('id',id,'name',name,'data_type',data_type,'byte_length',byte_length,'default_value',default_value,'min_value',min_value,'max_value',max_value) FROM data_items WHERE project_id=$1 ORDER BY id", pid).await?);
    Ok(Json(
        json!({"version":1,"revision":revision,"model_id":mid,"kind":kind,
        "definition":definition,"rows":data,"options":options}),
    ))
}

pub(crate) async fn table_rows(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    mid: i64,
    kind: &str,
) -> Result<Vec<Value>> {
    let data: Vec<Value> = if kind == "process" {
        sqlx::query_scalar(r#"
            SELECT to_jsonb(v) || jsonb_build_object(
                'display_order',s.display_order, 'contexts', COALESCE(c.names,''),
                'collection_count', COALESCE(b.collected,0), 'forward_count', COALESCE(b.forwarded,0),
                'range_inherited', concat_ws('、', CASE WHEN r.default_value IS NULL THEN '默认值' END,
                    CASE WHEN r.min_value IS NULL THEN '下限' END, CASE WHEN r.max_value IS NULL THEN '上限' END),
                'edit_values', to_jsonb(s) || COALESCE(to_jsonb(r)-'id'-'project_id'-'signal_id','{}'::jsonb))
            FROM v_signals v JOIN signals s ON s.id=v.id
            LEFT JOIN signal_ranges r ON r.signal_id=v.id
            LEFT JOIN (SELECT sb.signal_id, count(*) FILTER(WHERE e.role='client') collected,
                count(*) FILTER(WHERE e.role='server') forwarded
                FROM signal_bindings sb JOIN endpoints e ON e.id=sb.endpoint_id
                WHERE sb.project_id=$1 AND e.model_id=$2 GROUP BY sb.signal_id) b ON b.signal_id=v.id
            LEFT JOIN (SELECT group_id, string_agg(name || ' [' || dev_id || ']', '、' ORDER BY dev_id) names
                FROM device_contexts WHERE project_id=$1 AND model_id=$2 GROUP BY group_id) c ON c.group_id=v.group_id
            WHERE v.project_id=$1 AND v.model_id=$2 ORDER BY v.id
        "#).bind(pid).bind(mid).fetch_all(&mut **tx).await?
    } else {
        sqlx::query_scalar(
            r#"
            SELECT to_jsonb(b) || jsonb_build_object('enum_name',s.enum_name,'unit',s.unit,
                'display_order',raw.display_order,'field_ordinal',f.ordinal,'bank',CASE WHEN b.protocol='UPP' THEN 0 ELSE b.register_type END,'default_value',s.default_value,'min_value',s.min_value,'max_value',s.max_value,
                'edit_values',to_jsonb(raw))
            FROM v_bindings b JOIN v_signals s ON s.id=b.signal_id
            JOIN signal_bindings raw ON raw.id=b.id JOIN protocol_fields f ON f.id=b.field_id
            WHERE b.project_id=$1 AND b.model_id=$2 AND b.role=$3 ORDER BY b.id
        "#,
        )
        .bind(pid)
        .bind(mid)
        .bind(if kind == "collect" {
            "client"
        } else {
            "server"
        })
        .fetch_all(&mut **tx)
        .await?
    };
    Ok(data)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointChange {
    revision: i32,
    operation: String,
    id: Option<i64>,
    #[serde(default)]
    values: Value,
    #[serde(default)]
    expected: Value,
}
pub async fn preview(
    State(s): State<AppState>,
    u: User,
    Path((pid, mid, kind)): Path<(i64, i64, String)>,
    Json(c): Json<PointChange>,
) -> Result<Json<Value>> {
    let c = Change {
        revision: c.revision,
        entity: entity(&kind)?.into(),
        operation: c.operation,
        id: c.id,
        values: json!({"model_id":mid,"fields":c.values}),
        expected: c.expected,
    };
    topology::preview(State(s), u, Path(pid), Json(c)).await
}
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    table: &str,
    id: Option<i64>,
) -> Result<Value> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT to_jsonb(t) FROM {table} t WHERE project_id=$1 AND id=$2"
    ))
    .bind(pid)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(AppError::not_found())?)
}
fn subset(v: &Value, allowed: &str) -> Value {
    let allowed = keys(allowed);
    Value::Object(
        v.as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| allowed.contains(k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}
async fn write(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    c: &Change,
    entity: &str,
    id: Option<i64>,
    values: Value,
    operation: &str,
) -> Result<Value> {
    topology::apply(
        tx,
        pid,
        &Change {
            entity: entity.into(),
            id,
            values,
            operation: operation.into(),
            revision: c.revision,
            expected: Value::Null,
        },
    )
    .await
}
pub async fn apply(tx: &mut Transaction<'_, Postgres>, pid: i64, c: &Change) -> Result<Value> {
    let kind = match c.entity.as_str() {
        "process_points" => "process",
        "collect_points" => "collect",
        _ => "forward",
    };
    let mid = c.values["model_id"]
        .as_i64()
        .ok_or(AppError::bad("缺少板卡类型"))?;
    board(tx, pid, mid).await?;
    let values = &c.values["fields"];
    let fields = values
        .as_object()
        .ok_or(AppError::bad("点表字段必须为对象"))?;
    if !["create", "update", "delete"].contains(&c.operation.as_str()) {
        return Err(AppError::bad("点表操作无效"));
    }
    if c.operation != "delete" && fields.is_empty() {
        return Err(AppError::bad("未提供修改字段"));
    }
    for key in fields.keys() {
        if !writable(kind).contains(key.as_str()) {
            return Err(AppError::bad(format!("{key} 是只读字段或不属于当前点表")));
        }
    }
    let table = if kind == "process" {
        "signals"
    } else {
        "signal_bindings"
    };
    let old = if c.operation == "create" {
        json!({})
    } else {
        record(tx, pid, table, c.id).await?
    };
    // Validate the old owner as well as the new owner: a foreign ID cannot be moved into this board.
    if c.operation != "create" {
        let parent = record(
            tx,
            pid,
            if kind == "process" {
                "signal_groups"
            } else {
                "endpoints"
            },
            old[if kind == "process" {
                "group_id"
            } else {
                "endpoint_id"
            }]
            .as_i64(),
        )
        .await?;
        if parent["model_id"] != mid
            || (kind != "process"
                && parent["role"]
                    != if kind == "collect" {
                        "client"
                    } else {
                        "server"
                    })
        {
            return Err(AppError::bad("记录不属于当前板卡或点表"));
        }
    }
    if c.operation == "delete" {
        if kind == "process" {
            // Both removals live in the same preview/commit transaction. Bindings still restrict deletion.
            sqlx::query("DELETE FROM signal_ranges WHERE project_id=$1 AND signal_id=$2")
                .bind(pid)
                .bind(c.id)
                .execute(&mut **tx)
                .await?;
        }
        return write(tx, pid, c, table, c.id, json!({}), "delete").await;
    }
    let mut merged = old.clone();
    merged.as_object_mut().unwrap().extend(fields.clone());
    if kind == "process" {
        let group = record(tx, pid, "signal_groups", merged["group_id"].as_i64()).await?;
        if group["model_id"] != mid {
            return Err(AppError::bad("信号组不属于当前板卡"));
        }
        let signal_values = subset(values, PROCESS);
        let signal = if c.operation == "update" && signal_values.as_object().unwrap().is_empty() {
            old
        } else {
            write(tx, pid, c, "signals", c.id, signal_values, &c.operation).await?
        };
        let sid = signal["id"].as_i64().unwrap();
        let mut range_values = subset(values, RANGE);
        if !range_values.as_object().unwrap().is_empty() {
            let rid: Option<i64> = sqlx::query_scalar(
                "SELECT id FROM signal_ranges WHERE project_id=$1 AND signal_id=$2",
            )
            .bind(pid)
            .bind(sid)
            .fetch_optional(&mut **tx)
            .await?;
            if rid.is_none() {
                range_values["signal_id"] = json!(sid);
            }
            write(
                tx,
                pid,
                c,
                "signal_ranges",
                rid,
                range_values,
                if rid.is_some() { "update" } else { "create" },
            )
            .await?;
        }
        let range: Option<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(r) FROM signal_ranges r WHERE project_id=$1 AND signal_id=$2",
        )
        .bind(pid)
        .bind(sid)
        .fetch_optional(&mut **tx)
        .await?;
        let mut result = signal;
        result["range"] = json!(range);
        Ok(result)
    } else {
        let endpoint = record(tx, pid, "endpoints", merged["endpoint_id"].as_i64()).await?;
        let context = record(tx, pid, "device_contexts", merged["context_id"].as_i64()).await?;
        let signal = record(tx, pid, "signals", merged["signal_id"].as_i64()).await?;
        let field = record(tx, pid, "protocol_fields", merged["field_id"].as_i64()).await?;
        if endpoint["model_id"] != mid
            || context["model_id"] != mid
            || endpoint["role"]
                != if kind == "collect" {
                    "client"
                } else {
                    "server"
                }
            || context["group_id"].is_null()
            || context["group_id"] != signal["group_id"]
            || endpoint["contract_id"] != field["contract_id"]
        {
            return Err(AppError::bad(
                "端点、逻辑设备、处理点与协议字段的关联不匹配",
            ));
        }
        write(
            tx,
            pid,
            c,
            "signal_bindings",
            c.id,
            values.clone(),
            &c.operation,
        )
        .await
    }
}
pub fn audit_before(g: &Value, entity: &str, id: i64) -> Option<Value> {
    if entity == "process_points" {
        let mut signal = topology::find(g, "signals", id)?.clone();
        signal["range"] = topology::rows(g, "signal_ranges")
            .iter()
            .find(|r| r["signal_id"] == id)
            .cloned()
            .unwrap_or(Value::Null);
        Some(signal)
    } else {
        topology::find(g, "signal_bindings", id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_workspace_visibility() {
        let mut base: Value =
            serde_json::from_str(include_str!("../config/point-tables.json")).unwrap();
        for workspace in [
            json!({"default_tables": ["forward", "process"], "boards": {"DSP": {"tables": ["process", "fields"], "labels": {"process": "DSP内部数据"}}, "CSU": {"tables": []}}}),
            json!({"default_tables": []}),
        ] {
            base["workspace"] = workspace;
            validate_definition(&base).unwrap();
        }
        for workspace in [
            json!(null),
            json!({"default_tables": ["process", "process"]}),
            json!({"default_tables": ["unknown"]}),
            json!({"default_tables": ["ranges"]}),
            json!({"default_tables": [1]}),
            json!({"default_tables": "process"}),
            json!({"default_tables": [], "boards": []}),
            json!({"default_tables": [], "boards": {"DSP": {"tables": ["forward", "forward"]}}}),
            json!({"default_tables": [], "boards": {"DSP": {"tables": ["unknown"]}}}),
            json!({"default_tables": [], "boards": {"DSP": {"tables": [], "labels": {"process": " "}}}}),
            json!({"default_tables": [], "boards": {"DSP": {"tables": [], "labels": {"process": 1}}}}),
            json!({"default_tables": [], "boards": {"DSP": {"tables": [], "labels": {"unknown": "标题"}}}}),
            json!({"default_tables": [], "boards": {"DSP": {"tables": [], "labels": []}}}),
            json!({"default_tables": [], "boards": {"DSP": {"table": []}}}),
            json!({"default_tables": [], "boards": {"DSP": []}}),
            json!({"default_tables": [], "boards": {" DSP ": {"tables": []}}}),
            json!({"default_tables": [], "board": {"DSP": {"tables": []}}}),
            json!({"boards": {"DSP": {"tables": []}}}),
        ] {
            base["workspace"] = workspace;
            assert!(validate_definition(&base).is_err(), "{}", base["workspace"]);
        }
        base.as_object_mut().unwrap().remove("workspace");
        validate_definition(&base).unwrap();
    }

    #[test]
    fn validates_business_configuration() {
        let base: Value =
            serde_json::from_str(include_str!("../config/point-tables.json")).unwrap();
        validate_definition(&base).unwrap();
        for key in ["project_id", "raw_json", "not_a_field"] {
            let mut v = base.clone();
            v["fields"][key] = json!({"label":"bad"});
            assert!(validate_definition(&v).is_err());
        }
        let mut v = base.clone();
        v["tables"]["process"]["editor"]
            .as_array_mut()
            .unwrap()
            .push(json!("collection_count"));
        assert!(validate_definition(&v).is_err());
        assert!(entity("unknown").is_err());
    }
}
