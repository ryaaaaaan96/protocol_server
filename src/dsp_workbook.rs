//! Import DSP definitions without treating the ARM collector's signal IDs as DSP IDs.
//!
//! `UPM-DSP采集数据` describes the wire contract exposed by DSP. Its cached model,
//! offset, type and scale are imported directly; ARM polling/configuration columns
//! belong to the other endpoint and are deliberately not copied into DSP rows.

use crate::{
    error::{AppError, Result},
    model::{identifier, snake},
};
use calamine::{Reader, Xlsx};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Cursor};

const PROCESS_SHEET: &str = "DSP内部数据";
const TRANSMIT_SHEET: &str = "UPM-DSP采集数据";
const MAX_POINTS: usize = 10_000;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct DspImport {
    pub process: Vec<Value>,
    pub transmit: Vec<Value>,
}

fn location(row: &Value) -> String {
    format!(
        "{}!{}",
        row["sheet"].as_str().unwrap_or("DSP 工作表"),
        row["row_number"]
    )
}

fn invalid(row: &Value, message: impl AsRef<str>) -> AppError {
    AppError::bad(format!("{}：{}", location(row), message.as_ref()))
}

fn cell<'a>(row: &'a Value, column: &str) -> &'a str {
    row["cells"]["values"][column]
        .as_str()
        .unwrap_or_default()
        .trim()
}

fn required<'a>(row: &'a Value, column: &str, label: &str) -> Result<&'a str> {
    let value = cell(row, column);
    if value.is_empty() {
        return Err(invalid(
            row,
            format!("{column} 列 {label} 缺少值；公式单元格需要有效的计算结果"),
        ));
    }
    Ok(value)
}

fn integer(row: &Value, column: &str, label: &str, min: i64, max: i64) -> Result<i64> {
    let value = required(row, column, label)?;
    let parsed = value.parse::<i64>().ok().or_else(|| {
        value
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && n.fract() == 0. && *n >= min as f64 && *n <= max as f64)
            .map(|n| n as i64)
    });
    parsed.filter(|n| (min..=max).contains(n)).ok_or_else(|| {
        invalid(
            row,
            format!("{column} 列 {label} 必须为 {min}～{max} 的整数"),
        )
    })
}

fn source_row(row: &Value) -> Result<i64> {
    row["row_number"]
        .as_i64()
        .filter(|n| (2..=i32::MAX as i64).contains(n))
        .ok_or_else(|| invalid(row, "源行号无效"))
}

fn enum_name(row: &Value) -> Result<String> {
    let raw = required(row, "B", "变量名 / 枚举")?;
    let name = snake(raw);
    if !identifier(&name) {
        return Err(invalid(row, format!("变量名 {raw} 无法转换为合法枚举")));
    }
    Ok(name)
}

fn type_length(kind: &str) -> Option<i64> {
    match kind {
        "U8" => Some(1),
        "U16" | "S16" => Some(2),
        "U32" | "S32" | "F32" => Some(4),
        _ => None,
    }
}

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

/// A DSP-only import must not parse or validate unrelated UPM worksheets.
pub fn parse_workbook(bytes: Vec<u8>) -> Result<DspImport> {
    parse(&workbook_rows(bytes)?)
}

fn workbook_rows(bytes: Vec<u8>) -> Result<Vec<Value>> {
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
    for sheet in [PROCESS_SHEET, TRANSMIT_SHEET] {
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
            if count > MAX_POINTS {
                return Err(AppError::bad(format!(
                    "{sheet} 点数不能超过 {MAX_POINTS} 条"
                )));
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

pub fn parse(rows: &[Value]) -> Result<DspImport> {
    let mut process = Vec::new();
    let mut by_enum = BTreeMap::new();
    for row in rows.iter().filter(|r| r["sheet"] == PROCESS_SHEET) {
        if process.len() == MAX_POINTS {
            return Err(invalid(row, "DSP 内部点数不能超过 10000 条"));
        }
        let name = required(row, "A", "数据名称")?;
        let en = enum_name(row)?;
        if by_enum.contains_key(&en) {
            return Err(invalid(row, format!("DSP 内部变量枚举 {en} 重复")));
        }
        let internal_type = required(row, "C", "内部类型")?
            .trim_start_matches("Sys_")
            .to_uppercase();
        let element_length = type_length(&internal_type)
            .ok_or_else(|| invalid(row, format!("不支持的 DSP 内部类型 {internal_type}")))?;
        let declared_length = integer(row, "F", "元素字节数", 1, 65535)?;
        if declared_length != element_length {
            return Err(invalid(
                row,
                format!("内部类型 {internal_type} 的元素字节数应为 {element_length}"),
            ));
        }
        let element_count = integer(row, "G", "数组元素数", 1, 65535)?;
        let byte_length = element_length
            .checked_mul(element_count)
            .filter(|n| *n <= 65535)
            .ok_or_else(|| invalid(row, "内部数据总字节数超出 1～65535 范围"))?;
        let source_row = source_row(row)?;
        let point = json!({
            "board_key": "DSP",
            "group_key": "LOCAL",
            "name": name,
            "enum_name": en,
            "sig_id": null,
            "internal_type": internal_type,
            "element_count": element_count,
            "byte_length": byte_length,
            "unit": cell(row, "L"),
            "default_value": cell(row, "I"),
            "min_value": cell(row, "K"),
            "max_value": cell(row, "J"),
            "boot_restore": false,
            "manual_restore": false,
            "process_enabled": true,
            "flags": "0",
            "callback": "NULL",
            "display_order": process.len() + 1,
            "notes": cell(row, "Y"),
            "source_sheet": PROCESS_SHEET,
            "source_row": source_row,
            "metadata": {
                "source_variable": cell(row, "B"),
                "source_type": cell(row, "C"),
                "enum_table": cell(row, "D"),
                "display_digits": cell(row, "E"),
                "access": cell(row, "M"),
                "ram": cell(row, "N"),
                "flash": cell(row, "O"),
                "eeprom": cell(row, "P"),
                "calibration": cell(row, "Q"),
                "structure": cell(row, "R"),
                "cpu": cell(row, "S"),
                "upload_level": cell(row, "V"),
                "category": cell(row, "W"),
                "source_cells": row["cells"]
            }
        });
        by_enum.insert(en, process.len());
        process.push(point);
    }
    if process.is_empty() {
        return Err(AppError::bad("DSP内部数据 工作表没有有效的内部点记录"));
    }

    let mut transmit = Vec::new();
    // Multiple wire mappings may reference one internal point. Only their wire
    // address ranges must be distinct within each UPP model on this endpoint.
    let mut address_ranges = BTreeMap::<i64, Vec<(i64, i64, i64)>>::new();
    for row in rows.iter().filter(|r| r["sheet"] == TRANSMIT_SHEET) {
        if transmit.len() == MAX_POINTS {
            return Err(invalid(row, "DSP 转发点数不能超过 10000 条"));
        }
        let name = required(row, "A", "数据名称")?;
        let en = enum_name(row)?;
        let point = by_enum
            .get(&en)
            .map(|index| &process[*index])
            .ok_or_else(|| invalid(row, format!("转发枚举 {en} 未找到对应 DSP 内部变量")))?;
        let upp_model = integer(row, "N", "UPP 模型号", 1, 65535)?;
        let expected_model = crate::dsp_sheet::upp_model(point)
            .ok_or_else(|| invalid(row, format!("转发枚举 {en} 的内部点缺少有效数据分类")))?;
        if upp_model != expected_model {
            return Err(invalid(
                row,
                format!(
                    "UPP 模型号 {upp_model} 与内部数据分类「{}」推导的 {expected_model} 不一致",
                    crate::dsp_sheet::category(point)
                ),
            ));
        }
        let address = integer(row, "O", "UPP 偏移", 0, 65535)?;
        let wire_type = required(row, "C", "通信类型")?.to_uppercase();
        if wire_type != "STRING" && type_length(&wire_type).is_none() {
            return Err(invalid(row, format!("不支持的通信类型 {wire_type}")));
        }
        let wire_length = integer(row, "E", "通信字节数", 1, 65535)?;
        if wire_length != point["byte_length"].as_i64().unwrap() {
            return Err(invalid(
                row,
                format!("转发枚举 {en} 的通信字节数与内部数据总字节数不一致"),
            ));
        }
        if type_length(&wire_type).is_some_and(|length| wire_length != length) {
            return Err(invalid(row, "通信类型与通信字节数不匹配"));
        }
        let scale = required(row, "K", "协议系数")?
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n > 0.)
            .ok_or_else(|| invalid(row, "协议系数必须是大于零的有限数值"))?;
        let access = required(row, "J", "读写权限")?;
        if !["RO", "RW", "WO"].contains(&access) {
            return Err(invalid(row, "读写权限必须是 RO / RW / WO"));
        }
        let internal_type = point["internal_type"].as_str().unwrap();
        let conversion = if point["element_count"].as_i64().unwrap() > 1 {
            if wire_type != "STRING" || scale != 1. {
                return Err(invalid(row, "数组转发要求 STRING 通信类型且协议系数为 1"));
            }
            "array_bytes"
        } else if internal_type == wire_type {
            if scale != 1. {
                return Err(invalid(row, "直接映射的协议系数必须为 1"));
            }
            "identity"
        } else if internal_type == "F32" && wire_type == "S32" {
            "fixed_point"
        } else {
            return Err(invalid(
                row,
                format!("不支持内部类型 {internal_type} 到通信类型 {wire_type} 的转换"),
            ));
        };
        let end = address + wire_length;
        if end > 65536 {
            return Err(invalid(row, "UPP 地址和长度超出 16 位地址空间"));
        }
        let source_row = source_row(row)?;
        let model_ranges = address_ranges.entry(upp_model).or_default();
        if let Some((_, _, other_row)) = model_ranges
            .iter()
            .find(|(start, previous_end, _)| address < *previous_end && *start < end)
        {
            return Err(invalid(
                row,
                format!("UPP 模型 {upp_model} 的地址区间与第 {other_row} 行重叠"),
            ));
        }
        model_ranges.push((address, end, source_row));
        transmit.push(json!({
            "board_key": "DSP",
            "endpoint_key": "UPP_SERVICE",
            "process_enum": en,
            "name": name,
            "upp_model": upp_model,
            "address": address,
            "wire_type": wire_type,
            "wire_length": wire_length,
            "scale": scale,
            "access": access,
            "byte_order": 0,
            "conversion": conversion,
            "enabled": true,
            "display_order": transmit.len() + 1,
            "source_sheet": TRANSMIT_SHEET,
            "source_row": source_row
        }));
    }
    if transmit.is_empty() {
        return Err(AppError::bad(
            "UPM-DSP采集数据 工作表没有有效的 DSP 转发记录",
        ));
    }
    Ok(DspImport { process, transmit })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeSet,
        io::{Read, Write},
        sync::OnceLock,
    };

    fn fixture() -> Vec<Value> {
        static ROWS: OnceLock<Vec<Value>> = OnceLock::new();
        ROWS.get_or_init(|| {
            workbook_rows(include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec())
                .unwrap()
        })
        .clone()
    }

    fn row<'a>(rows: &'a mut [Value], sheet: &str, variable: &str) -> &'a mut Value {
        rows.iter_mut()
            .find(|r| r["sheet"] == sheet && cell(r, "B") == variable)
            .unwrap()
    }

    #[test]
    fn imports_all_internal_points_and_only_declared_transmit_rows() {
        let data = parse(&fixture()).unwrap();
        assert_eq!(data.process.len(), 552);
        assert_eq!(data.transmit.len(), 445);
        assert!(data.process.iter().all(|p| p["sig_id"].is_null()));
        let linked: BTreeSet<_> = data
            .transmit
            .iter()
            .map(|p| p["process_enum"].as_str().unwrap())
            .collect();
        assert_eq!(
            data.process
                .iter()
                .filter(|p| !linked.contains(p["enum_name"].as_str().unwrap()))
                .count(),
            107
        );
        assert_eq!(
            data.transmit
                .iter()
                .filter(|p| p["conversion"] == "fixed_point")
                .count(),
            276
        );
        assert_eq!(
            data.transmit
                .iter()
                .filter(|p| p["conversion"] == "array_bytes")
                .count(),
            4
        );
        assert_eq!(
            data.process
                .iter()
                .filter(|p| p["internal_type"] == "F32")
                .count(),
            345
        );
        let product = data
            .process
            .iter()
            .find(|p| p["enum_name"] == "PARAM_PRODUCT_TYPE")
            .unwrap();
        assert_eq!(product["internal_type"], "U16");
        assert_eq!(product["element_count"], 15);
        assert_eq!(product["byte_length"], 30);
        assert_eq!(product["metadata"]["cpu"], "CPU2");
        assert_eq!(product["metadata"]["flash"], "Y");
    }

    #[test]
    fn preserves_sheet_offsets_instead_of_reconstructing_source_order() {
        let data = parse(&fixture()).unwrap();
        for (en, model, address) in [
            ("GRID_FREQUENCY", 103, 14),
            ("RECT_PRECHARGE_THRESH", 103, 22),
            ("PARAM_PRODUCT_TYPE", 1, 48),
            ("PARAM_VEHICLE_TYPE", 2, 62),
        ] {
            let mapping = data
                .transmit
                .iter()
                .find(|p| p["process_enum"] == en)
                .unwrap();
            assert_eq!(mapping["upp_model"], model);
            assert_eq!(mapping["address"], address);
        }
        let mut rows = fixture();
        row(&mut rows, TRANSMIT_SHEET, "GridFrequency")["cells"]["values"]["O"] = json!("2000");
        let data = parse(&rows).unwrap();
        let mapping = data
            .transmit
            .iter()
            .find(|p| p["process_enum"] == "GRID_FREQUENCY")
            .unwrap();
        assert_eq!(mapping["address"], 2000);
    }

    #[test]
    fn ignores_arm_ids_and_polling_columns() {
        let original = parse(&fixture()).unwrap();
        let mut rows = fixture();
        for r in rows.iter_mut().filter(|r| r["sheet"] == TRANSMIT_SHEET) {
            for column in ["P", "Q", "R", "S", "T", "U", "V"] {
                r["cells"]["values"][column] = json!("not a DSP parameter");
            }
        }
        let changed = parse(&rows).unwrap();
        assert_eq!(changed.process, original.process);
        assert_eq!(changed.transmit, original.transmit);
    }

    #[test]
    fn allows_multiple_disjoint_transmit_mappings_for_one_internal_point() {
        let mut rows = fixture();
        let mut mapping = row(&mut rows, TRANSMIT_SHEET, "GridFrequency").clone();
        mapping["row_number"] = json!(447);
        mapping["cells"]["values"]["O"] = json!("2000");
        rows.push(mapping);
        let data = parse(&rows).unwrap();
        assert_eq!(data.process.len(), 552);
        assert_eq!(data.transmit.len(), 446);
        assert_eq!(
            data.transmit
                .iter()
                .filter(|p| p["process_enum"] == "GRID_FREQUENCY")
                .count(),
            2
        );
    }

    #[test]
    fn rejects_missing_and_ambiguous_internal_references() {
        let mut rows = fixture();
        row(&mut rows, TRANSMIT_SHEET, "GridFrequency")["cells"]["values"]["B"] =
            json!("NoSuchInternalPoint");
        assert!(
            parse(&rows)
                .unwrap_err()
                .1
                .contains("未找到对应 DSP 内部变量")
        );

        let mut rows = fixture();
        let mut duplicate = row(&mut rows, PROCESS_SHEET, "GridFrequency").clone();
        duplicate["row_number"] = json!(554);
        duplicate["cells"]["values"]["B"] = json!("GRID_FREQUENCY");
        rows.push(duplicate);
        assert!(
            parse(&rows)
                .unwrap_err()
                .1
                .contains("枚举 GRID_FREQUENCY 重复")
        );
    }

    #[test]
    fn rejects_missing_sheet_addresses_and_address_collisions() {
        let mut rows = fixture();
        row(&mut rows, TRANSMIT_SHEET, "GridFrequency")["cells"]["values"]["O"] = json!("");
        assert!(parse(&rows).unwrap_err().1.contains("UPP 偏移 缺少值"));

        let mut rows = fixture();
        row(&mut rows, TRANSMIT_SHEET, "GridFrequency")["cells"]["values"]["O"] = json!("22");
        assert!(parse(&rows).unwrap_err().1.contains("重叠"));

        let mut rows = fixture();
        row(&mut rows, TRANSMIT_SHEET, "GridFrequency")["cells"]["values"]["O"] = json!("65535");
        assert!(parse(&rows).unwrap_err().1.contains("16 位地址空间"));

        let mut rows = fixture();
        row(&mut rows, TRANSMIT_SHEET, "GridFrequency")["cells"]["values"]["N"] = json!("0");
        assert!(parse(&rows).unwrap_err().1.contains("UPP 模型号"));
    }

    #[test]
    fn rejects_models_that_disagree_with_internal_classification() {
        let mut rows = fixture();
        row(&mut rows, TRANSMIT_SHEET, "GridFrequency")["cells"]["values"]["N"] = json!("99");
        assert!(parse(&rows).unwrap_err().1.contains("推导的 103 不一致"));
        let mut rows = fixture();
        row(&mut rows, PROCESS_SHEET, "GridFrequency")["cells"]["values"]["W"] = json!("");
        assert!(parse(&rows).unwrap_err().1.contains("缺少有效数据分类"));
    }

    #[test]
    fn validates_element_lengths_and_wire_conversions() {
        for (sheet, variable, column, value, message) in [
            (
                PROCESS_SHEET,
                "ParamProductType",
                "F",
                "4",
                "元素字节数应为 2",
            ),
            (PROCESS_SHEET, "ParamProductType", "G", "0", "数组元素数"),
            (PROCESS_SHEET, "ParamProductType", "G", "65535", "总字节数"),
            (TRANSMIT_SHEET, "GridFrequency", "E", "2", "总字节数不一致"),
            (
                TRANSMIT_SHEET,
                "GridFrequency",
                "C",
                "U32",
                "不支持内部类型",
            ),
            (TRANSMIT_SHEET, "GridFrequency", "K", "NaN", "协议系数"),
            (TRANSMIT_SHEET, "GridFrequency", "K", "0", "协议系数"),
            (
                TRANSMIT_SHEET,
                "ParamProductType",
                "K",
                "0.1",
                "数组转发要求",
            ),
            (
                TRANSMIT_SHEET,
                "ParamType",
                "K",
                "0.1",
                "直接映射的协议系数必须为 1",
            ),
            (TRANSMIT_SHEET, "GridFrequency", "J", "ANY", "读写权限"),
        ] {
            let mut rows = fixture();
            row(&mut rows, sheet, variable)["cells"]["values"][column] = json!(value);
            let error = parse(&rows).unwrap_err().1;
            assert!(
                error.contains(message),
                "{sheet}/{variable}/{column}: {error}"
            );
        }
    }

    #[test]
    fn does_not_infer_total_length_from_stale_formula_cells() {
        let mut rows = fixture();
        row(&mut rows, PROCESS_SHEET, "ParamProductType")["cells"]["values"]["H"] =
            json!("stale formula");
        let data = parse(&rows).unwrap();
        assert_eq!(data.process[0]["byte_length"], 30);
    }

    #[test]
    fn reads_dsp_workbook_without_the_legacy_importer() {
        let direct = parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
        )
        .unwrap();
        let from_rows = parse(&fixture()).unwrap();
        assert_eq!(direct.process, from_rows.process);
        assert_eq!(direct.transmit, from_rows.transmit);
    }

    #[test]
    fn requires_only_the_two_dsp_sheets() {
        let source = include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx");
        let mut archive = zip::ZipArchive::new(Cursor::new(source)).unwrap();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if entry.name() == "xl/workbook.xml" {
                let mut xml = String::new();
                entry.read_to_string(&mut xml).unwrap();
                let mut sheets = String::new();
                for sheet in [PROCESS_SHEET, TRANSMIT_SHEET] {
                    let marker = format!("<sheet name=\"{sheet}\"");
                    let start = xml.find(&marker).unwrap();
                    let end = start + xml[start..].find("/>").unwrap() + 2;
                    sheets.push_str(&xml[start..end]);
                }
                let start = xml.find("<sheets>").unwrap() + "<sheets>".len();
                let end = xml.find("</sheets>").unwrap();
                xml.replace_range(start..end, &sheets);
                writer
                    .start_file("xl/workbook.xml", zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(xml.as_bytes()).unwrap();
            } else if !entry.name().starts_with("xl/worksheets/sheet")
                || ["xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"].contains(&entry.name())
            {
                writer.raw_copy_file(entry).unwrap();
            }
        }
        let bytes = writer.finish().unwrap().into_inner();
        let data = parse_workbook(bytes).unwrap();
        assert_eq!(data.process.len(), 552);
        assert_eq!(data.transmit.len(), 445);
    }
}
