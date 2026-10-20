//! DSP worksheet columns projected over native points without changing record identity.
use crate::{
    error::{AppError, Result},
    model::{identifier, snake},
};
use serde_json::{Map, Value, json};

pub const EDIT_FIELDS: &str = "variable_name,sheet_type,enum_table,display_digits,access,ram,flash,eeprom,calibration,structure,cpu,upload_level,category";
pub const READ_FIELDS: &str = "type_length,precision,sheet_data_type,sheet_upp_model,recommended_wire_type,recommended_wire_length,recommended_scale,recommended_conversion";
pub const FORWARD_READ_FIELDS: &str = "category,variable_name,sheet_type,recommended_wire_type,recommended_wire_length,recommended_scale,recommended_conversion";
const METADATA: [(&str, &str); 11] = [
    ("enum_table", "D"),
    ("display_digits", "E"),
    ("access", "M"),
    ("ram", "N"),
    ("flash", "O"),
    ("eeprom", "P"),
    ("calibration", "Q"),
    ("structure", "R"),
    ("cpu", "S"),
    ("upload_level", "V"),
    ("category", "W"),
];
const TYPES: [&str; 6] = ["U8", "U16", "S16", "U32", "S32", "F32"];
const CATEGORIES: [(&str, i64); 6] = [
    ("系统参数1", 1),
    ("系统参数2", 2),
    ("任务级观测量", 99),
    ("中断级观测量", 100),
    ("控制参数设置", 102),
    ("任务级标定量", 103),
];

pub fn is_dsp(board: &Value) -> bool {
    board["code"] == "DSP" || board["model_code"] == "DSP"
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

fn source<'a>(row: &'a Value, key: &str, column: &str) -> &'a Value {
    row["metadata"]
        .get(key)
        .unwrap_or(&row["metadata"]["source_cells"]["values"][column])
}

pub fn category(point: &Value) -> &str {
    source(point, "category", "W").as_str().unwrap_or_default()
}

pub fn upp_model(point: &Value) -> Option<i64> {
    CATEGORIES
        .iter()
        .find(|(name, _)| *name == category(point))
        .map(|(_, model)| *model)
}

fn display_digits(point: &Value) -> i64 {
    let value = source(point, "display_digits", "E");
    value
        .as_i64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|digits| (0..=8).contains(digits))
        .unwrap_or_default()
}

/// Worksheet defaults are suggestions. An explicitly chosen, valid wire type
/// keeps its own compatible length, conversion and scaling defaults.
pub fn wire_defaults(point: &Value, selected: Option<&str>) -> Value {
    let internal = text(point, "internal_type");
    let array = point["element_count"]
        .as_i64()
        .is_some_and(|count| count > 1)
        || internal == "STRING";
    let recommended = if array {
        "STRING"
    } else if internal == "F32" {
        "S32"
    } else {
        internal
    };
    let wire = selected.unwrap_or(recommended);
    let fixed = !array && internal == "F32" && wire == "S32";
    let conversion = if wire == "STRING" {
        "array_bytes"
    } else if fixed {
        "fixed_point"
    } else {
        "identity"
    };
    let length = match wire {
        "U8" => json!(1),
        "U16" | "S16" => json!(2),
        "U32" | "S32" | "F32" => json!(4),
        _ => point["byte_length"].clone(),
    };
    json!({"wire_type":wire,"wire_length":length,
        "scale":if fixed {10_f64.powi(-(display_digits(point) as i32))} else {1.},
        "conversion":conversion})
}

pub fn project_forward(row: &mut Value, point: &Value) {
    let mut point = point.clone();
    project(&mut point);
    for field in ["category", "variable_name", "sheet_type"] {
        row[field] = point[field].clone();
    }
    let recommended = wire_defaults(&point, None);
    for field in ["wire_type", "wire_length", "scale", "conversion"] {
        row[format!("recommended_{field}")] = recommended[field].clone();
    }
}

/// Include editable aliases in both the displayed row and its concurrency baseline.
pub fn project(row: &mut Value) {
    let mut fields = Map::new();
    let original = source(row, "source_variable", "B")
        .as_str()
        .unwrap_or_default();
    let variable = if !original.is_empty() && snake(original) == text(row, "enum_name") {
        original
    } else {
        text(row, "enum_name")
    };
    fields.insert("variable_name".into(), json!(variable));
    let typ = text(row, "internal_type");
    fields.insert("sheet_type".into(), json!(format!("Sys_{typ}")));
    for (key, column) in METADATA {
        let value = source(row, key, column);
        fields.insert(
            key.into(),
            if key == "display_digits" {
                json!(
                    value
                        .as_i64()
                        .or_else(|| value.as_str()?.parse::<i64>().ok())
                        .unwrap_or(0)
                )
            } else {
                json!(value.as_str().unwrap_or_default())
            },
        );
    }
    let element_length = match typ {
        "U8" | "STRING" => 1,
        "U16" | "S16" => 2,
        "U32" | "S32" | "F32" => 4,
        _ => 0,
    };
    fields.insert("type_length".into(), json!(element_length));
    let digits = fields["display_digits"].as_i64().unwrap_or_default();
    fields.insert(
        "precision".into(),
        json!(match digits {
            0 => "1".into(),
            1..=8 => format!("0.{}1", "0".repeat(digits as usize - 1)),
            _ => String::new(),
        }),
    );
    let recommended = wire_defaults(row, None);
    fields.insert("sheet_data_type".into(), recommended["wire_type"].clone());
    for key in ["wire_type", "wire_length", "scale", "conversion"] {
        fields.insert(format!("recommended_{key}"), recommended[key].clone());
    }
    fields.insert(
        "sheet_upp_model".into(),
        upp_model(row).map_or(json!(""), |model| json!(model)),
    );
    if !row["edit_values"].is_object() {
        row["edit_values"] = row.clone();
    }
    for key in EDIT_FIELDS.split(',') {
        row["edit_values"][key] = fields[key].clone();
    }
    row.as_object_mut().unwrap().extend(fields);
}

fn string_field<'a>(key: &str, value: &'a Value) -> Result<&'a str> {
    value
        .as_str()
        .filter(|value| value.len() <= 4096)
        .ok_or_else(|| AppError::bad(format!("{key} 必须为不超过 4096 字节的文本")))
}

/// Resolve only whitelisted worksheet aliases. Source cells remain immutable evidence.
pub fn normalize(fields: &Map<String, Value>, old: &Value) -> Result<Map<String, Value>> {
    if fields.contains_key("metadata") || READ_FIELDS.split(',').any(|key| fields.contains_key(key))
    {
        return Err(AppError::bad("来源元数据和派生列不能直接修改"));
    }
    let mut updates = fields.clone();
    let mut metadata = old["metadata"].as_object().cloned().unwrap_or_default();
    let mut metadata_changed = false;
    if let Some(value) = updates.remove("variable_name") {
        let variable = string_field("variable_name", &value)?.trim();
        let normalized = snake(variable);
        if !identifier(variable) || !identifier(&normalized) {
            return Err(AppError::bad(
                "VariateName 必须为有效变量名，最长 160 个字符",
            ));
        }
        if fields
            .get("enum_name")
            .is_some_and(|value| value != &json!(normalized))
        {
            return Err(AppError::bad("VariateName 与枚举字段不一致"));
        }
        updates.insert("enum_name".into(), json!(normalized));
        metadata.insert("source_variable".into(), json!(variable));
        metadata_changed = true;
    }
    if let Some(value) = updates.remove("sheet_type") {
        let value = string_field("sheet_type", &value)?;
        let typ = value
            .strip_prefix("Sys_")
            .filter(|typ| TYPES.contains(typ))
            .ok_or(AppError::bad(
                "DateType 必须为 Sys_U8 / Sys_U16 / Sys_S16 / Sys_U32 / Sys_S32 / Sys_F32",
            ))?;
        if fields
            .get("internal_type")
            .is_some_and(|value| value != &json!(typ))
        {
            return Err(AppError::bad("DateType 与内部类型字段不一致"));
        }
        updates.insert("internal_type".into(), json!(typ));
    }
    for (key, _) in METADATA {
        let Some(value) = updates.remove(key) else {
            continue;
        };
        if key == "display_digits" {
            if value.as_i64().is_none_or(|value| !(0..=8).contains(&value)) {
                return Err(AppError::bad("DisplayDigit 必须为 0～8 的整数"));
            }
        } else {
            let value = string_field(key, &value)?;
            let valid = value.is_empty()
                || match key {
                    "access" => ["RO", "RW"].contains(&value),
                    "ram" | "flash" | "eeprom" | "calibration" => ["Y", "N"].contains(&value),
                    "cpu" => ["CPU1", "CPU2"].contains(&value),
                    "upload_level" => [
                        "0：不上传",
                        "1：上传至UPM",
                        "2：UPM进行轮询",
                        "3：CSU进行轮询",
                    ]
                    .contains(&value),
                    "category" => CATEGORIES.iter().any(|(category, _)| *category == value),
                    "structure" => identifier(value),
                    _ => true,
                };
            if !valid {
                return Err(AppError::bad(format!(
                    "{key} 的值不符合 DSP内部数据 工作表规则"
                )));
            }
        }
        metadata.insert(key.into(), value);
        metadata_changed = true;
    }
    if metadata_changed {
        updates.insert("metadata".into(), Value::Object(metadata));
    }
    Ok(updates)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn imported() -> Vec<Value> {
        crate::dsp_workbook::parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
        )
        .unwrap()
        .process
    }

    #[test]
    fn all_552_rows_match_the_25_worksheet_columns() {
        let fields = [
            "name",
            "variable_name",
            "sheet_type",
            "enum_table",
            "display_digits",
            "type_length",
            "element_count",
            "byte_length",
            "default_value",
            "max_value",
            "min_value",
            "unit",
            "access",
            "ram",
            "flash",
            "eeprom",
            "calibration",
            "structure",
            "cpu",
            "precision",
            "sheet_data_type",
            "upload_level",
            "category",
            "sheet_upp_model",
            "notes",
        ];
        let rows = imported();
        assert_eq!(rows.len(), 552);
        for mut row in rows {
            project(&mut row);
            for (column, field) in ('A'..='Y').zip(fields) {
                let actual = row[field]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| row[field].to_string());
                let expected = row["metadata"]["source_cells"]["values"][column.to_string()]
                    .as_str()
                    .unwrap_or_default();
                assert_eq!(
                    actual, expected,
                    "sheet row {} column {column} ({field})",
                    row["source_row"]
                );
            }
            for key in EDIT_FIELDS.split(',') {
                assert_eq!(row[key], row["edit_values"][key]);
            }
        }
    }

    #[test]
    fn edits_keep_live_values_identity_and_source_evidence() {
        let mut row = imported().remove(0);
        row["id"] = json!(17);
        let source = row["metadata"]["source_cells"].clone();
        let edits = json!({"variable_name":"UpdatedProduct","sheet_type":"Sys_F32",
            "element_count":1,"display_digits":4,"ram":"Y","category":"任务级标定量",
            "name":"修改后的名称","default_value":"12.50"});
        let updates = normalize(edits.as_object().unwrap(), &row).unwrap();
        assert!(!updates.contains_key("variable_name"));
        assert!(!updates.contains_key("sheet_type"));
        row.as_object_mut().unwrap().extend(updates);
        project(&mut row);
        assert_eq!(row["id"], 17);
        assert!(row["sig_id"].is_null());
        assert_eq!(row["enum_name"], "UPDATED_PRODUCT");
        assert_eq!(row["variable_name"], "UpdatedProduct");
        assert_eq!(row["sheet_type"], "Sys_F32");
        assert_eq!(row["type_length"], 4);
        assert_eq!(row["precision"], "0.0001");
        assert_eq!(row["sheet_data_type"], "S32");
        assert_eq!(row["sheet_upp_model"], 103);
        assert_eq!(row["name"], "修改后的名称");
        assert_eq!(row["default_value"], "12.50");
        assert_eq!(row["metadata"]["source_cells"], source);
        row["enum_name"] = json!("API_RENAMED_POINT");
        project(&mut row);
        assert_eq!(row["variable_name"], "API_RENAMED_POINT");
    }

    #[test]
    fn validates_aliases_and_metadata_types() {
        let row = imported().remove(0);
        for fields in [
            json!({"variable_name":"Renamed","enum_name":"OTHER"}),
            json!({"sheet_type":"Sys_U16","internal_type":"F32"}),
            json!({"sheet_type":"F32"}),
            json!({"variable_name":"bad name"}),
            json!({"display_digits":9}),
            json!({"display_digits":"2"}),
            json!({"ram":true}),
            json!({"flash":"true"}),
            json!({"cpu":"CPU3"}),
            json!({"category":"unknown"}),
            json!({"upload_level":"1"}),
            json!({"metadata":{"source_cells":{}}}),
            json!({"precision":"0.5"}),
            json!({"sheet_data_type":"U16"}),
            json!({"sheet_upp_model":1}),
            json!({"type_length":8}),
        ] {
            assert!(
                normalize(fields.as_object().unwrap(), &row).is_err(),
                "{fields}"
            );
        }
        assert!(
            normalize(
                json!({"variable_name":"Matching","enum_name":"MATCHING",
            "sheet_type":"Sys_U16","internal_type":"U16"})
                .as_object()
                .unwrap(),
                &row
            )
            .is_ok()
        );
        assert!(is_dsp(&json!({"code":"DSP"})));
        assert!(is_dsp(&json!({"code":"DSP2","model_code":"DSP"})));
        assert!(!is_dsp(&json!({"code":"UPM"})));
    }

    #[test]
    fn wire_suggestions_follow_sheet_types_arrays_and_precision() {
        let mut point = json!({"internal_type":"F32","element_count":1,"byte_length":4,
            "metadata":{"display_digits":"3","category":"任务级观测量"}});
        assert_eq!(
            wire_defaults(&point, None),
            json!({"wire_type":"S32","wire_length":4,
            "scale":0.001,"conversion":"fixed_point"})
        );
        assert_eq!(
            wire_defaults(&point, Some("F32")),
            json!({"wire_type":"F32","wire_length":4,
            "scale":1.,"conversion":"identity"})
        );
        assert_eq!(upp_model(&point), Some(99));
        point["element_count"] = json!(3);
        point["byte_length"] = json!(12);
        assert_eq!(
            wire_defaults(&point, None),
            json!({"wire_type":"STRING","wire_length":12,
            "scale":1.,"conversion":"array_bytes"})
        );
        point["internal_type"] = json!("U16");
        point["element_count"] = json!(1);
        point["byte_length"] = json!(2);
        assert_eq!(
            wire_defaults(&point, None),
            json!({"wire_type":"U16","wire_length":2,
            "scale":1.,"conversion":"identity"})
        );
        point["metadata"] = json!({"source_cells":{"values":{"W":"系统参数2","E":"4"}}});
        assert_eq!(upp_model(&point), Some(2));
        point["metadata"]["category"] = json!("");
        assert_eq!(
            upp_model(&point),
            None,
            "explicit empty category must not use stale source cells"
        );
    }

    #[test]
    fn every_transmit_source_supplies_matching_suggestions() {
        let data = crate::dsp_workbook::parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
        )
        .unwrap();
        for mapping in data.transmit {
            let point = data
                .process
                .iter()
                .find(|point| point["enum_name"] == mapping["process_enum"])
                .unwrap();
            assert_eq!(upp_model(point), mapping["upp_model"].as_i64());
            let suggested = wire_defaults(point, None);
            for field in ["wire_type", "wire_length", "conversion"] {
                assert_eq!(
                    suggested[field], mapping[field],
                    "{} {field}",
                    mapping["name"]
                );
            }
            let mut displayed = mapping.clone();
            project_forward(&mut displayed, point);
            assert_eq!(displayed["wire_type"], mapping["wire_type"]);
            assert_eq!(displayed["recommended_wire_type"], suggested["wire_type"]);
            assert_eq!(displayed["category"], category(point));
            assert!(!displayed["variable_name"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn concurrent_metadata_edits_merge_by_field_and_detect_conflicts() {
        let point = json!({"id":7,"board_key":"DSP","enum_name":"SAMPLE",
            "metadata":{"ram":"N","cpu":"CPU2","source_cells":{"values":{"N":"N"}}}});
        let fields = json!({"ram":"Y"});
        let change = crate::topology::Change {
            revision: 1,
            entity: "process_points".into(),
            operation: "update".into(),
            id: Some(7),
            expected: json!({"ram":"N"}),
            values: json!({"board_key":"DSP","fields":fields}),
        };
        let document =
            |point: &Value| crate::change_merge::document(&json!({"process_points":[point]}));
        let apply = |point: &Value| {
            let mut edited = point.clone();
            edited
                .as_object_mut()
                .unwrap()
                .extend(normalize(fields.as_object().unwrap(), point).unwrap());
            edited
        };
        let base = document(&point);
        let patch = json_patch::diff(&base, &document(&apply(&point)));
        let mut current = point.clone();
        current["metadata"]["cpu"] = json!("CPU1");
        let merged =
            crate::change_merge::rebase(&base, &patch, &document(&current), &change, 2).unwrap();
        assert_eq!(merged, document(&apply(&current)));
        current["metadata"]["ram"] = json!("");
        assert!(
            crate::change_merge::rebase(&base, &patch, &document(&current), &change, 2).is_err()
        );
    }
}
