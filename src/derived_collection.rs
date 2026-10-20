//! Read-only collection projections. Source data remains in its owning board.
use crate::{
    error::{AppError, Result},
    topology::{self, num, rows, strv},
};
use rquickjs::{Array, CatchResultExt, Function, Module, Object};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    board_key: String,
    endpoint_key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    engine: String,
    script_file: String,
    script: String,
    source: Source,
    endpoint_key: String,
    group_key: String,
    parameters: Value,
}
fn fail(message: impl std::fmt::Display) -> AppError {
    AppError::bad(format!("采集映射失败：{message}"))
}
fn parse(value: &Value) -> Result<Rule> {
    let rule: Rule = serde_json::from_value(value.clone()).map_err(fail)?;
    if rule.engine != "javascript"
        || !rule.parameters.is_object()
        || rule.parameters.to_string().len() > 32768
    {
        return Err(fail(
            "mapping 需要 javascript 引擎和最多 32 KiB 的 parameters 对象",
        ));
    }
    for (key, default, max) in [("poll_interval", 1000, 65535), ("byte_order", 0, 3)] {
        if !(0..=max).contains(&rule.parameters[key].as_i64().unwrap_or(default))
            || rule
                .parameters
                .get(key)
                .is_some_and(|v| v.as_i64().is_none())
        {
            return Err(fail(format!("{key} 超出有效范围")));
        }
    }
    Ok(rule)
}
pub fn validate_rule(value: &Value) -> Result<()> {
    let rule = parse(value)?;
    crate::table_calculation::validate(
        &json!({"engine":rule.engine,"script_file":rule.script_file,"script":rule.script,"parameters":rule.parameters}),
    )
}
fn board<'a>(config: &'a Value, key: &str) -> Option<&'a Value> {
    rows(config, "board_types")
        .iter()
        .find(|b| b["code"] == key)
}
fn check_source(config: &Value, target: &Value, rule: &Rule) -> Result<()> {
    let source = board(config, &rule.source.board_key).ok_or(fail("源板卡不存在"))?;
    if target["point_storage"] != "derived"
        || source["point_storage"] != "native"
        || source["code"] == target["code"]
        || !rows(source, "point_endpoints").iter().any(|e| {
            e["code"] == rule.source.endpoint_key
                && e["protocol"] == "MODBUS"
                && e["direction"] != "collect"
        })
        || !rows(target, "point_endpoints").iter().any(|e| {
            e["code"] == rule.endpoint_key
                && e["protocol"] == "MODBUS"
                && e["direction"] == "collect"
        })
        || !rows(target, "point_groups")
            .iter()
            .any(|g| g["code"] == rule.group_key)
    {
        return Err(fail(
            "派生采集须引用另一 native 板卡的 Modbus 转发端点，并配置有效的采集端点和分组",
        ));
    }
    Ok(())
}
pub fn validate_configuration(config: &Value, definitions: &Value) -> Result<()> {
    for target in rows(config, "board_types") {
        let key = strv(target, "code");
        let mapping = &definitions["boards"][key]["collect"]["mapping"];
        if target["point_storage"] == "derived" {
            let rule = parse(mapping)?;
            check_source(config, target, &rule)?;
            if definitions["workspace"]["boards"][key]["tables"] != json!(["collect"]) {
                return Err(fail("derived 板卡必须只启用一张采集表"));
            }
        } else if !mapping.is_null() {
            return Err(fail("mapping 仅可用于 derived 板卡"));
        }
    }
    Ok(())
}

pub fn evaluate(graph: &Value, key: &str, mapping: &Value) -> Result<Vec<Value>> {
    let rule = parse(mapping)?;
    let config = &graph["project_config"];
    let target = board(config, key).ok_or(fail("目标板卡尚未导入拓扑"))?;
    check_source(config, target, &rule)?;
    let source = board(config, &rule.source.board_key).unwrap();
    let mut input = vec![];
    let mut expected = BTreeMap::new();
    let mut source_rows: Vec<_> = rows(graph, "transmit_points")
        .iter()
        .filter(|r| {
            r["board_key"] == rule.source.board_key && r["endpoint_key"] == rule.source.endpoint_key
        })
        .collect();
    source_rows.sort_by_key(|r| num(r, "id"));
    for row in source_rows {
        let point = topology::find(graph, "process_points", num(row, "process_point_id"))
            .filter(|p| p["board_key"] == rule.source.board_key)
            .ok_or(fail("源转发内部点不存在"))?;
        let group = rows(source, "point_groups")
            .iter()
            .find(|g| g["code"] == point["group_key"])
            .ok_or(fail("源分组不存在"))?;
        let devices = group["devices"]
            .as_array()
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                vec![json!({"code":"default","name":"默认设备","dev_id":0,"modbus_base":0})]
            });
        for device in &devices {
            if expected
                .insert(
                    (num(row, "id"), strv(device, "code").to_owned()),
                    (row, point, device.clone()),
                )
                .is_some()
            {
                return Err(fail("源记录或设备标识重复"));
            }
        }
        input.push(json!({"source_id":row["id"],"address":row["address"],"wire_length":row["wire_length"],"wire_type":row["wire_type"],"register_type":row["register_type"],"devices":devices}));
    }
    if expected.len() > 10_000
        || expected
            .keys()
            .any(|(id, _)| *id <= 0 || *id > 9_007_199_254_740_991)
    {
        return Err(fail("展开后最多 10000 行，源 ID 必须为安全整数"));
    }
    let output=crate::table_calculation::engine()?.with(|ctx| -> Result<Vec<Value>> {
        let points=ctx.json_parse(serde_json::to_vec(&input).map_err(fail)?).catch(&ctx).map_err(fail)?;
        let parameters=ctx.json_parse(rule.parameters.to_string()).catch(&ctx).map_err(fail)?;
        let (module,ready)=Module::declare(ctx.clone(),rule.script_file.clone(),rule.script.clone()).and_then(|m|m.eval()).catch(&ctx).map_err(fail)?;
        ready.result::<()>().ok_or(fail("脚本必须同步执行"))?.catch(&ctx).map_err(fail)?;
        let calculate:Function=module.get("default").catch(&ctx).map_err(fail)?;
        let result:Array=calculate.call((points,parameters)).catch(&ctx).map_err(fail)?;
        if result.len()!=expected.len(){return Err(fail("脚本必须完整返回每条源记录的全部设备实例"));}
        let mut output=vec![];let mut seen=BTreeSet::new();let mut occupied:BTreeMap<(i64,String),Vec<(i64,i64)>>=BTreeMap::new();
        for object in result.iter::<Object>() {
            let object=object.catch(&ctx).map_err(fail)?;
            let keys:Vec<String>=object.own_keys(rquickjs::object::Filter::new().string().symbol()).collect::<rquickjs::Result<_>>().catch(&ctx).map_err(fail)?;
            if keys.len()!=4 || keys.iter().any(|k|!["source_id","device_code","address","dev_id"].contains(&k.as_str())){return Err(fail("结果仅允许 source_id、device_code、address、dev_id"));}
            let integer=|field:&str|->Result<i64>{
                let value:rquickjs::Value=object.get(field).catch(&ctx).map_err(fail)?;
                value.as_number().filter(|v|v.is_finite()&&v.fract()==0.&&v.abs()<=9_007_199_254_740_991.).map(|v|v as i64).ok_or(fail("结果必须为安全整数"))
            };
            let id=integer("source_id")?;let device_code:String=object.get("device_code").catch(&ctx).map_err(fail)?;
            let identity=(id,device_code.clone());
            let (row,point,device)=expected.get(&identity).ok_or(fail("脚本引用了未知源记录或设备"))?;
            if !seen.insert(identity){return Err(fail("脚本返回了重复映射"));}
            let address=integer("address")?;let dev_id=integer("dev_id")?;
            let register_count=(num(row,"wire_length")+1)/2;
            if !(1..=247).contains(&dev_id) || register_count<1 || address<0 || address.checked_add(register_count).is_none_or(|end|end>65536) {return Err(fail("Modbus 从站地址或寄存器范围无效"));}
            let occupied=occupied.entry((dev_id,strv(row,"register_type").to_owned())).or_default();
            if occupied.iter().any(|(start,end)|address<*end && *start<address+register_count){return Err(fail("展开后的 Modbus 地址重叠"));}
            occupied.push((address,address+register_count));
            let name=if !crate::board_rules::inherited_name(source) && row["name"].is_string() { &row["name"] } else { &point["name"] };
            output.push(json!({"id":output.len()+1,"board_key":key,"group_key":rule.group_key,"endpoint_key":rule.endpoint_key,
                "protocol":"MODBUS","source_id":id,"source_device_code":device_code,"source_device_name":device["name"],
                "signal_name":name,"enum_name":point["enum_name"],"resolved_sig_id":point["sig_id"],"source_notes":point["notes"],"unit":point["unit"],
                "address":address,"dev_id":dev_id,"register_type":row["register_type"],"register_count":register_count,
                "wire_type":row["wire_type"],"wire_length":row["wire_length"],"scale":row["scale"],"access":row["access"],
                "poll_interval":rule.parameters["poll_interval"].as_i64().unwrap_or(1000),"byte_order":rule.parameters["byte_order"].as_i64().unwrap_or(0),
                "can_edit":false,"edit_values":{}}));
        }
        Ok(output)
    })?;
    Ok(output)
}

pub async fn attach(
    tx: &mut PgConnection,
    pid: i64,
    files: &crate::project_files::ProjectFiles,
    graph: &mut Value,
) -> Result<()> {
    let targets: Vec<String> = rows(&graph["project_config"], "board_types")
        .iter()
        .filter(|b| b["point_storage"] == "derived")
        .map(|b| strv(b, "code").to_owned())
        .collect();
    if targets.is_empty() {
        return Ok(());
    }
    let key: String = sqlx::query_scalar("SELECT config_key FROM meta.project_state WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    let definitions = files.definition(Some(&key)).map_err(fail)?;
    for target in targets {
        let rule = &definitions["boards"][&target]["collect"]["mapping"];
        match evaluate(graph, &target, rule) {
            Ok(data) => graph["derived_collections"][&target] = json!({"rows":data,"mapping":rule}),
            Err(error) => {
                if !graph["derived_errors"].is_array() {
                    graph["derived_errors"] = json!([]);
                }
                graph["derived_errors"].as_array_mut().unwrap().push(json!({"key":format!("derived:{target}"),"level":"error","entity":"collect_points","board_key":target,"code":"derived_mapping","message":error.1}));
            }
        }
    }
    Ok(())
}

pub fn issues(graph: &Value) -> Vec<Value> {
    let mut issues = rows(graph, "derived_errors").to_vec();
    for target in rows(&graph["project_config"], "board_types")
        .iter()
        .filter(|b| b["point_storage"] == "derived")
    {
        for table in topology::TABLES {
            for row in rows(graph, table)
                .iter()
                .filter(|r| r["board_key"] == target["code"])
            {
                issues.push(json!({"key":format!("{table}:{}:derived_storage",row["id"]),"level":"error","entity":table,"id":row["id"],"code":"derived_storage","message":"派生设备不能保存独立点记录，请在源板卡维护数据"}));
            }
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Value) {
        let config = serde_json::from_str::<Value>(include_str!("../config/dc-ups/project.json"))
            .unwrap()["topology"]
            .clone();
        let definition =
            serde_json::from_str::<Value>(include_str!("../config/dc-ups/upm-demo/collect.json"))
                .unwrap();
        let mut rule = definition["mapping"].clone();
        rule["script"] = json!(include_str!("../config/dc-ups/upm-demo/collect.js"));
        let graph = json!({"project_config":config,"process_points":[
            {"id":1,"board_key":"UPM","group_key":"LOCAL","name":"本地","enum_name":"LOCAL_VALUE"},
            {"id":2,"board_key":"UPM","group_key":"DSP","name":"DSP测点","enum_name":"DSP_VALUE"}],
            "transmit_points":[
            {"id":10,"board_key":"UPM","process_point_id":1,"endpoint_key":"MODBUS_SERVICE","address":100,"wire_type":"U16","wire_length":2,"register_type":"INPUT","scale":1,"access":"RO"},
            {"id":11,"board_key":"UPM","process_point_id":2,"endpoint_key":"MODBUS_SERVICE","address":6,"wire_type":"U32","wire_length":4,"register_type":"HOLDING","scale":0.1,"access":"RO"}]});
        (graph, rule)
    }
    #[test]
    fn expands_all_instances_and_uses_one_upm_slave() {
        let (graph, rule) = fixture();
        let before = graph.clone();
        let output = evaluate(&graph, "UPM_DEMO", &rule).unwrap();
        assert_eq!(output.len(), 9);
        assert_eq!(output[0]["address"], 100);
        for (i, row) in output.iter().skip(1).enumerate() {
            assert_eq!(row["address"], 50006 + i * 1000);
            assert_eq!(row["dev_id"], 1);
            assert_eq!(row["register_count"], 2);
            assert_eq!(row["scale"], 0.1);
        }
        assert_eq!(graph, before);
    }
    #[test]
    fn rejects_missing_duplicate_unknown_and_overlapping_script_results() {
        let (graph, rule) = fixture();
        for script in [
            "export default () => []",
            "export default (p) => Array(9).fill({source_id:10,device_code:'LOCAL',address:100,dev_id:1})",
            "export default (p) => p.flatMap(r=>r.devices.map(d=>({source_id:r.source_id,device_code:d.code,address:100,dev_id:1})))",
            "export default () => { while(true){} }",
        ] {
            let mut invalid = rule.clone();
            invalid["script"] = json!(script);
            assert!(evaluate(&graph, "UPM_DEMO", &invalid).is_err());
        }
        let mut changed = rule.clone();
        changed["parameters"]["upm_dev_id"] = json!(248);
        assert!(evaluate(&graph, "UPM_DEMO", &changed).is_err());
    }
    #[test]
    fn immutable_source_fields_and_receiver_parameters_are_preserved() {
        let (graph, mut rule) = fixture();
        rule["parameters"]["upm_dev_id"] = json!(7);
        rule["parameters"]["poll_interval"] = json!(2000);
        let output = evaluate(&graph, "UPM_DEMO", &rule).unwrap();
        assert!(
            output
                .iter()
                .all(|r| r["dev_id"] == 7 && r["poll_interval"] == 2000 && r["can_edit"] == false)
        );
        let mut invalid = graph.clone();
        invalid["collect_points"] = json!([{"id":1,"board_key":"UPM_DEMO"}]);
        assert_eq!(issues(&invalid).len(), 1);
    }
}
