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
use sqlx::PgConnection;
use std::collections::BTreeSet;

// Inactive board definitions may retain descriptive fields for future tables.
// Runtime writes use the native whitelist below and never these former relations.
const PROCESS: &str = "group_id,data_item_id,name,enum_name,sig_id,sig_symbol,internal_type,flags,callback,process_enabled";
const RANGE: &str = "default_value,min_value,max_value,boot_restore,manual_restore";
const BINDING: &str = "endpoint_id,context_id,field_id,signal_id";
const COLLECTION: &str = "poll_interval,set_priority,scan_priority";
const NATIVE_PROCESS: &str = "group_key,element_count,byte_length,unit,notes";
const NATIVE_FORWARD: &str = "process_point_id,endpoint_key,name,upp_model,address,wire_type,wire_length,scale,access,byte_order,conversion,enabled,register_type";
pub(crate) const NATIVE_COLLECT: &str = "process_point_id,endpoint_key,upp_model,address,wire_type,wire_length,scale,access,byte_order,acquisition_mode,poll_interval,set_priority,scan_priority";

pub fn entity(kind: &str) -> Result<&'static str> {
    match kind {
        "process" => Ok("process_points"),
        "collect" => Ok("collect_points"),
        "forward" => Ok("transmit_points"),
        _ => Err(AppError::not_found()),
    }
}
pub fn is_point_entity(entity: &str) -> bool {
    matches!(
        entity,
        "process_points" | "transmit_points" | "collect_points"
    )
}
fn keys(csv: &str) -> BTreeSet<&str> {
    csv.split(',').collect()
}
fn schema_writable(kind: &str) -> BTreeSet<&str> {
    match kind {
        "process" => keys(PROCESS)
            .union(&keys(crate::dsp_sheet::EDIT_FIELDS))
            .copied()
            .collect::<BTreeSet<_>>()
            .union(&keys(RANGE))
            .copied()
            .collect::<BTreeSet<_>>()
            .union(&keys(NATIVE_PROCESS))
            .copied()
            .collect(),
        "collect" => keys(BINDING)
            .union(&keys(COLLECTION))
            .copied()
            .collect::<BTreeSet<_>>()
            .union(&keys(NATIVE_COLLECT))
            .copied()
            .collect(),
        _ => keys(BINDING)
            .union(&keys(NATIVE_FORWARD))
            .copied()
            .collect(),
    }
}
pub(crate) fn writable(kind: &str) -> BTreeSet<&str> {
    match kind {
        "process" => keys("name,enum_name,sig_id,internal_type,flags,callback,process_enabled")
            .union(&keys(crate::dsp_sheet::EDIT_FIELDS))
            .copied()
            .collect::<BTreeSet<_>>()
            .union(&keys(RANGE))
            .copied()
            .collect::<BTreeSet<_>>()
            .union(&keys(NATIVE_PROCESS))
            .copied()
            .collect(),
        "forward" => keys(NATIVE_FORWARD),
        "collect" => keys(NATIVE_COLLECT),
        _ => BTreeSet::new(),
    }
}
fn readable(kind: &str) -> BTreeSet<&str> {
    let common = keys(
        "id,board_key,unit,data_type,byte_length,resolved_sig_id,enum_name,group_key,group_name,metadata,device_addresses,source_variable,source_sig_id,source_notes,register_count",
    );
    let extra = if kind == "process" {
        keys("group_name,contexts,collection_count,forward_count,range_inherited")
            .union(&keys(crate::dsp_sheet::READ_FIELDS))
            .copied()
            .collect()
    } else {
        keys(
            "signal_name,field_name,context_name,dev_id,endpoint_name,protocol,transport,port,upp_model,effective_address,address_length,effective_type,effective_length,register_type,access,scale,byte_order,default_value,min_value,max_value",
        )
        .union(&keys(crate::dsp_sheet::FORWARD_READ_FIELDS))
        .copied()
        .collect()
    };
    schema_writable(kind)
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
    let boards = v["boards"]
        .as_object()
        .filter(|boards| !boards.is_empty())
        .ok_or(AppError::bad("项目缺少板卡点表定义 boards"))?;
    let workspace = v["workspace"]
        .as_object()
        .ok_or(AppError::bad("项目缺少 workspace"))?;
    if workspace.keys().any(|key| key != "boards") {
        return Err(AppError::bad("workspace 只支持 boards，不支持公共默认配置"));
    }
    let views = workspace["boards"]
        .as_object()
        .ok_or(AppError::bad("workspace.boards 必须为对象"))?;
    if boards.keys().ne(views.keys()) {
        return Err(AppError::bad(
            "板卡点表定义与 workspace.boards 必须一一对应",
        ));
    }
    for (code, definitions) in boards {
        let definitions = definitions
            .as_object()
            .ok_or(AppError::bad(format!("{code} 的点表定义必须为对象")))?;
        if code.trim().is_empty() || code.trim() != code || definitions.len() != 3 {
            return Err(AppError::bad(format!("{code} 必须完整配置三类点表")));
        }
        for kind in ["process", "collect", "forward"] {
            validate_table_file(kind, &definitions.get(kind).cloned().unwrap_or(Value::Null))
                .map_err(|e| AppError::bad(format!("{code}.{kind}: {}", e.1)))?;
        }
        let path = format!("workspace.boards.{code}");
        let board = views[code]
            .as_object()
            .ok_or(AppError::bad(format!("{path} 必须为对象")))?;
        if board
            .keys()
            .any(|key| !matches!(key.as_str(), "tables" | "labels"))
        {
            return Err(AppError::bad(format!("{path} 只支持 tables 和 labels")));
        }
        validate_workspace_tables(
            &board.get("tables").cloned().unwrap_or(Value::Null),
            &format!("{path}.tables"),
        )?;
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
    }
    Ok(())
}

/// Each project owns complete table definitions; no inherited field metadata.
pub(crate) fn validate_table_file(kind: &str, table: &Value) -> Result<()> {
    if !["process", "collect", "forward"].contains(&kind) {
        return Err(AppError::not_found());
    }
    let object = table
        .as_object()
        .ok_or(AppError::bad("单表配置必须为对象"))?;
    let required = [
        "label",
        "description",
        "columns",
        "editor",
        "ordering",
        "inline",
        "fields",
    ];
    if object
        .keys()
        .any(|key| !required.contains(&key.as_str()) && key != "calculation")
        || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(AppError::bad(
            "单表配置须完整包含 label、description、columns、editor、ordering、inline、fields",
        ));
    }
    if let Some(rule) = table.get("calculation") {
        if kind != "forward" {
            return Err(AppError::bad("当前仅转发表支持 calculation"));
        }
        crate::table_calculation::validate(rule)?;
        if table["editor"].as_array().is_some_and(|fields| {
            fields
                .iter()
                .any(|field| field == "address" || field == "wire_length")
        }) {
            return Err(AppError::bad(
                "脚本计算的 address 和 wire_length 不能同时配置为编辑字段",
            ));
        }
    }
    let fields = table["fields"]
        .as_object()
        .ok_or(AppError::bad("单表配置缺少 fields"))?;
    validate_fields(fields, Some(kind))?;
    validate_table(kind, table, fields)
}

fn validate_fields(fields: &serde_json::Map<String, Value>, kind: Option<&str>) -> Result<()> {
    for (key, field) in fields {
        let allowed = kind.map_or_else(
            || {
                ["process", "collect", "forward"]
                    .iter()
                    .any(|kind| readable(kind).contains(key.as_str()))
            },
            |kind| readable(kind).contains(key.as_str()),
        );
        if !allowed
            || !field.is_object()
            || field["label"].as_str().is_none_or(|s| s.trim().is_empty())
        {
            return Err(AppError::bad(format!("未知字段或无标题字段：{key}")));
        }
    }
    Ok(())
}

fn validate_table(
    kind: &str,
    table: &Value,
    fields: &serde_json::Map<String, Value>,
) -> Result<()> {
    validate_interaction(kind, table)?;
    if table["label"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err(AppError::bad(format!("{kind} 缺少标题")));
    }
    if table
        .get("description")
        .is_some_and(|value| !value.is_string())
    {
        return Err(AppError::bad(format!("{kind}.description 必须为字符串")));
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
                || (section == "editor" && !schema_writable(kind).contains(key))
            {
                return Err(AppError::bad(format!(
                    "{kind}.{section} 的字段不存在、重复或不可编辑：{key}"
                )));
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
            let native_alias = matches!(
                (column.as_str(), field),
                ("group_name", "group_key")
                    | ("signal_name", "process_point_id")
                    | ("field_name", "name")
                    | ("endpoint_name", "endpoint_key")
                    | ("effective_address", "address")
                    | ("effective_type", "wire_type")
                    | ("effective_length", "wire_length")
            );
            if (alias != field && !native_alias)
                || !readable(kind).contains(column.as_str())
                || !schema_writable(kind).contains(field)
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
fn definition(config: &Value, kind: &str, code: &str) -> Result<Value> {
    config["boards"][code].get(kind).cloned().ok_or_else(|| {
        AppError::bad(format!(
            "项目未配置板卡 {code} 的 {kind} 点表，请检查项目目录"
        ))
    })
}
pub(crate) async fn board_definition(
    tx: &mut PgConnection,
    pid: i64,
    board_key: &str,
    kind: &str,
    files: &crate::project_files::ProjectFiles,
) -> Result<Value> {
    entity(kind)?;
    board(tx, pid, board_key).await?;
    let key: Option<String> =
        sqlx::query_scalar("SELECT config_key FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    let config = files
        .definition(key.as_deref())
        .map_err(|e| AppError::bad(e.to_string()))?;
    definition(&config, kind, board_key)
}
pub async fn project_schema(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let key: Option<String> =
        sqlx::query_scalar("SELECT config_key FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    Ok(Json(
        s.project_files
            .definition(key.as_deref())
            .map_err(|e| AppError::bad(e.to_string()))?
            .clone(),
    ))
}
async fn board(tx: &mut PgConnection, pid: i64, board_key: &str) -> Result<Value> {
    crate::dsp_points::native_board(tx, pid, board_key)
        .await?
        .ok_or(AppError::bad("此板卡尚未启用点表存储"))
}
pub async fn read(
    State(s): State<AppState>,
    u: User,
    Path((pid, board_key, kind)): Path<(i64, String, String)>,
) -> Result<Json<Value>> {
    if kind != "overview" {
        entity(&kind)?;
    }
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let revision: i32 = sqlx::query_scalar("SELECT revision FROM meta.project_state WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    let board = board(&mut tx, pid, &board_key).await?;
    if kind == "collect"
        && !board["point_endpoints"]
            .as_array()
            .is_some_and(|endpoints| {
                endpoints
                    .iter()
                    .any(|endpoint| endpoint["direction"] == "collect")
            })
    {
        return Err(AppError::bad("此板卡尚未启用采集点表"));
    }
    let options = json!({
        "native_groups": board["point_groups"],
        "endpoints": board["point_endpoints"].as_array().into_iter().flatten().filter(|endpoint|
            if kind == "collect" {endpoint["direction"] == "collect"} else {endpoint["direction"] != "collect"}).collect::<Vec<_>>(),
        "process_points": table_rows(&mut tx, pid, &board_key, "process").await?,
    });
    let graph = crate::permissions::catalog(&mut tx, pid).await?;
    let access = crate::permissions::load(&mut tx, pid).await?;
    let kinds = if kind == "overview" {
        vec!["process", "forward"]
    } else {
        vec![kind.as_str()]
    };
    let mut result = json!({"revision":revision});
    // Both sides of the joined view share a single repeatable-read snapshot.
    for table_kind in kinds {
        let definition =
            board_definition(&mut tx, pid, &board_key, table_kind, &s.project_files).await?;
        let mut data = table_rows(&mut tx, pid, &board_key, table_kind).await?;
        crate::point_order::sort_rows(&mut data, &definition["ordering"]);
        for row in &mut data {
            row["can_edit"] = json!(crate::permissions::can_edit_row(
                &access,
                &graph,
                entity(table_kind)?,
                row
            ));
        }
        result[table_kind] = json!({
            "version":1,"revision":revision,"board_key":board_key,"kind":table_kind,"storage":"native",
            "definition":definition,"rows":data,"options":options,"permissions":access.value(&graph)
        });
    }
    Ok(Json(if kind == "overview" {
        result
    } else {
        result[&kind].take()
    }))
}

pub(crate) async fn table_rows(
    tx: &mut PgConnection,
    pid: i64,
    board_key: &str,
    kind: &str,
) -> Result<Vec<Value>> {
    entity(kind)?;
    crate::dsp_points::table_rows(tx, pid, board_key, kind).await
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
    Path((pid, board_key, kind)): Path<(i64, String, String)>,
    Json(c): Json<PointChange>,
) -> Result<Json<Value>> {
    let c = Change {
        calculation_rule: Value::Null,
        revision: c.revision,
        entity: if kind == "forward" && c.operation == "recalculate" {
            "point_calculation".into()
        } else {
            entity(&kind)?.into()
        },
        operation: c.operation,
        id: c.id,
        values: json!({"board_key":board_key,"fields":c.values}),
        expected: c.expected,
    };
    topology::preview(State(s), u, Path(pid), Json(c)).await
}
pub async fn apply(tx: &mut PgConnection, pid: i64, c: &Change) -> Result<Value> {
    let kind = match c.entity.as_str() {
        "process_points" => "process",
        "transmit_points" => "forward",
        "collect_points" => "collect",
        _ => return Err(AppError::bad("未启用的点表类型")),
    };
    let board_key = c.values["board_key"]
        .as_str()
        .filter(|key| !key.trim().is_empty())
        .ok_or(AppError::bad("缺少板卡标识"))?;
    board(tx, pid, board_key).await?;
    let fields = c.values["fields"]
        .as_object()
        .ok_or(AppError::bad("点表字段必须为对象"))?;
    if c.operation != "delete" && fields.is_empty() {
        return Err(AppError::bad("未提供修改字段"));
    }
    crate::dsp_points::apply(tx, pid, board_key, kind, c).await
}
pub fn audit_before(g: &Value, entity: &str, id: i64, board_key: &str) -> Option<Value> {
    if !is_point_entity(entity) {
        return None;
    }
    topology::find(g, entity, id)
        .filter(|row| row["board_key"] == board_key)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration() -> Value {
        crate::project_files::ProjectFiles::load_from(std::path::Path::new("config"))
            .unwrap()
            .definition(Some("dc-ups"))
            .unwrap()
            .clone()
    }

    #[test]
    fn validates_workspace_visibility() {
        let base = configuration();
        validate_definition(&base).unwrap();
        for board in [
            json!({"tables": ["forward", "process"], "labels": {"process": "DSP内部数据"}}),
            json!({"tables": []}),
        ] {
            let mut v = base.clone();
            v["workspace"]["boards"]["DSP"] = board;
            validate_definition(&v).unwrap();
        }
        for board in [
            json!(null),
            json!({"tables": ["process", "process"]}),
            json!({"tables": ["unknown"]}),
            json!({"tables": ["ranges"]}),
            json!({"tables": [1]}),
            json!({"tables": "process"}),
            json!({"tables": [], "labels": {"process": " "}}),
            json!({"tables": [], "labels": {"process": 1}}),
            json!({"tables": [], "labels": {"unknown": "标题"}}),
            json!({"tables": [], "labels": []}),
            json!({"table": []}),
            json!({"tables": [], "rules": {}}),
        ] {
            let mut v = base.clone();
            v["workspace"]["boards"]["DSP"] = board;
            assert!(validate_definition(&v).is_err(), "{}", v["workspace"]);
        }
        let mut v = base.clone();
        v["workspace"]["default_tables"] = json!(["process"]);
        assert!(validate_definition(&v).is_err());
        v.as_object_mut().unwrap().remove("workspace");
        assert!(validate_definition(&v).is_err());
        assert!(definition(&base, "process", "UNKNOWN").is_err());
    }

    #[test]
    fn validates_business_configuration() {
        let base = configuration();
        for key in ["project_id", "raw_json", "not_a_field", "endpoint_id"] {
            let mut v = base.clone();
            v["boards"]["DSP"]["process"]["fields"][key] = json!({"label":"bad"});
            assert!(validate_definition(&v).is_err());
        }
        let mut v = base.clone();
        v["boards"]["DSP"]["process"]["editor"]
            .as_array_mut()
            .unwrap()
            .push(json!("collection_count"));
        assert!(validate_definition(&v).is_err());
        let mut v = base.clone();
        v["boards"]["DSP"]["process"]
            .as_object_mut()
            .unwrap()
            .remove("inline");
        assert!(validate_definition(&v).is_err());
        assert!(entity("unknown").is_err());
        assert_eq!(entity("collect").unwrap(), "collect_points");
        assert_eq!(entity("forward").unwrap(), "transmit_points");
        assert!(!writable("process").contains("group_id"));
        assert!(!writable("forward").contains("field_id"));
        assert!(!is_point_entity("forward_points"));
    }
    #[test]
    fn audit_identity_includes_the_json_board_key() {
        let graph = json!({"process_points":[{"id":5,"board_key":"DSP","name":"point"}]});
        assert_eq!(
            audit_before(&graph, "process_points", 5, "DSP").unwrap()["name"],
            "point"
        );
        assert!(audit_before(&graph, "process_points", 5, "UPM").is_none());
        assert!(audit_before(&graph, "transmit_points", 5, "DSP").is_none());
    }
}
