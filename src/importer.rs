use crate::{
    error::{AppError, Result},
    model::{Point, blank, snake},
};
use calamine::{Data, Reader, Xlsx};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Cursor};

#[derive(Clone, Serialize, Deserialize)]
pub struct ImportData {
    pub points: Vec<Point>,
    pub mappings: BTreeMap<String, i32>,
    pub devices: Vec<Value>,
    pub warnings: Vec<String>,
    pub sheets: Vec<String>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
}
fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}
fn txt(d: Option<&Data>) -> String {
    d.map(ToString::to_string)
        .unwrap_or_default()
        .trim()
        .to_owned()
}
fn integer(s: &str) -> Option<i32> {
    let s = s.trim();
    if let Some(s) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        i32::from_str_radix(s, 16).ok()
    } else {
        s.parse::<i32>().ok().or_else(|| {
            s.parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && v.fract() == 0. && *v >= 0. && *v <= 65535.)
                .map(|v| v as i32)
        })
    }
}
pub fn parse(bytes: Vec<u8>) -> Result<ImportData> {
    // Guard decompressed XML size before calamine allocates cells.
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes))
        .map_err(|_| AppError::bad("请上传有效的 .xlsx 工作簿"))?;
    let mut expanded = 0u64;
    for i in 0..archive.len() {
        expanded = expanded.saturating_add(
            archive
                .by_index(i)
                .map_err(|_| AppError::bad("工作簿压缩包损坏"))?
                .size(),
        );
    }
    if expanded > 150_000_000 {
        return Err(AppError::bad("工作簿解压后超过 150 MB"));
    }
    let mut book: Xlsx<_> =
        Xlsx::new(Cursor::new(bytes)).map_err(|e| AppError::bad(format!("无法读取工作簿：{e}")))?;
    let mut out = ImportData {
        points: vec![],
        mappings: BTreeMap::new(),
        devices: vec![],
        warnings: vec![],
        sheets: book.sheet_names(),
        source_rows: vec![],
    };
    for required in [
        "UPM单板测点",
        "UPM-DSP采集数据",
        "平台公共测点映射表",
        "UPM板内Modbus地址分配",
    ] {
        if !out.sheets.iter().any(|s| s == required) {
            return Err(AppError::bad(format!("缺少工作表：{required}")));
        }
    }
    let mapping = book
        .worksheet_range("平台公共测点映射表")
        .map_err(|e| AppError::bad(e.to_string()))?;
    for (i, row) in mapping.rows().enumerate().skip(1) {
        let name = txt(row.first());
        let value = txt(row.get(1));
        if name.is_empty() {
            continue;
        }
        if let Some(id) = integer(&value).filter(|i| (1..=65535).contains(i)) {
            if !crate::model::identifier(&name) {
                return Err(AppError::bad(format!("平台映射第 {} 行符号无效", i + 1)));
            }
            if let Some(old) = out.mappings.insert(name.clone(), id) {
                if old != id {
                    return Err(AppError::bad(format!("平台符号 {name} 的映射值冲突")));
                }
            }
        } else {
            out.warnings
                .push(format!("平台映射第 {} 行无法解析：{name}={value}", i + 1));
        }
    }
    out.devices.push(json!({"name":"本地控制器","code":"CFG_DEV_LOCAL","scope":"LOCAL","base_address":0,"end_address":65535}));
    let ranges = book
        .worksheet_range("UPM板内Modbus地址分配")
        .map_err(|e| AppError::bad(e.to_string()))?;
    for row in ranges.rows().skip(1) {
        let name = txt(row.first());
        if let Some(n) = name
            .strip_prefix("模块")
            .and_then(|v| v.parse::<i32>().ok())
            .filter(|v| (1..=8).contains(v))
        {
            let start = integer(&txt(row.get(1))).ok_or(AppError::bad("模块地址段起点无效"))?;
            let end = integer(&txt(row.get(2))).ok_or(AppError::bad("模块地址段终点无效"))?;
            if start < 0 || end < start || end > 65535 {
                return Err(AppError::bad("模块地址段超出范围"));
            }
            out.devices.push(json!({"name":name,"code":format!("CFG_DEV_DSP{n}"),"scope":"DSP","base_address":start,"end_address":end}));
        }
    }
    for (sheet, scope) in [("UPM单板测点", "LOCAL"), ("UPM-DSP采集数据", "DSP")] {
        // When authoritative sheets exist, reconstruct the formula projection below.
        if scope == "DSP"
            && out.sheets.iter().any(|s| s == "DSP内部数据")
            && out.sheets.iter().any(|s| s == "UPM-DSP手动配置数据")
        {
            continue;
        }
        let range = book
            .worksheet_range(sheet)
            .map_err(|e| AppError::bad(e.to_string()))?;
        let formulas = book
            .worksheet_formula(sheet)
            .map_err(|e| AppError::bad(e.to_string()))?;
        let header: Vec<String> = range
            .rows()
            .next()
            .ok_or(AppError::bad("工作表为空"))?
            .iter()
            .map(|v| norm(&v.to_string()))
            .collect();
        for required in ["数据定义", "ENMU", "数据类型", "数据长度", "signID"] {
            if !header.contains(&norm(required)) {
                return Err(AppError::bad(format!("{sheet} 缺少列：{required}")));
            }
        }
        let col = |name: &str| header.iter().position(|v| v == &norm(name));
        let auto_dsp = scope == "DSP"
            && col("modbus地址").is_some_and(|c| {
                !formulas
                    .get_value((1, c as u32))
                    .map(String::as_str)
                    .unwrap_or("")
                    .is_empty()
            });
        let auto_upp = scope == "DSP"
            && col("UPP偏移").is_some_and(|c| {
                !formulas
                    .get_value((1, c as u32))
                    .map(String::as_str)
                    .unwrap_or("")
                    .is_empty()
            });
        for (idx, row) in range.rows().enumerate().skip(1) {
            let get = |name: &str| txt(col(name).and_then(|c| row.get(c)));
            let name = get("数据定义");
            if name.is_empty() {
                continue;
            }
            let raw:serde_json::Map<String,Value>=header.iter().enumerate().filter(|(_,h)|!h.is_empty()).map(|(c,h)|(h.clone(),json!({"value":txt(row.get(c)),"formula":formulas.get_value((idx as u32,c as u32))}))).collect();
            let data_type = get("数据类型").to_uppercase();
            let length = integer(&get("数据长度"))
                .filter(|v| *v > 0)
                .ok_or(AppError::bad(format!("{sheet}!{}：数据长度无效", idx + 1)))?;
            let address = get("modbus地址");
            let addr_formula = col("modbus地址")
                .and_then(|c| formulas.get_value((idx as u32, c as u32)))
                .is_some_and(|s| !s.is_empty());
            let address_mode = if auto_dsp || addr_formula {
                "auto"
            } else if integer(&address).is_some() {
                "manual"
            } else {
                "none"
            };
            if !blank(&address) && integer(&address).is_none() {
                out.warnings.push(format!(
                    "{sheet}!{}：地址“{address}”未解析，保留在来源信息中",
                    idx + 1
                ));
            }
            let en = snake(&get("ENMU"));
            let upp_offset = if auto_upp {
                match en.as_str() {
                    "PARAM_PRODUCT_TYPE" => Some(48),
                    "PARAM_PRODUCT_CODE" => Some(8),
                    "PARAM_CLIENT_CODE" => Some(24),
                    "PARAM_VEHICLE_TYPE" => Some(62),
                    "PARAM_TYPE" => Some(94),
                    "PARAM_MATRIL_CODE" => Some(96),
                    _ => None,
                }
            } else {
                integer(&get("UPP偏移"))
            };
            let clean = |s: String| if blank(&s) { String::new() } else { s };
            let optional_int = |name: &str| -> Result<i32> {
                let s = get(name);
                if blank(&s) {
                    Ok(0)
                } else {
                    integer(&s).filter(|n| *n >= 0).ok_or(AppError::bad(format!(
                        "{sheet}!{}：{name} 不是非负整数：{s}",
                        idx + 1
                    )))
                }
            };
            let scale_text = get("精度");
            let scale = if blank(&scale_text) {
                1.
            } else {
                scale_text
                    .parse()
                    .map_err(|_| AppError::bad(format!("{sheet}!{}：精度无效", idx + 1)))?
            };
            let p = Point {
                scope: scope.into(),
                ordinal: idx as i32,
                name,
                enum_name: en,
                signal_id: clean(get("signID")),
                data_type,
                byte_length: length,
                access: get("读写权限").to_uppercase(),
                unit: get("单位"),
                scale,
                address_mode: address_mode.into(),
                modbus_address: if address_mode == "manual" {
                    integer(&address)
                } else {
                    None
                },
                upp_model: integer(&get("UPP地址")),
                upp_offset,
                flags: if blank(&get("arm配置参数")) {
                    "0".into()
                } else {
                    get("arm配置参数")
                },
                poll_interval: optional_int("UPP轮询间隔")?,
                set_priority: optional_int("设置优先级")?,
                scan_priority: optional_int("轮询优先级")?,
                callback: if blank(&get("回调函数")) || get("回调函数") == "0" {
                    "NULL".into()
                } else {
                    get("回调函数")
                },
                default_value: clean(get("默认值")),
                min_value: clean(get("数据下限")),
                max_value: clean(get("数据上限")),
                category: if scope == "DSP" {
                    get("UPP模型名称")
                } else {
                    get("数据分类")
                },
                notes: get("备注"),
                source_sheet: sheet.into(),
                source_row: Some((idx + 1) as i32),
                raw_json: Value::Object(raw),
            };
            p.validate()
                .map_err(|e| AppError::bad(format!("{sheet}!{}：{}", idx + 1, e.1)))?;
            out.points.push(p);
        }
    }
    if out.points.is_empty() || out.points.len() > 10000 {
        return Err(AppError::bad("导入测点数量应为 1～10000 条"));
    }
    for sheet in [
        "DSP内部数据",
        "UPM-DSP手动配置数据",
        "UPM单板测点",
        "UPM-DSP采集数据",
        "UPM板内Modbus地址分配",
        "CSU-UPM采集数据",
        "CSU-UPM手动配置数据",
        "CSU本地处理",
        "BMS采样数据",
        "变压器综合侦测板",
        "综合侦测板",
    ] {
        if !out.sheets.iter().any(|s| s == sheet) {
            continue;
        }
        let cells = book
            .worksheet_range(sheet)
            .map_err(|e| AppError::bad(e.to_string()))?;
        let formulas = book
            .worksheet_formula(sheet)
            .map_err(|e| AppError::bad(e.to_string()))?;
        for (i, row) in cells.rows().enumerate().skip(1) {
            if row.iter().all(|v| txt(Some(v)).is_empty()) {
                continue;
            }
            let mut values = serde_json::Map::new();
            let mut fs = serde_json::Map::new();
            for (c, v) in row.iter().enumerate() {
                let key = if c < 26 {
                    ((b'A' + c as u8) as char).to_string()
                } else {
                    format!("A{}", (b'A' + (c - 26) as u8) as char)
                };
                values.insert(key.clone(), json!(txt(Some(v))));
                if let Some(f) = formulas
                    .get_value((i as u32, c as u32))
                    .filter(|f| !f.is_empty())
                {
                    fs.insert(key, json!(f));
                }
            }
            out.source_rows.push(
                json!({"sheet":sheet,"row_number":i+1,"cells":{"values":values,"formulas":fs}}),
            );
        }
    }
    rebuild_dsp(&mut out)?;
    out.warnings.push("DSP 投影从内部数据和手动配置重建，不依赖 UPM-DSP 公式缓存。源数据、ARM 参数和地址窗口拆分保存；CSU、BMS、侦测板的原始行保留为待映射来源。".into());
    if out
        .points
        .iter()
        .any(|p| p.scope == "DSP" && p.address_mode == "auto")
    {
        out.warnings.push("DSP Modbus 偏移改由 SQL 累计字节长度 / 2 计算；UPP 偏移按模型累计，并保留源表六个固定偏移。".into());
    }
    Ok(out)
}

fn rebuild_dsp(out: &mut ImportData) -> Result<()> {
    if !out.source_rows.iter().any(|r| r["sheet"] == "DSP内部数据")
        || !out
            .source_rows
            .iter()
            .any(|r| r["sheet"] == "UPM-DSP手动配置数据")
    {
        return Ok(());
    }
    let get = |v: &Value, k: &str| v[k].as_str().unwrap_or("").trim().to_owned();
    let manual: BTreeMap<String, &Value> = out
        .source_rows
        .iter()
        .filter(|r| r["sheet"] == "UPM-DSP手动配置数据")
        .map(|r| (snake(&get(&r["cells"]["values"], "B")), r))
        .collect();
    let mut points = vec![];
    for r in out
        .source_rows
        .iter()
        .filter(|r| r["sheet"] == "DSP内部数据")
    {
        let v = &r["cells"]["values"];
        let name = get(v, "A");
        let upload = get(v, "V");
        if name.is_empty() || upload.is_empty() || upload.starts_with('0') {
            continue;
        }
        let en = snake(&get(v, "B"));
        let m = manual.get(&en).copied();
        let mv = m.map(|r| &r["cells"]["values"]).unwrap_or(&Value::Null);
        let typ = get(v, "C").trim_start_matches("Sys_").to_uppercase();
        let array = integer(&get(v, "G")).unwrap_or(1);
        let len = integer(&get(v, "F"))
            .and_then(|n| n.checked_mul(array))
            .filter(|n| *n > 0 && *n <= 65535)
            .ok_or(AppError::bad(format!(
                "DSP内部数据第 {} 行长度无法计算",
                r["row_number"]
            )))?;
        let model = match get(v, "W").as_str() {
            "系统参数1" => 1,
            "系统参数2" => 2,
            "任务级观测量" => 99,
            "中断级观测量" => 100,
            "控制参数设置" => 102,
            "任务级标定量" => 103,
            other => {
                return Err(AppError::bad(format!(
                    "DSP 分类「{other}」没有明确的 UPP 模型号规则"
                )));
            }
        };
        let offset = match en.as_str() {
            "PARAM_PRODUCT_TYPE" => Some(48),
            "PARAM_PRODUCT_CODE" => Some(8),
            "PARAM_CLIENT_CODE" => Some(24),
            "PARAM_VEHICLE_TYPE" => Some(62),
            "PARAM_TYPE" => Some(94),
            "PARAM_MATRIL_CODE" => Some(96),
            _ => None,
        };
        let controlled = upload.starts_with('2') || upload.starts_with('3');
        let cfg = |k: &str, default: &str| {
            let value = if controlled {
                get(mv, k)
            } else {
                String::new()
            };
            if blank(&value) {
                default.to_owned()
            } else {
                value
            }
        };
        let cfg_int = |k: &str| {
            integer(&cfg(k, "0")).ok_or(AppError::bad(format!("手动配置 {en} 的 {k} 列不是整数")))
        };
        let digits = integer(&get(v, "E")).unwrap_or(0);
        let p = Point {
            scope: "DSP".into(),
            ordinal: r["row_number"].as_i64().unwrap_or(0) as i32,
            name,
            enum_name: en.clone(),
            signal_id: cfg("H", ""),
            data_type: if array > 1 {
                "STRING".into()
            } else if typ == "F32" {
                "S32".into()
            } else {
                typ
            },
            byte_length: len,
            access: get(v, "M"),
            unit: get(v, "L"),
            scale: 10f64.powi(-digits),
            address_mode: "auto".into(),
            upp_model: Some(model),
            upp_offset: offset,
            flags: cfg("C", "0"),
            poll_interval: cfg_int("D")?,
            set_priority: cfg_int("E")?,
            scan_priority: cfg_int("F")?,
            callback: cfg("G", "NULL"),
            default_value: get(v, "I"),
            max_value: get(v, "J"),
            min_value: get(v, "K"),
            category: get(v, "W"),
            notes: get(v, "Y"),
            source_sheet: "DSP内部数据".into(),
            source_row: r["row_number"].as_i64().map(|v| v as i32),
            raw_json: json!({"source_definition":r["cells"],"manual_configuration":m,"upload_level":upload}),
            ..Default::default()
        };
        p.validate()?;
        points.push(p);
    }
    points.sort_by_key(|p| (p.upp_model, p.ordinal));
    for (i, p) in points.iter_mut().enumerate() {
        p.ordinal = (i + 1) as i32;
    }
    out.points.retain(|p| p.scope != "DSP");
    out.points.extend(points);
    Ok(())
}

#[cfg(test)]
mod source_tests {
    use super::*;
    #[test]
    fn reconstructs_source_changes_without_cached_projection() {
        let mut data =
            parse(std::fs::read("config/upm/sources/UPM项目测点数据表.xlsx").unwrap()).unwrap();
        let row = data
            .source_rows
            .iter_mut()
            .find(|r| r["sheet"] == "DSP内部数据" && r["row_number"] == 2)
            .unwrap();
        row["cells"]["values"]["G"] = json!("16");
        row["cells"]["values"]["H"] = json!("stale formula result");
        let manual = data
            .source_rows
            .iter_mut()
            .find(|r| r["sheet"] == "UPM-DSP手动配置数据" && r["row_number"] == 2)
            .unwrap();
        manual["cells"]["values"]["H"] = json!("2590");
        data.source_rows.retain(|r| r["sheet"] != "UPM-DSP采集数据");
        data.points.retain(|p| p.scope != "DSP");
        rebuild_dsp(&mut data).unwrap();
        let p = data
            .points
            .iter()
            .find(|p| p.enum_name == "PARAM_PRODUCT_TYPE")
            .unwrap();
        assert_eq!(p.byte_length, 32);
        assert_eq!(p.signal_id, "2590");
        assert_eq!(p.poll_interval, 205);
        assert_eq!(data.points.iter().filter(|p| p.scope == "DSP").count(), 445);
        assert_eq!(
            data.points
                .iter()
                .filter(|p| p.scope == "DSP" && !p.signal_id.is_empty())
                .count(),
            41
        );
    }
}
