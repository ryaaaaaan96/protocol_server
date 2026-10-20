//! Bounded, declarative XLSX mappings shared by every board.
use crate::{
    error::{AppError, Result},
    topology::{num, strv},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportData {
    pub process: Vec<Value>,
    pub collect: Vec<Value>,
    pub transmit: Vec<Value>,
    pub warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Spec {
    version: u32,
    #[serde(default)]
    lookups: Vec<Lookup>,
    process: Vec<Sheet>,
    #[serde(default)]
    collect: Vec<Sheet>,
    #[serde(default)]
    transmit: Vec<Sheet>,
    #[serde(default)]
    warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lookup {
    key: String,
    sheet: String,
    key_column: String,
    value_column: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sheet {
    sheet: String,
    group: String,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    reference: Option<Cell>,
    #[serde(default)]
    fields: BTreeMap<String, Cell>,
    #[serde(default)]
    metadata: BTreeMap<String, Cell>,
    #[serde(default)]
    conditions: Vec<Condition>,
    #[serde(default = "first_row")]
    first_row: i64,
    #[serde(default)]
    merge_equal: bool,
    #[serde(default)]
    element_width_column: Option<String>,
    #[serde(default)]
    clear_string_bounds: bool,
    #[serde(default)]
    source_range_warnings: bool,
    #[serde(default)]
    match_type_length: bool,
}
fn first_row() -> i64 {
    2
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Condition {
    column: String,
    #[serde(default)]
    equals: Option<String>,
    #[serde(default)]
    contains: Option<String>,
    #[serde(default)]
    starts_with: Option<String>,
    #[serde(default)]
    not_empty: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    when: Condition,
    value: Value,
}
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Cell {
    column: Option<String>,
    value: Value,
    default: Value,
    kind: String,
    strip_prefix: Option<String>,
    transform: Option<String>,
    lookup: Option<String>,
    null_values: Vec<String>,
    cases: Vec<Case>,
}
impl Default for Cell {
    fn default() -> Self {
        Self {
            column: None,
            value: Value::Null,
            default: Value::Null,
            kind: "text".into(),
            strip_prefix: None,
            transform: None,
            lookup: None,
            null_values: vec![],
            cases: vec![],
        }
    }
}
fn fail(row: &Value, message: impl std::fmt::Display) -> AppError {
    AppError::bad(format!(
        "{}!{}：{message}",
        strv(row, "sheet"),
        row["row_number"]
    ))
}
fn column(row: &Value, key: &str) -> String {
    row["cells"]["values"][key]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned()
}
fn condition(row: &Value, rule: &Condition) -> bool {
    let value = column(row, &rule.column);
    rule.equals.as_ref().is_none_or(|v| v == &value)
        && rule.contains.as_ref().is_none_or(|v| value.contains(v))
        && rule
            .starts_with
            .as_ref()
            .is_none_or(|v| value.starts_with(v))
        && (!rule.not_empty || !value.is_empty())
}
fn cell(
    row: &Value,
    rule: &Cell,
    lookups: &BTreeMap<String, BTreeMap<String, Value>>,
) -> Result<Value> {
    let mut value = rule
        .cases
        .iter()
        .find(|c| condition(row, &c.when))
        .map(|c| c.value.clone())
        .unwrap_or_else(|| {
            rule.column
                .as_ref()
                .map(|key| json!(column(row, key)))
                .unwrap_or_else(|| rule.value.clone())
        });
    if value.is_null() || value == "" {
        if !rule.default.is_null() {
            value = rule.default.clone();
        }
    }
    if value
        .as_str()
        .is_some_and(|s| rule.null_values.iter().any(|v| v == s))
    {
        return Ok(Value::Null);
    }
    if let Some(prefix) = &rule.strip_prefix {
        if let Some(text) = value.as_str() {
            value = json!(text.strip_prefix(prefix).unwrap_or(text));
        }
    }
    if let Some(transform) = &rule.transform {
        value = match transform.as_str() {
            "enum" => json!(crate::model::snake(
                value.as_str().ok_or(fail(row, "枚举须为文本"))?
            )),
            "upper" => json!(
                value
                    .as_str()
                    .ok_or(fail(row, "类型须为文本"))?
                    .to_uppercase()
            ),
            _ => return Err(fail(row, "未知转换")),
        };
    }
    if let Some(key) = &rule.lookup {
        if let Some(found) = lookups
            .get(key)
            .and_then(|m| m.get(value.as_str().unwrap_or_default()))
        {
            value = found.clone();
        }
    }
    match rule.kind.as_str() {
        "text" => Ok(value),
        "integer" | "number" => {
            let number = value
                .as_f64()
                .or_else(|| value.as_str()?.parse::<f64>().ok())
                .filter(|n| n.is_finite())
                .ok_or(fail(row, format!("{:?} 列需要有效数值", rule.column)))?;
            if rule.kind == "integer" {
                if number.fract() != 0. || number.abs() > 9_007_199_254_740_991. {
                    return Err(fail(row, "整数超出安全范围"));
                }
                Ok(json!(number as i64))
            } else {
                Ok(json!(number))
            }
        }
        "boolean" => value
            .as_bool()
            .map(|v| json!(v))
            .ok_or(fail(row, "需要布尔值")),
        _ => Err(fail(row, "未知字段类型")),
    }
}
fn spec(value: &Value) -> Result<Spec> {
    let s: Spec = serde_json::from_value(value.clone())
        .map_err(|e| AppError::bad(format!("工作簿映射格式错误：{e}")))?;
    if s.version != 1
        || s.process.is_empty()
        || s.process.len() + s.collect.len() + s.transmit.len() > 64
        || s.lookups.len() > 16
        || value.to_string().len() > 256 * 1024
    {
        return Err(AppError::bad("工作簿映射版本、条数或大小无效"));
    }
    let lookup_keys: BTreeSet<_> = s.lookups.iter().map(|l| &l.key).collect();
    if lookup_keys.len() != s.lookups.len() {
        return Err(AppError::bad("lookup 标识重复"));
    }
    for (kind, sheets) in [
        ("process", &s.process),
        ("collect", &s.collect),
        ("forward", &s.transmit),
    ] {
        let allowed = match kind {
            "process" => crate::native_points::PROCESS_COLUMNS,
            "collect" => crate::native_protocol::COLLECT_COLUMNS,
            _ => crate::native_points::TRANSMIT_COLUMNS,
        };
        for sheet in sheets {
            if sheet.sheet.trim().is_empty()
                || !crate::model::identifier(&sheet.group)
                || sheet.first_row < 2
                || (kind != "process" && (sheet.reference.is_none() || sheet.endpoint.is_none()))
                || sheet.fields.keys().any(|k| {
                    !allowed.split(',').any(|f| f == k)
                        || [
                            "metadata",
                            "source_sheet",
                            "source_row",
                            "display_order",
                            "process_point_id",
                            "group_key",
                            "endpoint_key",
                        ]
                        .contains(&k.as_str())
                })
            {
                return Err(AppError::bad("工作簿映射包含非法字段、分组或缺少关联"));
            }
            for c in sheet
                .fields
                .values()
                .chain(sheet.metadata.values())
                .chain(sheet.reference.iter())
            {
                if !["text", "integer", "number", "boolean"].contains(&c.kind.as_str())
                    || c.transform
                        .as_deref()
                        .is_some_and(|v| !["enum", "upper"].contains(&v))
                    || c.lookup.as_ref().is_some_and(|v| !lookup_keys.contains(v))
                    || c.cases.len() > 64
                {
                    return Err(AppError::bad("工作簿字段转换或 lookup 无效"));
                }
            }
        }
    }
    Ok(s)
}
pub fn validate_for(board: &Value, value: &Value) -> Result<()> {
    let parsed = spec(value)?;
    for (kind, sources) in [
        ("process", parsed.process),
        ("collect", parsed.collect),
        ("forward", parsed.transmit),
    ] {
        for source in sources {
            if !crate::topology::rows(board, "point_groups")
                .iter()
                .any(|g| g["code"] == source.group)
                || (kind == "collect"
                    && !crate::board_rules::can_collect(board, &json!(source.group)))
                || (kind != "process"
                    && !crate::topology::rows(board, "point_endpoints")
                        .iter()
                        .any(|e| {
                            e["code"] == json!(source.endpoint)
                                && if kind == "collect" {
                                    e["direction"] == "collect"
                                } else {
                                    e["direction"] != "collect"
                                }
                        }))
            {
                return Err(AppError::bad(
                    "工作簿映射的分组、端点或采集权限未在板卡配置中定义",
                ));
            }
        }
    }
    Ok(())
}
pub fn sheets(value: &Value) -> Vec<String> {
    value["process"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(value["collect"].as_array().into_iter().flatten())
        .chain(value["transmit"].as_array().into_iter().flatten())
        .chain(value["lookups"].as_array().into_iter().flatten())
        .filter_map(|s| s["sheet"].as_str().map(str::to_owned))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn width(typ: &str) -> Option<i64> {
    match typ {
        "U8" | "STRING" => Some(1),
        "U16" | "S16" => Some(2),
        "U32" | "S32" | "F32" => Some(4),
        _ => None,
    }
}

pub fn parse_workbook(bytes: Vec<u8>, board: &Value, definition: &Value) -> Result<ImportData> {
    let s = spec(definition)?;
    let names = sheets(definition);
    let selected: Vec<_> = names.iter().map(String::as_str).collect();
    let rows = workbook_rows(bytes, &selected)?;
    let mut lookups = BTreeMap::new();
    for rule in s.lookups {
        let mut values = BTreeMap::new();
        for row in rows.iter().filter(|r| r["sheet"] == rule.sheet) {
            let key = column(row, &rule.key_column);
            let value = json!(column(row, &rule.value_column));
            if let Some(previous) = values.insert(key.clone(), value.clone()) {
                if previous != value {
                    return Err(fail(
                        row,
                        format!("lookup 键 {key} 有冲突：{previous} / {value}"),
                    ));
                }
            }
        }
        lookups.insert(rule.key, values);
    }
    let mut out = ImportData {
        process: vec![],
        collect: vec![],
        transmit: vec![],
        warnings: s.warnings,
    };
    let mut ids: BTreeMap<(String, String), usize> = BTreeMap::new();
    for (kind, rules) in [
        ("process", s.process),
        ("collect", s.collect),
        ("forward", s.transmit),
    ] {
        // Process rows are already canonical and complete before either mapping
        // table is parsed. Project the full template once so cross-row aliases
        // agree with ordinary table reads; IDs here are local to this import.
        let defs = &board["table_definitions"];
        let projected_sources = if kind != "process" && defs[kind].get("behavior").is_some() {
            let mut source_rows = out.process.clone();
            for (index, point) in source_rows.iter_mut().enumerate() {
                point["id"] = json!(index + 1);
            }
            crate::table_runtime::sources(defs, &source_rows)?
        } else {
            vec![]
        };
        for rule in rules {
            let mut count = 0;
            for row in rows.iter().filter(|r| {
                r["sheet"] == rule.sheet
                    && num(r, "row_number") >= rule.first_row
                    && rule.conditions.iter().all(|c| condition(r, c))
            }) {
                count += 1;
                let mut value = crate::native_points::defaults(kind);
                value["board_key"] = board["code"].clone();
                value["group_key"] = json!(rule.group);
                let source = if kind == "process" {
                    None
                } else {
                    let reference = cell(row, rule.reference.as_ref().unwrap(), &lookups)?;
                    let key = (
                        rule.group.clone(),
                        reference
                            .as_str()
                            .ok_or(fail(row, "关联枚举须为文本"))?
                            .to_owned(),
                    );
                    let point = &out.process[*ids
                        .get(&key)
                        .ok_or(fail(row, format!("找不到内部点 {}", key.1)))?];
                    value["process_group"] = json!(rule.group);
                    value["process_enum"] = reference;
                    value["endpoint_key"] = json!(rule.endpoint);
                    value["name"] = point["name"].clone();
                    value["wire_type"] = point["internal_type"].clone();
                    value["wire_length"] = point["byte_length"].clone();
                    Some(point)
                };
                for (key, c) in &rule.fields {
                    value[key] = cell(row, c, &lookups)?;
                }
                value["source_sheet"] = json!(rule.sheet);
                value["source_row"] = row["row_number"].clone();
                value["display_order"] = row["row_number"].clone();
                value["metadata"] = json!({"source_cells":row["cells"]});
                for (key, c) in &rule.metadata {
                    value["metadata"][key] = cell(row, c, &lookups)?;
                }
                if kind == "process" {
                    let size = width(strv(&value, "internal_type"))
                        .ok_or(fail(row, "不支持的内部类型"))?;
                    if let Some(col) = &rule.element_width_column {
                        if column(row, col).parse::<i64>().ok() != Some(size) {
                            return Err(fail(row, "元素字节数与内部类型不一致"));
                        }
                    }
                    if rule.fields.contains_key("byte_length") {
                        let length = num(&value, "byte_length");
                        if length < 1 || length % size != 0 {
                            return Err(fail(row, "内部类型与字节数不一致"));
                        }
                        value["element_count"] = json!(length / size);
                    } else {
                        value["byte_length"] = json!(size * num(&value, "element_count"));
                    }
                    if rule.clear_string_bounds && value["internal_type"] == "STRING" {
                        value["min_value"] = json!("");
                        value["max_value"] = json!("");
                    }
                    if rule.source_range_warnings {
                        value["metadata"]["original_ranges"] = json!({"default_value":value["default_value"],"min_value":value["min_value"],"max_value":value["max_value"],"internal_type":value["internal_type"],"byte_length":value["byte_length"]});
                    }
                    value["metadata"]["source_rows"] =
                        json!([{"sheet":row["sheet"],"row_number":row["row_number"]}]);
                    let key = (rule.group.clone(), strv(&value, "enum_name").to_owned());
                    if !crate::model::identifier(&key.1) || strv(&value, "name").is_empty() {
                        return Err(fail(row, "缺少有效名称或枚举"));
                    }
                    if let Some(index) = ids.get(&key) {
                        let original = &mut out.process[*index];
                        if !rule.merge_equal
                            || [
                                "sig_id",
                                "internal_type",
                                "byte_length",
                                "default_value",
                                "min_value",
                                "max_value",
                                "flags",
                                "callback",
                                "unit",
                            ]
                            .iter()
                            .any(|k| original[*k] != value[*k])
                        {
                            return Err(fail(row, "内部枚举重复或定义不一致"));
                        }
                        original["metadata"]["source_rows"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"sheet":row["sheet"],"row_number":row["row_number"]}));
                    } else {
                        ids.insert(key, out.process.len());
                        out.process.push(value);
                    }
                } else {
                    let point = source.unwrap();
                    if rule.match_type_length
                        && (value["wire_type"] != point["internal_type"]
                            || value["wire_length"] != point["byte_length"])
                    {
                        return Err(fail(row, "通信类型或长度与内部点不一致"));
                    }
                    let behavior_kind = if kind == "transmit" { "forward" } else { kind };
                    if defs[behavior_kind].get("behavior").is_some() {
                        let source_index = ids
                            .get(&(
                                strv(&value, "process_group").to_owned(),
                                strv(&value, "process_enum").to_owned(),
                            ))
                            .ok_or(fail(row, "映射找不到已投影的处理点"))?;
                        let projected = &projected_sources[*source_index];
                        let fields = value
                            .as_object()
                            .unwrap()
                            .iter()
                            .filter(|(k, _)| {
                                crate::point_tables::writable(behavior_kind).contains(k.as_str())
                            })
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect();
                        let updates = crate::table_behavior::normalize(
                            &defs[behavior_kind],
                            &value,
                            &fields,
                            projected,
                            "import",
                        )?;
                        crate::table_runtime::check_updates(behavior_kind, &updates)?;
                        value.as_object_mut().unwrap().extend(updates);
                    }
                    if kind == "collect" {
                        out.collect.push(value);
                    } else {
                        out.transmit.push(value);
                    }
                }
            }
            if count == 0 {
                return Err(AppError::bad(format!("{} 未匹配到数据行", rule.sheet)));
            }
        }
    }
    if out.process.len() + out.collect.len() + out.transmit.len() > 30000 {
        return Err(AppError::bad("单板导入超过 30000 行"));
    }
    Ok(out)
}

use calamine::{Reader, Xlsx};
use std::io::Cursor;
fn column_name(mut index: u32) -> String {
    let mut name = Vec::new();
    loop {
        name.push((b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name.into_iter().rev().collect()
}

pub(crate) fn workbook_rows(bytes: Vec<u8>, sheets: &[&str]) -> Result<Vec<Value>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes))
        .map_err(|_| AppError::bad("请上传有效的 .xlsx 工作簿"))?;
    let mut expanded = 0u64;
    for index in 0..archive.len() {
        expanded = expanded.saturating_add(
            archive
                .by_index(index)
                .map_err(|_| AppError::bad("工作簿压缩包损坏"))?
                .size(),
        );
    }
    if expanded > 150_000_000 {
        return Err(AppError::bad("工作簿解压后超过 150 MB"));
    }
    drop(archive);
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
        .map_err(|error| AppError::bad(format!("无法读取工作簿：{error}")))?;
    let mut rows = Vec::new();
    for &sheet in sheets {
        if !workbook.sheet_names().iter().any(|name| name == sheet) {
            return Err(AppError::bad(format!("缺少工作表：{sheet}")));
        }
        let cells = workbook
            .worksheet_range(sheet)
            .map_err(|error| AppError::bad(format!("无法读取 {sheet}：{error}")))?;
        let formulas = workbook
            .worksheet_formula(sheet)
            .map_err(|error| AppError::bad(format!("无法读取 {sheet} 公式：{error}")))?;
        let start = cells.start().unwrap_or_default();
        let mut count = 0;
        for (index, cells_row) in cells.rows().enumerate() {
            let row_index = start.0 + index as u32;
            if row_index == 0
                || cells_row
                    .iter()
                    .all(|value| value.to_string().trim().is_empty())
            {
                continue;
            }
            count += 1;
            if count > 10_000 {
                return Err(AppError::bad(format!("{sheet} 点数不能超过 10000 条")));
            }
            let mut values = serde_json::Map::new();
            let mut row_formulas = serde_json::Map::new();
            for (column, value) in cells_row.iter().enumerate() {
                let column_index = start.1 + column as u32;
                let key = column_name(column_index);
                values.insert(key.clone(), json!(value.to_string().trim()));
                if let Some(formula) = formulas
                    .get_value((row_index, column_index))
                    .filter(|formula| !formula.is_empty())
                {
                    row_formulas.insert(key, json!(formula));
                }
            }
            rows.push(json!({
                "sheet": sheet,
                "row_number": row_index + 1,
                "cells": {"values": values, "formulas": row_formulas}
            }));
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(code: &str) -> (Value, Value) {
        let manifest: Value =
            serde_json::from_str(include_str!("../config/dc-ups/project.json")).unwrap();
        let mut board = manifest["topology"]["board_types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["code"] == code)
            .unwrap()
            .clone();
        let definition: Value = serde_json::from_slice(
            &std::fs::read(format!("config/dc-ups/{code}/workbook.json")).unwrap(),
        )
        .unwrap();
        board["table_definitions"] =
            crate::project_files::ProjectFiles::load_from(std::path::Path::new("config"))
                .unwrap()
                .definition(Some("dc-ups"))
                .unwrap()["boards"][code]
                .clone();
        (board, definition)
    }
    #[test]
    fn declarative_import_preserves_existing_workbooks() {
        let bytes = include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec();
        for code in ["DSP", "UPM"] {
            let (board, definition) = config(code);
            validate_for(&board, &definition).unwrap();
            let actual = parse_workbook(bytes.clone(), &board, &definition).unwrap();
            let expected = if code == "DSP" {
                serde_json::to_value(crate::dsp_workbook::parse_workbook(bytes.clone()).unwrap())
                    .unwrap()
            } else {
                serde_json::to_value(crate::upm_workbook::parse_workbook(bytes.clone()).unwrap())
                    .unwrap()
            };
            let actual = serde_json::to_value(actual).unwrap();
            for kind in ["process", "collect", "transmit"] {
                let before = expected[kind].as_array().cloned().unwrap_or_default();
                let after = actual[kind].as_array().unwrap();
                assert_eq!(before.len(), after.len(), "{code} {kind}");
                let columns = match kind {
                    "process" => crate::native_points::PROCESS_COLUMNS,
                    "collect" => crate::native_protocol::COLLECT_COLUMNS,
                    _ => crate::native_points::TRANSMIT_COLUMNS,
                };
                for (a, b) in after.iter().zip(before.iter()) {
                    for field in columns.split(',').filter(|f| {
                        ![
                            "metadata",
                            "display_order",
                            "process_point_id",
                            "register_type",
                        ]
                        .contains(f)
                    }) {
                        if field == "scale" {
                            assert_eq!(a[field].as_f64(), b[field].as_f64());
                            continue;
                        }
                        assert_eq!(
                            a[field], b[field],
                            "{code} {kind} {} {field}",
                            a["source_row"]
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn import_mapping_sources_project_the_complete_process_template() {
        let (mut board, definition) = config("UPM");
        board["table_definitions"]["process"]["behavior"] = json!({
            "engine":"javascript","script_file":"process.js","parameters":{},
            "editable_fields":[],"metadata_fields":[],
            "project_fields":["template_total","temporary_id"],"owned_fields":[],
            "script":"export function behavior(context) { return context.rows.map(row => ({id:row.id,values:{template_total:context.rows.length,temporary_id:row.id}})); }"
        });
        board["table_definitions"]["collect"]["behavior"] = json!({
            "engine":"javascript","script_file":"collect.js","parameters":{},
            "editable_fields":[],"metadata_fields":["source_count","source_temporary_id"],
            "project_fields":[],"owned_fields":[],
            "script":"export function behavior(context) { return {values:{...context.fields,metadata:{...context.row.metadata,source_count:context.source.template_total,source_temporary_id:context.source.temporary_id}}}; }"
        });
        let data = parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
            &board,
            &definition,
        )
        .unwrap();
        assert_eq!(data.process.len(), 606);
        assert_eq!(data.collect.len(), 445);
        for mapping in &data.collect {
            let index = data
                .process
                .iter()
                .position(|point| {
                    point["group_key"] == mapping["process_group"]
                        && point["enum_name"] == mapping["process_enum"]
                })
                .unwrap();
            assert_eq!(
                mapping["metadata"]["source_count"],
                json!(data.process.len())
            );
            assert_eq!(mapping["metadata"]["source_temporary_id"], json!(index + 1));
        }
        assert!(data.process.iter().all(|point| point.get("id").is_none()));
    }
    #[test]
    fn renamed_board_groups_and_endpoints_need_only_json() {
        let (mut board, mut definition) = config("UPM");
        board["code"] = json!("NEW_BOARD");
        board["model_code"] = json!("NEW_MODEL");
        for g in board["point_groups"].as_array_mut().unwrap() {
            g["code"] = json!(format!("GROUP_{}", g["code"].as_str().unwrap()));
        }
        for e in board["point_endpoints"].as_array_mut().unwrap() {
            e["code"] = json!(format!("EP_{}", e["code"].as_str().unwrap()));
            e.as_object_mut().unwrap().remove("subset_of");
        }
        for kind in ["process", "collect", "transmit"] {
            for source in definition[kind].as_array_mut().unwrap() {
                source["group"] = json!(format!("GROUP_{}", source["group"].as_str().unwrap()));
                if let Some(e) = source["endpoint"].as_str() {
                    source["endpoint"] = json!(format!("EP_{e}"));
                }
            }
        }
        validate_for(&board, &definition).unwrap();
        let mut data = parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
            &board,
            &definition,
        )
        .unwrap();
        let mut ids = BTreeMap::new();
        for (i, p) in data.process.iter_mut().enumerate() {
            p["id"] = json!(i + 1);
            ids.insert(
                (
                    p["group_key"].clone().to_string(),
                    p["enum_name"].clone().to_string(),
                ),
                i + 1,
            );
        }
        for mappings in [&mut data.collect, &mut data.transmit] {
            for (i, p) in mappings.iter_mut().enumerate() {
                p["id"] = json!(i + 1);
                p["process_point_id"] = json!(
                    ids[&(
                        p["process_group"].to_string(),
                        p["process_enum"].to_string()
                    )]
                );
            }
        }
        let table_definitions = board
            .as_object_mut()
            .unwrap()
            .remove("table_definitions")
            .unwrap();
        let graph = json!({"table_definitions":{"NEW_BOARD":table_definitions},"project_config":{"version":2,"board_types":[board],"root":{"type":"NEW_BOARD","quantity":1},"mounts":[]},"process_points":data.process,"collect_points":data.collect,"transmit_points":data.transmit});
        let errors: Vec<_> = crate::topology_validation::validate(&graph)["issues"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["level"] == "error")
            .cloned()
            .collect();
        assert!(errors.is_empty(), "{errors:?}");
        let files = crate::native_points::generate(&graph);
        assert!(
            files
                .keys()
                .any(|name| name.starts_with("board_types/NEW_BOARD/"))
        );
        let mut conflict = graph.clone();
        conflict["collect_points"][1]["address"] = conflict["collect_points"][0]["address"].clone();
        conflict["collect_points"][1]["upp_model"] =
            conflict["collect_points"][0]["upp_model"].clone();
        assert!(
            crate::native_protocol::validate(&conflict)
                .iter()
                .any(|i| i["code"] == "overlap")
        );
    }
}
