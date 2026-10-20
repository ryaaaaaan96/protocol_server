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
        "id,board_key,unit,data_type,byte_length,resolved_sig_id,enum_name,group_key,group_name,metadata,device_addresses,source_variable,source_sig_id,source_notes,register_count,source_id,source_device_code,source_device_name",
    );
    let extra = if kind == "process" {
        keys("group_name,contexts,collection_count,forward_count,range_inherited")
    } else {
        keys(
            "signal_name,field_name,context_name,dev_id,endpoint_name,protocol,transport,port,upp_model,effective_address,address_length,effective_type,effective_length,register_type,access,scale,byte_order,default_value,min_value,max_value",
        )
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
    if object.keys().any(|key| {
        !required.contains(&key.as_str())
            && !matches!(
                key.as_str(),
                "calculation"
                    | "hidden_source_sig_ids"
                    | "mapping"
                    | "behavior"
                    | "presentation"
                    | "instance_calculation"
            )
    }) || required.iter().any(|key| !object.contains_key(*key))
    {
        return Err(AppError::bad(
            "单表配置须完整包含 label、description、columns、editor、ordering、inline、fields",
        ));
    }
    if let Some(value) = table.get("instance_calculation") {
        if kind != "forward"
            || !value.is_boolean()
            || value == true && table.get("behavior").is_none()
        {
            return Err(AppError::bad(
                "instance_calculation 仅支持转发表布尔值，启用时必须配置 behavior",
            ));
        }
    }
    if let Some(markers) = table.get("hidden_source_sig_ids") {
        if kind != "process"
            || markers.as_array().is_none_or(|markers| {
                markers.len() > 16
                    || markers.iter().any(|marker| {
                        marker
                            .as_str()
                            .is_none_or(|s| s.trim().is_empty() || s.len() > 64)
                    })
            })
        {
            return Err(AppError::bad(
                "hidden_source_sig_ids 仅支持处理点表，须为最多 16 个非空标记的数组，每项不超过 64 字节",
            ));
        }
    }
    if let Some(rule) = table.get("mapping") {
        if table.get("behavior").is_some() {
            return Err(AppError::bad(
                "派生采集表使用 mapping 脚本，不支持同时配置 behavior",
            ));
        }
        if kind != "collect"
            || !table["editor"].as_array().is_some_and(|v| v.is_empty())
            || !table["inline"].as_object().is_some_and(|v| v.is_empty())
            || table["ordering"]["mode"] != "disabled"
        {
            return Err(AppError::bad(
                "mapping 仅支持只读采集表，须关闭编辑、行排序与 inline",
            ));
        }
        crate::derived_collection::validate_rule(rule)?;
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
    if let Some(rule) = table.get("behavior") {
        crate::table_behavior::validate_rule(rule)?;
        crate::table_runtime::validate_declarations(kind, table)?;
    }
    validate_fields(fields, kind, table)?;
    validate_presentation(table, fields)?;
    validate_table(kind, table, fields)
}

fn configured_fields<'a>(kind: &'a str, table: &'a Value, write: bool) -> BTreeSet<&'a str> {
    let mut result = if write {
        schema_writable(kind)
    } else {
        readable(kind)
    };
    for key in if write {
        vec!["editable_fields"]
    } else {
        vec!["editable_fields", "project_fields"]
    } {
        result.extend(
            table["behavior"][key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        );
    }
    result
}
fn validate_fields(
    fields: &serde_json::Map<String, Value>,
    kind: &str,
    table: &Value,
) -> Result<()> {
    let allowed = configured_fields(kind, table, false);
    for (key, field) in fields {
        if !allowed.contains(key.as_str())
            || !field.is_object()
            || field["label"].as_str().is_none_or(|s| s.trim().is_empty())
        {
            return Err(AppError::bad(format!("未知字段或无标题字段：{key}")));
        }
        if let Some(protocols) = field.get("protocols") {
            let mut seen = BTreeSet::new();
            if protocols.as_array().is_none_or(|items| {
                items.is_empty()
                    || items.len() > 2
                    || items.iter().any(|value| {
                        value.as_str().is_none_or(|protocol| {
                            !matches!(protocol, "UPP" | "MODBUS") || !seen.insert(protocol)
                        })
                    })
            }) {
                return Err(AppError::bad(format!(
                    "{key}.protocols 必须为不重复的非空 UPP/MODBUS 数组"
                )));
            }
        }
    }
    Ok(())
}

fn presentation_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && !["__proto__", "constructor", "prototype"].contains(&value)
        && value.bytes().enumerate().all(|(index, ch)| {
            ch == b'_' || ch.is_ascii_alphabetic() || index > 0 && ch.is_ascii_digit()
        })
}

fn validate_presentation(table: &Value, fields: &serde_json::Map<String, Value>) -> Result<()> {
    let Some(value) = table.get("presentation") else {
        return Ok(());
    };
    let presentation = value
        .as_object()
        .ok_or(AppError::bad("presentation 必须为对象"))?;
    if presentation.keys().any(|key| {
        ![
            "category_filter",
            "search_placeholder",
            "empty_text",
            "overview_hidden_fields",
            "overview_leading_fields",
            "computed_dependencies",
            "suggestion",
            "row_expansion",
        ]
        .contains(&key.as_str())
    }) {
        return Err(AppError::bad("presentation 包含不支持的属性"));
    }
    let known = |value: &Value| {
        value
            .as_str()
            .is_some_and(|key| presentation_key(key) && fields.contains_key(key))
    };
    if let Some(expansion) = presentation.get("row_expansion") {
        let expansion = expansion
            .as_object()
            .filter(|v| {
                v.len() == 2 && v.contains_key("field") && v.contains_key("leading_columns")
            })
            .ok_or(AppError::bad(
                "presentation.row_expansion 须包含 field 和 leading_columns",
            ))?;
        let field = &expansion["field"];
        let mut seen = BTreeSet::new();
        if !known(field)
            || !table["behavior"]["project_fields"]
                .as_array()
                .is_some_and(|keys| keys.contains(field))
            || table["editor"]
                .as_array()
                .is_some_and(|keys| keys.contains(field))
            || expansion["leading_columns"]
                .as_array()
                .is_none_or(|columns| {
                    columns.is_empty()
                        || columns.len() > 16
                        || columns.iter().any(|column| {
                            !known(column)
                                || column == field
                                || !seen.insert(column.as_str().unwrap_or(""))
                        })
                })
        {
            return Err(AppError::bad(
                "row_expansion.field 必须引用只读脚本显示字段，leading_columns 须为 1～16 个已声明的不重复字段",
            ));
        }
    }
    if presentation
        .get("category_filter")
        .is_some_and(|v| !known(v))
    {
        return Err(AppError::bad(
            "presentation.category_filter 必须引用已声明字段",
        ));
    }
    for key in ["search_placeholder", "empty_text"] {
        if presentation
            .get(key)
            .is_some_and(|v| v.as_str().is_none_or(|text| text.len() > 4096))
        {
            return Err(AppError::bad(format!(
                "presentation.{key} 必须为不超过 4096 字节的文本"
            )));
        }
    }
    for key in ["overview_hidden_fields", "overview_leading_fields"] {
        let Some(selected) = presentation.get(key) else {
            continue;
        };
        let mut seen = BTreeSet::new();
        if selected.as_array().is_none_or(|items| {
            items.len() > 128
                || items.iter().any(|value| {
                    !known(value)
                        || !table["columns"]
                            .as_array()
                            .is_some_and(|cols| cols.contains(value))
                        || !seen.insert(value.as_str().unwrap_or(""))
                })
        }) {
            return Err(AppError::bad(format!(
                "presentation.{key} 必须为已声明显示列的不重复数组，最多 128 项"
            )));
        }
    }
    if let Some(dependencies) = presentation.get("computed_dependencies") {
        let dependencies = dependencies
            .as_object()
            .filter(|items| items.len() <= 128)
            .ok_or(AppError::bad(
                "presentation.computed_dependencies 必须为最多 128 项的字段映射",
            ))?;
        for (target, sources) in dependencies {
            let mut seen = BTreeSet::new();
            if !presentation_key(target)
                || !fields.contains_key(target)
                || sources.as_array().is_none_or(|sources| {
                    sources.is_empty()
                        || sources.len() > 128
                        || sources.iter().any(|source| {
                            !known(source) || !seen.insert(source.as_str().unwrap_or(""))
                        })
                })
            {
                return Err(AppError::bad(format!(
                    "computed_dependencies.{target} 必须引用已声明字段及不重复的非空依赖字段数组"
                )));
            }
        }
    }
    if let Some(suggestion) = presentation.get("suggestion") {
        let suggestion = suggestion
            .as_object()
            .ok_or(AppError::bad("presentation.suggestion 必须为对象"))?;
        if suggestion.keys().any(|key| {
            !["reference", "source_key", "fields", "description"].contains(&key.as_str())
        }) {
            return Err(AppError::bad("presentation.suggestion 包含不支持的属性"));
        }
        let reference = suggestion
            .get("reference")
            .and_then(Value::as_str)
            .filter(|key| presentation_key(key))
            .ok_or(AppError::bad("suggestion.reference 必须为有效的选项引用"))?;
        let source = suggestion
            .get("source_key")
            .filter(|value| known(value))
            .and_then(Value::as_str)
            .ok_or(AppError::bad("suggestion.source_key 必须引用已声明字段"))?;
        if fields[source]["reference"] != reference {
            return Err(AppError::bad(
                "suggestion.reference 必须与 source_key 字段的 reference 一致",
            ));
        }
        let mapping = suggestion
            .get("fields")
            .and_then(Value::as_object)
            .filter(|mapping| !mapping.is_empty() && mapping.len() <= 128)
            .ok_or(AppError::bad(
                "suggestion.fields 必须为非空字段映射，最多 128 项",
            ))?;
        if mapping.iter().any(|(target, source)| {
            !presentation_key(target)
                || !fields.contains_key(target)
                || source.as_str().is_none_or(|key| !presentation_key(key))
        }) {
            return Err(AppError::bad(
                "suggestion.fields 必须将已声明字段映射到有效的来源字段标识",
            ));
        }
        if suggestion
            .get("description")
            .is_some_and(|v| v.as_str().is_none_or(|text| text.len() > 4096))
        {
            return Err(AppError::bad(
                "suggestion.description 必须为不超过 4096 字节的文本",
            ));
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
            .filter(|a| !a.is_empty() || section == "editor" && table.get("mapping").is_some())
            .ok_or(AppError::bad("点表 columns/editor 不能为空"))?;
        let mut seen = BTreeSet::new();
        for item in items {
            let key = item.as_str().ok_or(AppError::bad("点表列必须为字段标识"))?;
            if !fields.contains_key(key)
                || !seen.insert(key)
                || !configured_fields(kind, table, false).contains(key)
                || (section == "editor" && !configured_fields(kind, table, true).contains(key))
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
                || !configured_fields(kind, table, false).contains(column.as_str())
                || !configured_fields(kind, table, true).contains(field)
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
    let captured = crate::table_runtime::definitions(tx, pid).await?;
    if captured.get(board_key).is_some() {
        return Ok(captured[board_key][kind].clone());
    }
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
    crate::native_points::native_board(tx, pid, board_key)
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
    crate::table_runtime::bind(&mut tx, pid, &s.project_files).await?;
    if board["point_storage"] == "derived" {
        if kind != "collect" {
            return Err(AppError::bad("此设备只有一张派生采集表"));
        }
        let definition =
            board_definition(&mut tx, pid, &board_key, "collect", &s.project_files).await?;
        let graph = crate::topology::snapshot(&mut tx, pid, false).await?;
        let data = crate::derived_collection::evaluate(&graph, &board_key, &definition["mapping"])?;
        return Ok(Json(
            json!({"version":1,"revision":revision,"board_key":board_key,"kind":"collect","storage":"derived","derived":true,
            "definition":definition,"rows":data,"options":{"native_groups":board["point_groups"],"endpoints":board["point_endpoints"],"process_points":[]}}),
        ));
    }
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
    crate::native_points::table_rows(tx, pid, board_key, kind).await
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
        table_definitions: Value::Null,
        revision: c.revision,
        entity: if c.operation == "recalculate" {
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
    crate::native_points::apply(tx, pid, board_key, kind, c).await
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
    fn presentation_rejects_invalid_shapes_and_unknown_field_references() {
        let base = configuration()["boards"]["DSP"]["forward"].clone();
        validate_table_file("forward", &base).unwrap();
        for presentation in [
            json!(null),
            json!([]),
            json!({"unsupported":true}),
            json!({"row_expansion":true}),
            json!({"row_expansion":{"field":"missing","leading_columns":["signal_name"]}}),
            json!({"row_expansion":{"field":"signal_name","leading_columns":["signal_name"]}}),
            json!({"category_filter":"missing"}),
            json!({"category_filter":[]}),
            json!({"empty_text":false}),
            json!({"search_placeholder":"x".repeat(4097)}),
            json!({"overview_hidden_fields":null}),
            json!({"overview_hidden_fields":"signal_name"}),
            json!({"overview_hidden_fields":["missing"]}),
            json!({"overview_hidden_fields":["process_point_id"]}),
            json!({"overview_hidden_fields":["signal_name","signal_name"]}),
            json!({"overview_leading_fields":null}),
            json!({"overview_leading_fields":"signal_name"}),
            json!({"overview_leading_fields":["missing"]}),
            json!({"overview_leading_fields":["process_point_id"]}),
            json!({"overview_leading_fields":["signal_name","signal_name"]}),
            json!({"computed_dependencies":[]}),
            json!({"computed_dependencies":{"upp_model":{}}}),
            json!({"computed_dependencies":{"missing":["process_point_id"]}}),
            json!({"computed_dependencies":{"upp_model":[]}}),
            json!({"computed_dependencies":{"upp_model":["missing"]}}),
            json!({"computed_dependencies":{"upp_model":["process_point_id","process_point_id"]}}),
            json!({"suggestion":[]}),
            json!({"suggestion":{"reference":"process_points","source_key":"process_point_id","fields":{}}}),
            json!({"suggestion":{"reference":"__proto__","source_key":"process_point_id","fields":{"wire_type":"recommended_wire_type"}}}),
            json!({"suggestion":{"reference":"endpoints","source_key":"process_point_id","fields":{"wire_type":"recommended_wire_type"}}}),
            json!({"suggestion":{"reference":"process_points","source_key":"missing","fields":{"wire_type":"recommended_wire_type"}}}),
            json!({"suggestion":{"reference":"process_points","source_key":"process_point_id","fields":{"missing":"recommended_wire_type"}}}),
            json!({"suggestion":{"reference":"process_points","source_key":"process_point_id","fields":{"wire_type":{}}}}),
            json!({"suggestion":{"reference":"process_points","source_key":"process_point_id","fields":{"wire_type":"constructor"}}}),
            json!({"suggestion":{"reference":"process_points","source_key":"process_point_id","fields":{"wire_type":"recommended_wire_type"},"description":true}}),
            json!({"suggestion":{"reference":"process_points","source_key":"process_point_id","fields":{"wire_type":"recommended_wire_type"},"unknown":"ignored?"}}),
        ] {
            let mut table = base.clone();
            table["presentation"] = presentation;
            assert!(
                validate_table_file("forward", &table).is_err(),
                "{}",
                table["presentation"]
            );
        }
        // A declared hidden/computed field can still be a dependency; it need
        // not be editable or visible in the current table.
        let mut table = base;
        table["presentation"] = json!({
            "empty_text":"",
            "overview_hidden_fields":["signal_name"],
            "overview_leading_fields":["category","upp_model"],
            "computed_dependencies":{"effective_type":["recommended_wire_type"]}
        });
        validate_table_file("forward", &table).unwrap();
    }

    #[test]
    fn row_expansion_requires_declared_readonly_fields() {
        let base = configuration()["boards"]["UPM"]["forward"].clone();
        validate_table_file("forward", &base).unwrap();
        for expansion in [
            json!({"field":"instance_rows"}),
            json!({"field":"instance_rows","leading_columns":[]}),
            json!({"field":"instance_rows","leading_columns":["missing"]}),
            json!({"field":"instance_rows","leading_columns":["instance_rows"]}),
            json!({"field":"instance_rows","leading_columns":["instance_device","instance_device"]}),
            json!({"field":"instance_rows","leading_columns":["instance_device"],"extra":true}),
        ] {
            let mut table = base.clone();
            table["presentation"]["row_expansion"] = expansion;
            assert!(validate_table_file("forward", &table).is_err());
        }
    }

    #[test]
    fn protocol_field_visibility_is_typed_and_derived_mapping_has_one_hook() {
        let base = configuration();
        for protocols in [
            json!(null),
            json!({}),
            json!("UPP"),
            json!([]),
            json!(["UPP", "UPP"]),
            json!(["UNKNOWN"]),
            json!([1]),
        ] {
            let mut table = base["boards"]["UPM"]["forward"].clone();
            table["fields"]["upp_model"]["protocols"] = protocols;
            assert!(validate_table_file("forward", &table).is_err());
        }
        let mut table = base["boards"]["UPM"]["forward"].clone();
        table["fields"]["upp_model"]["protocols"] = json!(["UPP", "MODBUS"]);
        validate_table_file("forward", &table).unwrap();

        let mut derived = base["boards"]["UPM_DEMO"]["collect"].clone();
        validate_table_file("collect", &derived).unwrap();
        derived["behavior"] = base["boards"]["DSP"]["process"]["behavior"].clone();
        let error = validate_table_file("collect", &derived).unwrap_err();
        assert!(error.1.contains("不支持同时配置 behavior"));
    }

    #[test]
    fn source_sig_id_visibility_is_bounded_and_process_only() {
        let base = configuration();
        let mut table = base["boards"]["UPM"]["process"].clone();
        validate_table_file("process", &table).unwrap();
        for markers in [
            json!(null),
            json!("※"),
            json!([""]),
            json!([1]),
            json!(["a".repeat(65)]),
            json!(vec!["※"; 17]),
        ] {
            table["hidden_source_sig_ids"] = markers;
            assert!(validate_table_file("process", &table).is_err());
        }
        for kind in ["collect", "forward"] {
            let mut other = base["boards"]["UPM"][kind].clone();
            other["hidden_source_sig_ids"] = json!(["※"]);
            assert!(validate_table_file(kind, &other).is_err());
        }
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
