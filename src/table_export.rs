//! Spreadsheet files use the same projected table definitions as the web views.
use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
    topology::{rows, strv},
};
use axum::{
    Json,
    extract::{Path, State},
    http::header,
    response::IntoResponse,
};
use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Column {
    pub key: String,
    pub label: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
    pub title: String,
    pub columns: Vec<Column>,
    pub rows: Vec<BTreeMap<String, Value>>,
    #[serde(default)]
    pub context: Value,
}

fn fail(message: impl std::fmt::Display) -> AppError {
    AppError::bad(format!("导出失败：{message}"))
}
fn validate(table: &Table) -> Result<()> {
    if table.title.is_empty()
        || table.title.len() > 1000
        || table.columns.is_empty()
        || table.columns.len() > 128
        || table.rows.len() > 100_000
        || table.rows.len() * table.columns.len() > 500_000
        || table.context.to_string().len() > 32_768
    {
        return Err(fail(
            "表名、行列数或导出内容超出限制（最多 10 万行、128 列、50 万单元格）",
        ));
    }
    let keys: BTreeSet<_> = table
        .columns
        .iter()
        .map(|column| column.key.as_str())
        .collect();
    if keys.len() != table.columns.len()
        || table.columns.iter().any(|column| {
            column.key.is_empty()
                || column.key.len() > 256
                || column.label.encode_utf16().count() > 32767
        })
    {
        return Err(fail("导出列名无效或重复"));
    }
    for row in &table.rows {
        for (key, value) in row {
            if !keys.contains(key.as_str())
                || value.is_array()
                || value.is_object()
                || value
                    .as_str()
                    .is_some_and(|text| text.encode_utf16().count() > 32767)
            {
                return Err(fail(
                    "单元格须为文本、数字、布尔值或空值，文本最多 32767 个字符",
                ));
            }
        }
    }
    Ok(())
}
fn sheet_name(title: &str, used: &mut BTreeSet<String>) -> String {
    let clean: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "[]:*?/\\".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim_matches('\'');
    let clean = if clean.is_empty() { "Sheet" } else { clean };
    for index in 1.. {
        let suffix = if index == 1 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let limit = 31 - suffix.encode_utf16().count();
        let mut length = 0;
        let mut name: String = clean
            .chars()
            .take_while(|c| {
                length += c.len_utf16();
                length <= limit
            })
            .collect();
        name = name.trim_end_matches('\'').to_owned();
        name.push_str(&suffix);
        if used.insert(name.to_lowercase()) {
            return name;
        }
    }
    unreachable!()
}
pub fn encode(tables: Vec<Table>) -> Result<Vec<u8>> {
    if tables.is_empty()
        || tables.len() > 512
        || tables
            .iter()
            .map(|table| table.rows.len().saturating_mul(table.columns.len()))
            .sum::<usize>()
            > 2_000_000
    {
        return Err(fail("工作簿最多包含 512 张表和 200 万个单元格"));
    }
    let mut book = Workbook::new();
    let mut used = BTreeSet::new();
    let header = Format::new()
        .set_bold()
        .set_text_wrap()
        .set_background_color("#E4F1EF");
    let text = Format::new().set_text_wrap();
    for table in tables {
        validate(&table)?;
        let sheet = book.add_worksheet();
        sheet
            .set_name(sheet_name(&table.title, &mut used))
            .map_err(fail)?;
        sheet.set_freeze_panes(1, 0).map_err(fail)?;
        sheet.set_row_height(0, 32).map_err(fail)?;
        for (col, column) in table.columns.iter().enumerate() {
            sheet
                .write_string_with_format(0, col as u16, &column.label, &header)
                .map_err(fail)?;
            sheet.set_column_width(col as u16, 24).map_err(fail)?;
        }
        for (index, row) in table.rows.iter().enumerate() {
            for (col, column) in table.columns.iter().enumerate() {
                let value = row.get(&column.key).unwrap_or(&Value::Null);
                let line = index as u32 + 1;
                let col = col as u16;
                match value {
                    Value::Null => {
                        sheet.write_blank(line, col, &text).map_err(fail)?;
                    }
                    Value::Bool(value) => {
                        sheet.write_boolean(line, col, *value).map_err(fail)?;
                    }
                    Value::Number(value)
                        if value
                            .to_string()
                            .chars()
                            .filter(char::is_ascii_digit)
                            .count()
                            <= 15 =>
                    {
                        sheet
                            .write_number(line, col, value.as_f64().ok_or(fail("数字无效"))?)
                            .map_err(fail)?;
                    }
                    // Explicit string writes preserve formulas, leading zeros and long IDs as text.
                    _ => {
                        let value = value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string());
                        sheet
                            .write_string_with_format(line, col, &value, &text)
                            .map_err(fail)?;
                    }
                }
            }
        }
        sheet
            .autofilter(
                0,
                0,
                table.rows.len() as u32,
                table.columns.len() as u16 - 1,
            )
            .map_err(fail)?;
    }
    book.save_to_buffer().map_err(fail)
}
async fn attachment(tables: Vec<Table>, filename: String) -> Result<impl IntoResponse> {
    let bytes = tokio::task::spawn_blocking(move || encode(tables))
        .await
        .map_err(fail)??;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_owned(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename={filename}"),
            ),
        ],
        bytes,
    ))
}
pub async fn current(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
    Json(table): Json<Table>,
) -> Result<impl IntoResponse> {
    // This is a read-only file conversion, available to project viewers too.
    let _tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    attachment(vec![table], format!("protocol-{pid}-table.xlsx")).await
}

fn projected_table(
    title: String,
    definition: &Value,
    records: &[Value],
    protocol: &Value,
) -> Result<Table> {
    let applies = |key: &str| {
        definition["fields"][key]["protocols"]
            .as_array()
            .is_none_or(|protocols| protocols.contains(protocol))
    };
    let mut keys = Vec::new();
    let expansion = &definition["presentation"]["row_expansion"];
    if expansion.is_object() {
        for key in rows(expansion, "leading_columns") {
            if let Some(key) = key.as_str() {
                keys.push(key.to_owned());
            }
        }
    }
    for key in rows(definition, "columns")
        .iter()
        .filter_map(Value::as_str)
        .filter(|key| applies(key))
    {
        if !keys.iter().any(|existing| existing == key) {
            keys.push(key.to_owned());
        }
    }
    let columns = keys
        .iter()
        .map(|key| Column {
            key: key.clone(),
            label: definition["fields"][key]["column_label"]
                .as_str()
                .or_else(|| definition["fields"][key]["label"].as_str())
                .unwrap_or(key)
                .to_owned(),
        })
        .collect();
    let mut output = Vec::new();
    for record in records {
        let instances = if let Some(field) = expansion["field"].as_str() {
            let values = record[field]
                .as_array()
                .filter(|values| !values.is_empty())
                .ok_or(fail("设备展开数据缺失"))?;
            values.iter().collect::<Vec<_>>()
        } else {
            vec![&Value::Null]
        };
        for instance in instances {
            if !instance.is_null()
                && (!instance.is_object()
                    || instance.as_object().unwrap().iter().any(|(key, value)| {
                        !keys.contains(key)
                            || [
                                "id",
                                "project_id",
                                "board_key",
                                "group_key",
                                "endpoint_key",
                                "process_point_id",
                                "source_id",
                                "edit_values",
                                "can_edit",
                                "template_id",
                            ]
                            .contains(&key.as_str())
                            || value.is_array()
                            || value.is_object()
                    }))
            {
                return Err(fail("设备展开字段无效"));
            }
            let row = keys
                .iter()
                .map(|key| {
                    let mut value = instance.get(key).unwrap_or(&record[key]).clone();
                    if value.is_null() && ["sig_id", "resolved_sig_id"].contains(&key.as_str()) {
                        value = record
                            .get("source_sig_id")
                            .unwrap_or(&record["metadata"]["source_sig_id"])
                            .clone();
                    }
                    if value.is_array() || value.is_object() {
                        value = Value::String(value.to_string());
                    }
                    (key.clone(), value)
                })
                .collect();
            output.push(row);
        }
    }
    Ok(Table {
        title,
        columns,
        rows: output,
        context: Value::Null,
    })
}
pub async fn project(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<impl IntoResponse> {
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let definitions = crate::table_runtime::bind(&mut tx, pid, &s.project_files).await?;
    let state:Value=sqlx::query_scalar("SELECT jsonb_build_object('project_config',topology_config,'revision',revision,'config_key',config_key) FROM meta.project_state WHERE id=$1").bind(pid).fetch_one(&mut *tx).await?;
    let mut tables = vec![Table {
        title: "项目信息".into(),
        columns: vec![
            Column {
                key: "key".into(),
                label: "项目字段".into(),
            },
            Column {
                key: "value".into(),
                label: "值".into(),
            },
        ],
        rows: vec![
            BTreeMap::from([
                ("key".into(), json!("项目标识")),
                ("value".into(), state["config_key"].clone()),
            ]),
            BTreeMap::from([
                ("key".into(), json!("项目版本")),
                ("value".into(), state["revision"].clone()),
            ]),
        ],
        context: Value::Null,
    }];
    for board in rows(&state["project_config"], "board_types") {
        let code = strv(board, "code");
        if !matches!(board["point_storage"].as_str(), Some("native" | "derived")) {
            continue;
        }
        for kind in ["process", "collect", "forward"] {
            let definition = &definitions[code][kind];
            if definition.is_null() || board["point_storage"] == "derived" && kind != "collect" {
                continue;
            }
            if kind == "collect"
                && !rows(board, "point_endpoints")
                    .iter()
                    .any(|endpoint| endpoint["direction"] == "collect")
            {
                continue;
            }
            let mut data = if board["point_storage"] == "derived" {
                let graph = crate::topology::snapshot(&mut tx, pid, false).await?;
                crate::derived_collection::evaluate(&graph, code, &definition["mapping"])?
            } else {
                crate::point_tables::table_rows(&mut tx, pid, code, kind).await?
            };
            crate::point_order::sort_rows(&mut data, &definition["ordering"]);
            for group in rows(board, "point_groups") {
                if kind == "collect" && group["collect_enabled"] == false {
                    continue;
                }
                let mut endpoints = if kind == "process" {
                    vec![Value::Null]
                } else {
                    rows(board, "point_endpoints")
                        .iter()
                        .filter(|endpoint| {
                            if kind == "collect" {
                                endpoint["direction"] == "collect"
                            } else {
                                endpoint["direction"] != "collect"
                            }
                        })
                        .cloned()
                        .collect::<Vec<_>>()
                };
                if endpoints.is_empty() {
                    endpoints.push(Value::Null);
                }
                for endpoint in endpoints {
                    let selected = data
                        .iter()
                        .filter(|row| {
                            row["group_key"] == group["code"]
                                && (endpoint.is_null() || row["endpoint_key"] == endpoint["code"])
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    let title = format!(
                        "{code}-{}-{}{}",
                        strv(group, "code"),
                        strv(definition, "label"),
                        if endpoint.is_null() {
                            String::new()
                        } else {
                            format!("-{}", strv(&endpoint, "code"))
                        }
                    );
                    tables.push(projected_table(
                        title,
                        definition,
                        &selected,
                        &endpoint["protocol"],
                    )?);
                }
            }
        }
    }
    attachment(tables, format!("protocol-{pid}.xlsx")).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{Data, Reader, Xlsx};
    use std::io::{Cursor, Read};

    #[test]
    fn xlsx_roundtrip_preserves_unicode_types_blanks_and_literal_formulas() {
        let table:Table=serde_json::from_value(json!({"title":"测试/点表","columns":[{"key":"name","label":"数据名称"},{"key":"value","label":"值"}],"rows":[{"name":"=1+1","value":50006},{"name":"前导零","value":"0006"},{"name":"长整数","value":1234567890123456789u64},{"name":"布尔","value":true},{"name":null,"value":null}]})).unwrap();
        let bytes = encode(vec![table]).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("<dimension ref=\"A1:B6\""));
        assert!(xml.contains("<row r=\"6\""));
        let mut book = Xlsx::new(Cursor::new(bytes)).unwrap();
        assert_eq!(book.sheet_names(), ["测试_点表"]);
        let range = book.worksheet_range("测试_点表").unwrap();
        // Calamine omits trailing empty cells; the worksheet XML retains their rows.
        assert_eq!(range.height(), 5);
        assert_eq!(range.get((0, 0)), Some(&Data::String("数据名称".into())));
        assert_eq!(range.get((1, 0)), Some(&Data::String("=1+1".into())));
        assert_eq!(range.get((1, 1)), Some(&Data::Float(50006.)));
        assert_eq!(range.get((2, 1)), Some(&Data::String("0006".into())));
        assert_eq!(
            range.get((3, 1)),
            Some(&Data::String("1234567890123456789".into()))
        );
        assert_eq!(range.get((4, 1)), Some(&Data::Bool(true)));
        assert!(book.worksheet_formula("测试_点表").unwrap().is_empty());
    }
    #[test]
    fn long_sheet_names_remain_unique_and_excel_compatible() {
        let mut names = BTreeSet::new();
        let title = "'点表😀[]:".repeat(12);
        let first = sheet_name(&title, &mut names);
        let second = sheet_name(&title, &mut names);
        assert_ne!(first, second);
        for name in [first, second] {
            assert!(name.encode_utf16().count() <= 31);
            assert!(!name.starts_with('\'') && !name.ends_with('\''));
            assert!(!name.contains(['[', ']', ':']));
        }
    }
    #[test]
    fn table_limits_and_unexpected_fields_are_rejected() {
        for value in [
            json!({"title":"x","columns":[],"rows":[]}),
            json!({"title":"x","columns":[{"key":"x","label":"x"},{"key":"x","label":"duplicate"}],"rows":[]}),
            json!({"title":"x","columns":[{"key":"x","label":"x"}],"rows":[{"x":{"nested":true}}]}),
            json!({"title":"x","columns":[{"key":"x","label":"x"}],"rows":[{"unexpected":"value"}]}),
            json!({"title":"x","columns":[{"key":"x","label":"x"}],"rows":[{"x":"a".repeat(32768)}]}),
        ] {
            assert!(encode(vec![serde_json::from_value(value).unwrap()]).is_err());
        }
    }
    #[test]
    fn projection_uses_declared_columns_protocols_and_calculated_instances() {
        let definition = json!({"columns":["name","address","upp_model"],"fields":{"name":{"label":"名称"},"address":{"column_label":"实际地址"},"upp_model":{"label":"型号","protocols":["UPP"]},"instance_device":{"label":"设备"}},"presentation":{"row_expansion":{"field":"instance_rows","leading_columns":["instance_device"]}}});
        let rows = vec![
            json!({"name":"电压","address":6,"upp_model":99,"instance_rows":[{"instance_device":"DSP1","address":50006},{"instance_device":"DSP2","address":51006}]}),
        ];
        let table = projected_table("x".into(), &definition, &rows, &json!("MODBUS")).unwrap();
        assert_eq!(
            table
                .columns
                .iter()
                .map(|c| c.key.as_str())
                .collect::<Vec<_>>(),
            ["instance_device", "name", "address"]
        );
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[1]["address"], 51006);
        let mut invalid = rows;
        invalid[0]["instance_rows"][0]["process_point_id"] = json!(42);
        assert!(projected_table("x".into(), &definition, &invalid, &json!("MODBUS")).is_err());
    }
}
