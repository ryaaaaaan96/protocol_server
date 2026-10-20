//! Common process templates, incoming collectors and protocol address validation.
use crate::{
    error::{AppError, Result},
    topology::{num, rows, strv},
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::BTreeMap;

pub const COLLECT_COLUMNS: &str = "process_point_id,endpoint_key,upp_model,address,wire_type,wire_length,scale,access,byte_order,acquisition_mode,poll_interval,set_priority,scan_priority,display_order,source_sheet,source_row,metadata";

pub fn collect_defaults() -> Value {
    json!({"process_point_id":null,"endpoint_key":"","upp_model":0,"address":6,
        "wire_type":"U16","wire_length":2,"scale":1,"access":"RO","byte_order":0,
        "acquisition_mode":"poll","poll_interval":null,"set_priority":null,"scan_priority":null,
        "display_order":0,"source_sheet":"","source_row":null,"metadata":{}})
}

pub async fn collect_rows(tx: &mut PgConnection, pid: i64, board: &str) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar(
        r#"SELECT to_jsonb(c)||jsonb_build_object(
        'edit_values',to_jsonb(c),'signal_name',p.name,'name',p.name,'enum_name',p.enum_name,
        'resolved_sig_id',p.sig_id,'data_type',p.internal_type,'byte_length',p.byte_length,
        'group_key',p.group_key,'unit',p.unit,'effective_address',c.address,
        'effective_type',c.wire_type,'effective_length',c.wire_length,'protocol','UPP')
        FROM points.collect_points c JOIN points.process_points p
        ON p.project_id=c.project_id AND p.board_key=c.board_key AND p.id=c.process_point_id
        WHERE c.project_id=$1 AND c.board_key=$2 ORDER BY c.display_order,c.id"#,
    )
    .bind(pid)
    .bind(board)
    .fetch_all(tx)
    .await?)
}

fn devices(board: &Value, group: &Value) -> Vec<Value> {
    let configured: Vec<Value> = board["point_groups"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|g| &g["code"] == group)
        .and_then(|g| g["devices"].as_array())
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    if configured.is_empty() {
        vec![json!({"code":"default","dev_id":0,"modbus_base":0})]
    } else {
        configured
    }
}
fn endpoint<'a>(board: &'a Value, row: &Value) -> Option<&'a Value> {
    board["point_endpoints"]
        .as_array()?
        .iter()
        .find(|e| e["code"] == row["endpoint_key"])
}

pub fn project_row(row: &mut Value, board: &Value, kind: &str) {
    if kind == "forward" && crate::board_rules::inherited_name(board) {
        row["name"] = row["signal_name"].clone();
        row["field_name"] = row["signal_name"].clone();
    }
    row["source_variable"] = row["metadata"]["source_variable"].clone();
    row["source_sig_id"] = row["metadata"]["source_sig_id"].clone();
    row["source_notes"] = row["metadata"]["notes"].clone();
    let modbus = endpoint(board, row).is_some_and(|e| e["protocol"] == "MODBUS");
    if modbus {
        row["register_count"] = json!((num(row, "wire_length") + 1) / 2);
    }
    row["device_addresses"] = json!(
        devices(board, &row["group_key"])
            .iter()
            .map(|d| {
                if kind == "forward" && modbus {
                    format!(
                        "{}: {}",
                        strv(d, "code"),
                        num(d, "modbus_base") + num(row, "address")
                    )
                } else {
                    format!("{}: {}", strv(d, "code"), num(d, "dev_id"))
                }
            })
            .collect::<Vec<_>>()
            .join("；")
    );
}

/// Keep this board's raw integer representation. `scale` is engineering
/// precision, not a request to rewrite the wire encoding as DSP fixed-point.
pub fn validate(g: &Value) -> Vec<Value> {
    let mut issues = vec![];
    for board in rows(&g["project_config"], "board_types")
        .iter()
        .filter(|b| b["point_storage"] == "native")
    {
        validate_board(g, board, &mut issues);
    }
    for row in rows(g, "collect_points") {
        if crate::board_rules::board(g, strv(row, "board_key")).is_none() {
            issues.push(json!({"key":format!("collect_points:{}:board",row["id"]),"entity":"collect_points","id":row["id"],"level":"error","code":"board","message":"采集映射缺少板卡配置"}));
        }
    }
    issues
}
fn validate_board(g: &Value, board: &Value, issues: &mut Vec<Value>) {
    let raw = crate::board_rules::raw(board);
    let mut add = |entity: &str, row: &Value, code: &str, message: &str, warning: bool| {
        issues.push(json!({"key":format!("{entity}:{}:{code}",row["id"]),
            "level":if warning {"warning"} else {"error"},"entity":entity,"id":row["id"],
            "name":row["name"],"code":code,"message":message}));
    };
    for point in rows(g, "process_points").iter().filter(|p| {
        p["board_key"] == board["code"]
            && (raw || crate::board_rules::flag(board, "warn_missing_sig_id"))
    }) {
        if point["sig_id"].is_null() && crate::board_rules::flag(board, "warn_missing_sig_id") {
            add(
                "process_points",
                point,
                "missing_sig_id",
                "来源未配置 sigID；保留空值，生成固件前须确认",
                true,
            );
        }
        if !raw {
            continue;
        }
        let mut inconsistent = false;
        let typ = strv(point, "internal_type");
        for field in ["default_value", "min_value", "max_value"] {
            let raw = strv(point, field);
            if typ == "STRING" || raw.is_empty() {
                continue;
            }
            match raw.parse::<f64>() {
                Ok(value) => {
                    let (lo, hi) = match typ {
                        "U8" => (0., 255.),
                        "U16" => (0., 65535.),
                        "S16" => (-32768., 32767.),
                        "U32" => (0., 4294967295.),
                        "S32" => (-2147483648., 2147483647.),
                        _ => (-(f32::MAX as f64), f32::MAX as f64),
                    };
                    inconsistent |= !value.is_finite() || value < lo || value > hi;
                }
                Err(_) => inconsistent = true,
            }
        }
        let number = |key| strv(point, key).parse::<f64>().ok();
        inconsistent |= number("min_value")
            .zip(number("max_value"))
            .is_some_and(|(a, b)| a > b);
        inconsistent |= number("default_value")
            .zip(number("min_value"))
            .is_some_and(|(value, min)| value < min);
        inconsistent |= number("default_value")
            .zip(number("max_value"))
            .is_some_and(|(value, max)| value > max);
        if typ == "STRING" {
            inconsistent |= !strv(point, "min_value").is_empty()
                || !strv(point, "max_value").is_empty()
                || strv(point, "default_value").len() > num(point, "byte_length") as usize;
        }
        if inconsistent {
            // Imported irregularities stay visible, with their original source
            // cells. New edits are errors unless the complete values still match
            // the immutable import baseline.
            let source = &point["metadata"]["original_ranges"];
            let original = crate::board_rules::flag(board, "source_range_warnings")
                && [
                    "default_value",
                    "min_value",
                    "max_value",
                    "internal_type",
                    "byte_length",
                ]
                .iter()
                .all(|key| source[*key] == point[*key]);
            add(
                "process_points",
                point,
                "range",
                "数值范围或符号定义需要核实来源表",
                original,
            );
        }
    }
    for (table, direction) in [
        ("collect_points", "collect"),
        ("transmit_points", "transmit"),
    ] {
        let mut occupied: BTreeMap<String, Vec<(i64, i64, i64)>> = BTreeMap::new();
        for row in rows(g, table).iter().filter(|r| {
            r["board_key"] == board["code"]
                && (raw
                    || direction == "collect"
                    || endpoint(board, r).is_some_and(|e| e["protocol"] == "MODBUS"))
        }) {
            let Some(ep) = endpoint(board, row).filter(|e| {
                if direction == "collect" {
                    e["direction"] == "collect"
                } else {
                    e["direction"] != "collect"
                }
            }) else {
                add(
                    table,
                    row,
                    "endpoint",
                    "端点不存在或采集/转发方向不匹配",
                    false,
                );
                continue;
            };
            let Some(point) = rows(g, "process_points").iter().find(|p| {
                p["id"] == row["process_point_id"]
                    && p["board_key"] == row["board_key"]
                    && p["project_id"] == row["project_id"]
            }) else {
                add(table, row, "reference", "必须关联当前板卡的内部点", false);
                continue;
            };
            if direction == "collect"
                && !crate::board_rules::can_collect(board, &point["group_key"])
            {
                add(
                    table,
                    row,
                    "local_collection",
                    "当前分组不允许建立采集记录",
                    false,
                );
            }
            if (raw || direction == "collect")
                && (row["wire_type"] != point["internal_type"]
                    || row["wire_length"] != point["byte_length"])
            {
                add(
                    table,
                    row,
                    "representation",
                    "原始存储类型和长度必须与通信映射一致",
                    false,
                );
            }
            if row["scale"]
                .as_f64()
                .is_none_or(|v| !v.is_finite() || v <= 0.)
                || !["RO", "RW", "WO"].contains(&strv(row, "access"))
                || !(0..=3).contains(&num(row, "byte_order"))
                || !(0..=65535).contains(&num(row, "upp_model"))
            {
                add(
                    table,
                    row,
                    "wire_config",
                    "精度、读写属性、字节序或 UPP 模型号无效",
                    false,
                );
            }
            if direction == "collect" {
                if !["poll", "upload"].contains(&strv(row, "acquisition_mode"))
                    || ["poll_interval", "set_priority", "scan_priority"]
                        .iter()
                        .any(|key| {
                            !row[*key].is_null()
                                && row[*key].as_i64().is_none_or(|v| !(0..=65535).contains(&v))
                        })
                {
                    add(table, row, "polling", "采集方式或轮询参数无效", false);
                }
            }
            if direction == "transmit" && raw && row["conversion"] != "identity" {
                add(
                    table,
                    row,
                    "conversion",
                    "原始值映射的转换配置须为 identity",
                    false,
                );
            }
            let modbus = ep["protocol"] == "MODBUS";
            if modbus && !["HOLDING", "INPUT"].contains(&strv(row, "register_type")) {
                add(
                    table,
                    row,
                    "register_type",
                    "Modbus 寄存器区必须为 HOLDING 或 INPUT",
                    false,
                );
            }
            let length = if modbus {
                (num(row, "wire_length") + 1) / 2
            } else {
                num(row, "wire_length")
            };
            let instances = devices(board, &point["group_key"]);
            if instances.is_empty() {
                add(table, row, "devices", "点表分组缺少设备实例", false);
            }
            for device in instances {
                let address = num(row, "address")
                    + if modbus {
                        num(&device, "modbus_base")
                    } else {
                        0
                    };
                if address + length > 65536 || address < 0 || length < 1 {
                    add(
                        table,
                        row,
                        "address",
                        "设备实例的协议地址超出 16 位范围",
                        false,
                    );
                }
                if row.get("enabled") == Some(&json!(false)) {
                    continue;
                }
                let domain = if modbus {
                    format!("{}:{}", strv(ep, "code"), strv(row, "register_type"))
                } else {
                    format!(
                        "{}:{}:{}",
                        strv(ep, "code"),
                        strv(&device, "code"),
                        num(row, "upp_model")
                    )
                };
                let slots = occupied.entry(domain).or_default();
                if slots
                    .iter()
                    .any(|(a, n, _)| address < *a + *n && *a < address + length)
                {
                    add(
                        table,
                        row,
                        "overlap",
                        "同一设备/协议地址区的字段重叠",
                        false,
                    );
                }
                slots.push((address, length, num(row, "id")));
            }
        }
    }
}

/// Used only by explicit workbook import; never by config reads or reloads.
pub async fn import(
    tx: &mut PgConnection,
    pid: i64,
    board_key: &str,
    data: &crate::workbook_import::ImportData,
) -> Result<()> {
    let board = crate::native_points::native_board(tx, pid, board_key)
        .await?
        .ok_or(AppError::bad("请先应用板卡配置"))?;
    if data.process.is_empty() {
        return Err(AppError::bad("工作簿没有内部点"));
    }
    for table in ["collect_points", "transmit_points", "process_points"] {
        sqlx::query(&format!(
            "DELETE FROM points.{table} WHERE project_id=$1 AND board_key=$2"
        ))
        .bind(pid)
        .bind(board_key)
        .execute(&mut *tx)
        .await?;
    }
    let mut ids = BTreeMap::new();
    for point in &data.process {
        if !board["point_groups"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|g| g["code"] == point["group_key"])
        {
            return Err(AppError::bad("工作簿分组未配置"));
        }
        let row = crate::native_points::insert(tx, pid, board_key, "process", point).await?;
        ids.insert(
            (
                strv(point, "group_key").to_owned(),
                strv(point, "enum_name").to_owned(),
            ),
            row["id"].clone(),
        );
    }
    for (kind, records) in [("collect", &data.collect), ("forward", &data.transmit)] {
        for mapping in records {
            let mut row = mapping.clone();
            row["process_point_id"] = ids
                .get(&(
                    strv(mapping, "process_group").to_owned(),
                    strv(mapping, "process_enum").to_owned(),
                ))
                .ok_or(AppError::bad("映射找不到内部点"))?
                .clone();
            crate::native_points::insert(tx, pid, board_key, kind, &row).await?;
        }
    }
    Ok(())
}

pub fn generate(g: &Value, board: &Value) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    for (kind, table) in [
        ("process", "process_points"),
        ("collect", "collect_points"),
        ("transmit", "transmit_points"),
    ] {
        let points: Vec<_> = rows(g, table)
            .iter()
            .filter(|r| r["board_key"] == board["code"])
            .collect();
        files.insert(
            format!("board_types/{}/{kind}.json", strv(board, "code")),
            serde_json::to_string_pretty(&json!({
            "version":1,"board_key":board["code"],"groups":board["point_groups"],
            "endpoints":board["point_endpoints"],"points":points}))
            .unwrap(),
        );
    }
    let mut expanded = vec![];
    for row in rows(g, "transmit_points")
        .iter()
        .filter(|r| r["board_key"] == board["code"] && r["enabled"] == true)
    {
        let Some(point) = rows(g, "process_points")
            .iter()
            .find(|p| p["id"] == row["process_point_id"])
        else {
            continue;
        };
        let Some(ep) = endpoint(board, row) else {
            continue;
        };
        for device in devices(board, &point["group_key"]) {
            let mut item = row.clone();
            if crate::board_rules::inherited_name(board) {
                item["name"] = point["name"].clone();
            }
            item["device"] = device.clone();
            item["protocol"] = ep["protocol"].clone();
            item["address"] = json!(
                num(row, "address")
                    + if ep["protocol"] == "MODBUS" {
                        num(&device, "modbus_base")
                    } else {
                        0
                    }
            );
            if ep["protocol"] == "MODBUS" {
                item["register_count"] = json!((num(row, "wire_length") + 1) / 2);
            }
            expanded.push(item);
        }
    }
    files.insert(
        format!(
            "board_types/{}/transmit-instances.json",
            strv(board, "code")
        ),
        serde_json::to_string_pretty(&expanded).unwrap(),
    );
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_range_warning_does_not_allow_new_invalid_edits() {
        let original = json!({"internal_type":"U16","byte_length":2,
            "default_value":"0","min_value":"0","max_value":"70000"});
        let mut point = original.clone();
        point["id"] = json!(1);
        point["board_key"] = json!("UPM");
        point["sig_id"] = json!(1);
        point["metadata"] = json!({"original_ranges":original});
        let mut graph = json!({"project_config":{"board_types":[{"code":"UPM","point_storage":"native","point_rules":{"raw_representation":true,"source_range_warnings":true}}]},
            "process_points":[point]});
        assert_eq!(validate(&graph)[0]["level"], "warning");
        graph["process_points"][0]["internal_type"] = json!("U8");
        graph["process_points"][0]["byte_length"] = json!(1);
        assert_eq!(validate(&graph)[0]["level"], "error");
        graph["process_points"][0]["max_value"] = json!("100");
        graph["process_points"][0]["default_value"] = json!("101");
        assert_eq!(validate(&graph)[0]["level"], "error");
        graph["process_points"][0]["default_value"] = json!("50");
        assert!(validate(&graph).is_empty());
    }
}
