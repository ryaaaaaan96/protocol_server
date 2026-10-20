//! Declarative board capabilities. Board names never select an implementation.
use crate::{
    error::{AppError, Result},
    topology::{rows, strv},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Rules {
    #[serde(skip_serializing_if = "is_false")]
    pub sheet_layout: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub raw_representation: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub inherit_name: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub source_range_warnings: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub warn_missing_sig_id: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub null_callbacks: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub category_models: BTreeMap<String, u16>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub value_options: BTreeMap<String, Vec<String>>,
}
fn is_false(value: &bool) -> bool {
    !*value
}
pub fn flag(board: &Value, key: &str) -> bool {
    board["point_rules"][key] == true
}
pub fn raw(board: &Value) -> bool {
    flag(board, "raw_representation")
}
pub fn inherited_name(board: &Value) -> bool {
    flag(board, "inherit_name") || flag(board, "sheet_layout")
}
pub fn board<'a>(graph: &'a Value, key: &str) -> Option<&'a Value> {
    rows(&graph["project_config"], "board_types")
        .iter()
        .find(|b| b["code"] == key && b["point_storage"] == "native")
}
pub fn raw_row(graph: &Value, row: &Value) -> bool {
    board(graph, strv(row, "board_key")).is_some_and(raw)
}
pub fn can_collect(board: &Value, group: &Value) -> bool {
    rows(board, "point_groups")
        .iter()
        .find(|g| &g["code"] == group)
        .is_some_and(|g| g["collect_enabled"] != false)
}
pub fn validate(rules: &Rules) -> Result<()> {
    if rules.sheet_layout && rules.raw_representation {
        return Err(AppError::bad(
            "sheet_layout 与 raw_representation 不可同时启用",
        ));
    }
    if rules.category_models.len() > 256
        || rules.value_options.len() > 32
        || rules.null_callbacks.len() > 32
        || rules.value_options.values().any(|v| v.len() > 256)
    {
        return Err(AppError::bad("point_rules 的映射或选项超出数量限制"));
    }
    if rules.value_options.keys().any(|key| {
        ![
            "access",
            "ram",
            "flash",
            "eeprom",
            "calibration",
            "cpu",
            "upload_level",
        ]
        .contains(&key.as_str())
    }) || rules.value_options.values().any(|options| {
        options.is_empty() || options.iter().any(|v| v.trim().is_empty() || v.len() > 300)
    }) || rules
        .category_models
        .keys()
        .any(|name| name.trim().is_empty() || name.len() > 300)
    {
        return Err(AppError::bad("point_rules 包含不支持的选项字段或空值"));
    }
    Ok(())
}
