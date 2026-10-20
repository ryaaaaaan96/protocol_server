// Frozen regression oracle for the pre-JSON importer; never compiled into the server.
//! UPM import keeps receiver sigIDs separate from DSP and CSU sigIDs.
use crate::{
    error::{AppError, Result},
    model::{identifier, snake},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct UpmImport {
    pub process: Vec<Value>,
    pub collect: Vec<Value>,
    pub transmit: Vec<Value>,
    pub warnings: Vec<String>,
}
const LOCAL: &str = "UPM单板测点";
const DSP: &str = "UPM-DSP采集数据";
const UPP: &str = "CSU-UPM采集数据";

fn cell<'a>(row: &'a Value, col: &str) -> &'a str {
    row["cells"]["values"][col].as_str().unwrap_or("").trim()
}
fn error(row: &Value, message: impl AsRef<str>) -> AppError {
    AppError::bad(format!(
        "{}!{}：{}",
        row["sheet"].as_str().unwrap_or("UPM"),
        row["row_number"],
        message.as_ref()
    ))
}
fn integer(row: &Value, col: &str) -> Result<i64> {
    cell(row, col)
        .parse::<i64>()
        .map_err(|_| error(row, format!("{col} 列必须有有效的整数结果")))
}
fn optional_integer(row: &Value, col: &str) -> Result<Value> {
    if matches!(cell(row, col), "" | "※") {
        Ok(Value::Null)
    } else {
        Ok(json!(integer(row, col)?))
    }
}
fn scale(row: &Value, col: &str) -> Result<f64> {
    let value = if cell(row, col).is_empty() {
        1.
    } else {
        cell(row, col)
            .parse::<f64>()
            .map_err(|_| error(row, "精度无效"))?
    };
    if !value.is_finite() || value <= 0. {
        return Err(error(row, "精度必须为有限正数"));
    }
    Ok(value)
}
fn signal_id(row: &Value, col: &str, symbols: &BTreeMap<String, i64>) -> Result<Value> {
    let raw = cell(row, col);
    if matches!(raw, "" | "※" | "0") {
        return Ok(Value::Null);
    }
    let id = raw
        .parse::<i64>()
        .ok()
        .or_else(|| symbols.get(raw).copied())
        .filter(|n| (1..=65535).contains(n))
        .ok_or_else(|| error(row, format!("无法解析 sigID {raw}")))?;
    Ok(json!(id))
}
fn enumeration(row: &Value, col: &str) -> Result<String> {
    let value = snake(cell(row, col));
    if !identifier(&value) {
        return Err(error(row, "缺少合法枚举"));
    }
    Ok(value)
}
fn point(row: &Value, group: &str, name: &str, en: &str, typ: &str, length: i64) -> Result<Value> {
    let width = match typ {
        "U8" | "STRING" => 1,
        "U16" | "S16" => 2,
        "U32" | "S32" | "F32" => 4,
        _ => return Err(error(row, "不支持的数据类型")),
    };
    if length <= 0 || length > 65535 || length % width != 0 {
        return Err(error(row, "数据类型与长度不一致"));
    }
    let mut value = crate::native_points::defaults("process");
    value["board_key"] = json!("UPM");
    value["group_key"] = json!(group);
    value["name"] = json!(name);
    value["enum_name"] = json!(en);
    value["internal_type"] = json!(typ);
    value["element_count"] = json!(length / width);
    value["byte_length"] = json!(length);
    value["source_sheet"] = row["sheet"].clone();
    value["source_row"] = row["row_number"].clone();
    value["display_order"] = row["row_number"].clone();
    value["metadata"] = json!({"source_cells":row["cells"],
        "source_rows":[{"sheet":row["sheet"],"row_number":row["row_number"]}]});
    Ok(value)
}
fn mapping(row: &Value, kind: &str, point: &Value, endpoint: &str) -> Value {
    let mut value = crate::native_points::defaults(kind);
    value["board_key"] = json!("UPM");
    value["process_group"] = point["group_key"].clone();
    value["process_enum"] = point["enum_name"].clone();
    value["name"] = point["name"].clone();
    value["endpoint_key"] = json!(endpoint);
    value["wire_type"] = point["internal_type"].clone();
    value["wire_length"] = point["byte_length"].clone();
    value["source_sheet"] = row["sheet"].clone();
    value["source_row"] = row["row_number"].clone();
    value["display_order"] = row["row_number"].clone();
    // Cached worksheet values stay with each mapping. Full formula provenance
    // is retained once on the process template and in the source workbook.
    value["metadata"] = json!({"source_cells":{"values":row["cells"]["values"]}});
    value
}

pub fn parse_workbook(bytes: Vec<u8>) -> Result<UpmImport> {
    let rows = crate::dsp_workbook::workbook_rows(bytes, &[LOCAL, DSP, UPP, "平台公共测点映射表"])?;
    parse(&rows)
}
fn parse(rows: &[Value]) -> Result<UpmImport> {
    let mut out = UpmImport {
        process: vec![],
        collect: vec![],
        transmit: vec![],
        warnings: vec![],
    };
    let symbols: BTreeMap<_, _> = rows
        .iter()
        .filter(|r| r["sheet"] == "平台公共测点映射表")
        .map(|r| Ok((cell(r, "A").to_owned(), integer(r, "B")?)))
        .collect::<Result<_>>()?;
    let mut local = BTreeMap::<String, usize>::new();
    for row in rows.iter().filter(|r| r["sheet"] == LOCAL) {
        let en = enumeration(row, "Q")?;
        let mut p = point(
            row,
            "LOCAL",
            cell(row, "B"),
            &en,
            cell(row, "I"),
            integer(row, "K")?,
        )?;
        p["sig_id"] = signal_id(row, "P", &symbols)?;
        for (key, col) in [
            ("default_value", "D"),
            ("max_value", "E"),
            ("min_value", "F"),
            ("unit", "G"),
            ("flags", "L"),
            ("callback", "M"),
            ("notes", "U"),
        ] {
            if !cell(row, col).is_empty() {
                p[key] = json!(cell(row, col));
            }
        }
        p["metadata"]["source_variable"] = json!(cell(row, "Q"));
        p["metadata"]["source_sig_id"] = json!(cell(row, "P"));
        p["metadata"]["original_ranges"] = json!({"default_value":p["default_value"],"min_value":p["min_value"],"max_value":p["max_value"],
            "internal_type":p["internal_type"],"byte_length":p["byte_length"]});
        if let Some(&index) = local.get(&en) {
            let original = &mut out.process[index];
            for key in [
                "sig_id",
                "internal_type",
                "byte_length",
                "default_value",
                "min_value",
                "max_value",
                "flags",
                "callback",
                "unit",
            ] {
                if original[key] != p[key] {
                    return Err(error(
                        row,
                        format!("重复内部枚举 {en} 的 {key} 不一致，不能合并"),
                    ));
                }
            }
            original["metadata"]["source_rows"]
                .as_array_mut()
                .unwrap()
                .push(json!({"sheet":row["sheet"],"row_number":row["row_number"]}));
        } else {
            local.insert(en.clone(), out.process.len());
            out.process.push(p.clone());
        }
        if !cell(row, "O").is_empty() {
            let mut m = mapping(row, "forward", &p, "MODBUS_SERVICE");
            m["upp_model"] = json!(0);
            m["address"] = json!(integer(row, "O")?);
            m["scale"] = json!(scale(row, "H")?);
            m["access"] = json!(if cell(row, "J").is_empty() {
                "RO"
            } else {
                cell(row, "J")
            });
            // The source's explicit register bank takes precedence over access.
            m["register_type"] = json!(if cell(row, "U").contains("寄存器类型=0x04") {
                "INPUT"
            } else if cell(row, "U").contains("寄存器类型=0x03") {
                "HOLDING"
            } else if cell(row, "J") == "RO" {
                "INPUT"
            } else {
                "HOLDING"
            });
            m["metadata"]["notes"] = json!(cell(row, "U"));
            out.transmit.push(m);
        }
    }
    let mut dsp_enums = BTreeMap::new();
    for row in rows.iter().filter(|r| r["sheet"] == DSP) {
        let en = enumeration(row, "B")?;
        if dsp_enums.insert(en.clone(), ()).is_some() {
            return Err(error(row, "DSP 采集枚举重复"));
        }
        let mut p = point(
            row,
            "DSP",
            cell(row, "A"),
            &en,
            cell(row, "C"),
            integer(row, "E")?,
        )?;
        p["sig_id"] = signal_id(row, "U", &symbols)?;
        for (key, col) in [
            ("default_value", "F"),
            ("max_value", "G"),
            ("min_value", "H"),
            ("unit", "I"),
            ("notes", "W"),
        ] {
            // STRING columns in the worksheet carry numeric placeholders.
            if p["internal_type"] != "STRING" || !["max_value", "min_value"].contains(&key) {
                p[key] = json!(cell(row, col));
            }
        }
        for (key, col) in [("flags", "P"), ("callback", "T")] {
            if !matches!(cell(row, col), "" | "※") {
                p[key] = json!(cell(row, col));
            }
        }
        p["metadata"]["source_variable"] = json!(cell(row, "B"));
        p["metadata"]["source_sig_id"] = json!(cell(row, "U"));
        p["metadata"]["original_ranges"] = json!({"default_value":p["default_value"],"min_value":p["min_value"],"max_value":p["max_value"],
            "internal_type":p["internal_type"],"byte_length":p["byte_length"]});
        let mut c = mapping(row, "collect", &p, "DSP_UPP");
        c["upp_model"] = json!(integer(row, "N")?);
        c["address"] = json!(integer(row, "O")?);
        c["scale"] = json!(scale(row, "K")?);
        c["access"] = json!(cell(row, "J"));
        c["acquisition_mode"] = json!(if cell(row, "L").starts_with('1') {
            "upload"
        } else {
            "poll"
        });
        for (key, col) in [
            ("poll_interval", "Q"),
            ("set_priority", "R"),
            ("scan_priority", "S"),
        ] {
            c[key] = optional_integer(row, col)?;
        }
        out.collect.push(c);
        if !cell(row, "V").is_empty() {
            let mut m = mapping(row, "forward", &p, "MODBUS_SERVICE");
            m["upp_model"] = json!(0);
            m["address"] = json!(integer(row, "V")?);
            m["scale"] = json!(scale(row, "K")?);
            m["access"] = json!(cell(row, "J"));
            // DSP Modbus offsets form one contiguous register map.
            m["register_type"] = json!("HOLDING");
            out.transmit.push(m);
        }
        out.process.push(p);
    }
    for row in rows
        .iter()
        .filter(|r| r["sheet"] == UPP && cell(r, "A") == "UPM")
    {
        let en = enumeration(row, "C")?;
        let p = local
            .get(&en)
            .map(|i| &out.process[*i])
            .ok_or_else(|| error(row, format!("找不到 UPM 本地枚举 {en}")))?;
        if p["internal_type"] != cell(row, "D") || p["byte_length"] != integer(row, "F")? {
            return Err(error(row, "UPP 对外类型/长度与 UPM 本地内部点不一致"));
        }
        let mut m = mapping(row, "forward", p, "UPP_SERVICE");
        m["upp_model"] = json!(integer(row, "O")?);
        m["address"] = json!(integer(row, "P")?);
        m["scale"] = json!(scale(row, "L")?);
        m["access"] = json!(cell(row, "K"));
        // V is CSU's receiver sigID, never UPM's internal sigID.
        m["metadata"]["receiver_sig_id"] = json!(cell(row, "V"));
        out.transmit.push(m);
    }
    if local.is_empty() || out.collect.is_empty() {
        return Err(AppError::bad("UPM 本地或 DSP 采集工作表为空"));
    }
    out.warnings
        .push("重复本地枚举合并为一个内部点，保留各自 Modbus 转发地址和所有源行。".into());
    out.warnings
        .push("※ 和空 sigID/轮询参数保留为空；CSU 来源行不属于 UPM，未导入。".into());
    out.warnings.push("Modbus 地址按工作簿原值；DSP 组按设备 modbus_base 加偏移展开，字节序初始为 0，须核对固件。".into());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workbook_keeps_local_aliases_and_receiver_ownership() {
        let data =
            parse_workbook(std::fs::read("config/dc-ups/sources/DC-UPS测点数据表.xlsx").unwrap())
                .unwrap();
        assert_eq!(
            data.process
                .iter()
                .filter(|p| p["group_key"] == "LOCAL")
                .count(),
            161
        );
        assert_eq!(data.collect.len(), 445);
        assert_eq!(
            data.transmit
                .iter()
                .filter(|p| p["endpoint_key"] == "UPP_SERVICE")
                .count(),
            29
        );
        assert_eq!(
            data.collect
                .iter()
                .filter(|p| p["acquisition_mode"] == "upload")
                .count(),
            403
        );
        assert!(
            data.process
                .iter()
                .filter(|p| p["group_key"] == "DSP" && p["sig_id"].is_null())
                .count()
                == 404
        );
        assert_eq!(
            data.transmit
                .iter()
                .filter(|p| p["process_enum"] == "LOCAL_SIG_DSP_ON_LINE_NUM")
                .count(),
            3
        );
        let source = data
            .process
            .iter()
            .find(|p| p["enum_name"] == "UPM_SIG_LOAD_VOL")
            .unwrap();
        assert_ne!(source["sig_id"], 2001);
        let config: Value =
            serde_json::from_slice(&std::fs::read("config/dc-ups/project.json").unwrap()).unwrap();
        let definitions =
            crate::project_files::ProjectFiles::load_from(std::path::Path::new("config"))
                .unwrap()
                .definition(Some("dc-ups"))
                .unwrap()["boards"]
                .clone();
        let mut graph = json!({"project_config":config["topology"],"table_definitions":definitions,"process_points":data.process,"collect_points":data.collect,"transmit_points":data.transmit});
        let mut ids = BTreeMap::new();
        for (index, p) in graph["process_points"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            p["id"] = json!(index + 1);
            p["project_id"] = json!(1);
            ids.insert(
                (p["group_key"].to_string(), p["enum_name"].to_string()),
                index + 1,
            );
        }
        for table in ["collect_points", "transmit_points"] {
            for (index, p) in graph[table].as_array_mut().unwrap().iter_mut().enumerate() {
                p["id"] = json!(index + 1);
                p["project_id"] = json!(1);
                p["process_point_id"] = json!(
                    ids[&(
                        p["process_group"].to_string(),
                        p["process_enum"].to_string()
                    )]
                );
            }
        }
        let errors: Vec<_> = crate::native_points::validate(&graph)
            .into_iter()
            .filter(|i| i["level"] == "error")
            .collect();
        assert!(errors.is_empty(), "{}", json!(errors));
    }
}
