//! One bounded instance-address calculation shared by views, validation and generation.
use crate::{
    error::{AppError, Result},
    topology::{num, rows, strv},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn fail(message: impl std::fmt::Display) -> AppError {
    AppError::bad(format!("实例地址计算失败：{message}"))
}

pub fn devices(board: &Value, group: &Value) -> Vec<Value> {
    let configured = rows(board, "point_groups")
        .iter()
        .find(|item| &item["code"] == group)
        .map(|item| rows(item, "devices").to_vec())
        .unwrap_or_default();
    let mut devices = if configured.is_empty() {
        vec![json!({"code":"default","name":"默认设备","dev_id":0,"modbus_base":0})]
    } else {
        configured
    };
    for (index, device) in devices.iter_mut().enumerate() {
        if device.get("instance_index").is_none() {
            device["instance_index"] = json!(index);
        }
    }
    devices
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Address {
    id: i64,
    device_code: String,
    address: i64,
}

pub fn calculate(
    board: &Value,
    definition: &Value,
    mappings: &[Value],
    points: &[Value],
) -> Result<BTreeMap<i64, Vec<Value>>> {
    let scripted = definition["instance_calculation"] == true;
    let mut input = vec![];
    let mut expected = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for row in mappings {
        let id = num(row, "id");
        if id <= 0 || id > 9_007_199_254_740_991 || !ids.insert(id) {
            return Err(fail("模板 ID 须为不重复的安全整数"));
        }
        let point = points
            .iter()
            .find(|point| point["id"] == row["process_point_id"]);
        let group = row
            .get("group_key")
            .or_else(|| point.map(|point| &point["group_key"]))
            .ok_or(fail("转发模板缺少关联分组"))?;
        let endpoint = rows(board, "point_endpoints")
            .iter()
            .find(|endpoint| endpoint["code"] == row["endpoint_key"])
            .ok_or(fail("转发模板的协议端点不存在"))?;
        let devices = devices(board, group);
        if devices.len() > 10_000usize.saturating_sub(expected.len()) {
            return Err(fail("一张表展开后最多 10000 行"));
        }
        for device in &devices {
            expected.insert(
                (id, strv(device, "code").to_owned()),
                (
                    device.clone(),
                    endpoint["protocol"] == "MODBUS",
                    num(row, "wire_length"),
                ),
            );
        }
        input.push(
            json!({"id":id,"group_key":group,"endpoint_key":row["endpoint_key"],
            "protocol":endpoint["protocol"],"base_address":row["address"],"devices":devices}),
        );
    }
    if expected.len() > 10_000 {
        return Err(fail("一张表展开后最多 10000 行"));
    }
    let output: Vec<Address> = if scripted {
        serde_json::from_value(crate::table_behavior::evaluate(
            &definition["behavior"],
            &json!({"action":"instances","rows":input}),
        )?)
        .map_err(fail)?
    } else {
        input
            .iter()
            .flat_map(|row| {
                rows(row, "devices").iter().map(move |device| {
                    let base = if row["protocol"] == "MODBUS" {
                        num(device, "modbus_base")
                    } else {
                        0
                    };
                    Ok(Address {
                        id: num(row, "id"),
                        device_code: strv(device, "code").to_owned(),
                        address: num(row, "base_address")
                            .checked_add(base)
                            .ok_or(fail("实例地址整数溢出"))?,
                    })
                })
            })
            .collect::<Result<Vec<_>>>()?
    };
    if output.len() != expected.len() {
        return Err(fail("规则须完整返回每条模板的全部设备实例"));
    }
    let mut seen = BTreeSet::new();
    let mut calculated = BTreeMap::new();
    for item in output {
        let key = (item.id, item.device_code);
        let (device, modbus, bytes) = expected.get(&key).ok_or(fail("规则返回未知模板或设备"))?;
        if !seen.insert(key.clone()) {
            return Err(fail("规则返回重复实例"));
        }
        let length = if *modbus {
            bytes.checked_add(1).ok_or(fail("协议长度整数溢出"))? / 2
        } else {
            *bytes
        };
        if item.address < 0
            || length < 1
            || item
                .address
                .checked_add(length)
                .is_none_or(|end| end > 65536)
        {
            return Err(fail("实例协议地址或长度超出 16 位范围"));
        }
        let mut value = device.clone();
        value["address"] = json!(item.address);
        calculated.insert(key, value);
    }
    let mut result = BTreeMap::new();
    for row in input {
        result.insert(
            num(&row, "id"),
            rows(&row, "devices")
                .iter()
                .map(|device| {
                    calculated[&(num(&row, "id"), strv(device, "code").to_owned())].clone()
                })
                .collect(),
        );
    }
    Ok(result)
}

pub fn graph(board: &Value, graph: &Value) -> Result<BTreeMap<i64, Vec<Value>>> {
    let code = strv(board, "code");
    let mappings = rows(graph, "transmit_points")
        .iter()
        .filter(|row| row["board_key"] == code)
        .cloned()
        .collect::<Vec<_>>();
    calculate(
        board,
        &graph["table_definitions"][code]["forward"],
        &mappings,
        rows(graph, "process_points"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Value) {
        let files =
            crate::project_files::ProjectFiles::load_from(std::path::Path::new("config")).unwrap();
        let topology = files.topology_source("dc-ups").unwrap()["config"].clone();
        let board = rows(&topology, "board_types")
            .iter()
            .find(|board| board["code"] == "UPM")
            .unwrap()
            .clone();
        let definitions = files.definition(Some("dc-ups")).unwrap()["boards"].clone();
        let graph = json!({"project_config":topology,"table_definitions":definitions,
            "process_points":[{"id":1,"board_key":"UPM","group_key":"DSP","name":"电压","enum_name":"VOLTAGE","internal_type":"U16","byte_length":2,"sig_id":1}],
            "transmit_points":[{"id":1,"board_key":"UPM","process_point_id":1,"endpoint_key":"MODBUS_SERVICE","address":6,
                "wire_length":2,"wire_type":"U16","register_type":"HOLDING","enabled":true,"scale":1,"access":"RO","byte_order":0,"conversion":"identity"}]});
        (board, graph)
    }
    #[test]
    fn formula_is_shared_by_projection_validation_generation_and_receiver() {
        let (mut board, mut data) = fixture();
        let original = data.clone();
        let calculated = graph(&board, &data).unwrap();
        assert_eq!(calculated[&1][0]["address"], 50006);
        assert_eq!(calculated[&1][7]["address"], 57006);
        // JSON parameters and JS source are both live inputs, without changing point storage.
        data["table_definitions"]["UPM"]["forward"]["behavior"]["parameters"]["modbus_layouts"]["DSP"]
            ["template_base"] = json!(40000);
        let script = data["table_definitions"]["UPM"]["forward"]["behavior"]["script"]
            .as_str()
            .unwrap()
            .replace(
                "layout.template_base + row.base_address",
                "layout.template_base + row.base_address + 10",
            );
        data["table_definitions"]["UPM"]["forward"]["behavior"]["script"] = json!(script);
        board["table_definitions"] = data["table_definitions"]["UPM"].clone();
        let expected = graph(&board, &data).unwrap()[&1][7]["address"].clone();
        assert_eq!(expected, 47016);
        let mut projected = rows(&data, "transmit_points").to_vec();
        projected[0]["group_key"] = json!("DSP");
        crate::native_protocol::project_instances(&mut projected, &board, "forward").unwrap();
        assert_eq!(projected[0]["device_instances"][7]["address"], expected);
        let files = crate::native_protocol::generate(&data, &board).unwrap();
        let generated: Value =
            serde_json::from_str(&files["board_types/UPM/transmit-instances.json"]).unwrap();
        assert_eq!(generated[7]["address"], expected);
        let rule = &data["table_definitions"]["UPM_DEMO"]["collect"]["mapping"];
        let receiver = crate::derived_collection::evaluate(&data, "UPM_DEMO", rule).unwrap();
        assert_eq!(receiver[7]["address"], expected);
        assert_eq!(data["transmit_points"], original["transmit_points"]);
        // Address overlap is checked against the script output, not legacy bases.
        data["table_definitions"]["UPM"]["forward"]["behavior"]["parameters"]["modbus_layouts"]["DSP"]
            ["device_stride"] = json!(0);
        assert!(
            crate::native_protocol::validate(&data)
                .iter()
                .any(|issue| issue["code"] == "overlap")
        );
    }
    #[test]
    fn rules_cannot_drop_duplicate_borrow_or_corrupt_instances() {
        let (board, data) = fixture();
        for script in [
            "export function behavior(){return []}",
            "export function behavior(c){return c.rows.flatMap(r=>r.devices.map(d=>({id:r.id,device_code:'DSP1',address:1})))}",
            "export function behavior(c){return c.rows.flatMap(r=>r.devices.map(d=>({id:999,device_code:d.code,address:1})))}",
            "export function behavior(c){return c.rows.flatMap(r=>r.devices.map(d=>({id:r.id,device_code:d.code,address:65535})))}",
            "export function behavior(c){return c.rows.flatMap(r=>r.devices.map(d=>({id:r.id,device_code:d.code,address:NaN})))}",
            "export function behavior(){while(true){}}",
        ] {
            let mut invalid = data.clone();
            invalid["table_definitions"]["UPM"]["forward"]["behavior"]["script"] = json!(script);
            if script.contains("65535") {
                invalid["transmit_points"][0]["wire_length"] = json!(4);
            }
            assert!(graph(&board, &invalid).is_err(), "{script}");
        }
        let mut invalid = data.clone();
        invalid["transmit_points"][0]["wire_length"] = json!(i64::MAX);
        assert!(graph(&board, &invalid).is_err());
        invalid["table_definitions"]["UPM"]["forward"]["instance_calculation"] = json!(false);
        invalid["transmit_points"][0]["address"] = json!(i64::MAX);
        invalid["transmit_points"][0]["wire_length"] = json!(2);
        let mut legacy_board = board.clone();
        legacy_board["point_groups"][1]["devices"][0]["modbus_base"] = json!(1);
        assert!(graph(&legacy_board, &invalid).is_err());
    }
    #[test]
    fn upp_only_scripted_boards_also_generate_and_validate_the_computed_instances() {
        let (mut board, mut data) = fixture();
        board["point_rules"]["raw_representation"] = json!(false);
        board["point_endpoints"] = json!([{"code":"BYTES","protocol":"UPP"}]);
        data["project_config"]["board_types"] = json!([board]);
        data["transmit_points"][0]["endpoint_key"] = json!("BYTES");
        data["transmit_points"][0]["upp_model"] = json!(99);
        data["table_definitions"]["UPM"]["forward"]["behavior"]["script"] = json!(
            "export function behavior(c) { return c.rows.flatMap(r=>r.devices.map(d=>({id:r.id,device_code:d.code,address:100+d.instance_index}))); }"
        );
        let files = crate::native_points::generate(&data).unwrap();
        let generated: Value =
            serde_json::from_str(&files["board_types/UPM/transmit-instances.json"]).unwrap();
        assert_eq!(generated[7]["address"], 107);
        let mut duplicate = data["transmit_points"][0].clone();
        duplicate["id"] = json!(2);
        duplicate["address"] = json!(30);
        data["transmit_points"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(
            crate::native_protocol::validate(&data)
                .iter()
                .any(|issue| issue["code"] == "overlap")
        );
    }
    #[test]
    fn collection_base_is_independent_and_reconciles_only_modbus_offsets() {
        let (board, mut data) = fixture();
        data["collect_points"] = json!([{"id":1,"board_key":"UPM","process_point_id":1,"endpoint_key":"DSP_UPP","address":6,"metadata":{"source_cells":{"keep":true}}}]);
        let defs = &data["table_definitions"]["UPM"];
        let sources = crate::table_runtime::graph_sources(&data, &board).unwrap();
        let mut collection = rows(&data, "collect_points").to_vec();
        crate::table_behavior::project(&defs["collect"], &mut collection, &sources).unwrap();
        assert_eq!(collection[0]["base_address"], 6);
        let values =
            serde_json::from_value::<serde_json::Map<String, Value>>(json!({"base_address":20}))
                .unwrap();
        let patch = crate::table_behavior::normalize(
            &defs["collect"],
            &data["collect_points"][0],
            &values,
            &sources[0],
            "update",
        )
        .unwrap();
        assert_eq!(patch["metadata"]["base_address"], 20);
        assert_eq!(patch["metadata"]["source_cells"]["keep"], true);
        assert!(!patch.contains_key("address"));
        data["collect_points"][0]["metadata"] = patch["metadata"].clone();
        let sources = crate::table_runtime::graph_sources(&data, &board).unwrap();
        let mappings = rows(&data, "transmit_points");
        let changes = crate::table_behavior::reconcile(
            &data["table_definitions"]["UPM"]["forward"],
            mappings,
            &sources,
        )
        .unwrap();
        assert_eq!(changes[0].1["address"], 20);
        let manual =
            serde_json::from_value::<serde_json::Map<String, Value>>(json!({"address":30}))
                .unwrap();
        assert!(
            crate::table_behavior::normalize(
                &data["table_definitions"]["UPM"]["forward"],
                &mappings[0],
                &manual,
                &sources[0],
                "update"
            )
            .is_err()
        );
        assert_eq!(data["collect_points"][0]["address"], 6);
    }
}
