use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
    model,
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BoardType {
    pub code: String,
    pub name: String,
    pub model_code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point_storage: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub point_groups: Vec<PointGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub point_endpoints: Vec<PointEndpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point_rules: Option<crate::board_rules::Rules>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workbook_import: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PointGroup {
    pub code: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<PointDevice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collect_enabled: Option<bool>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PointDevice {
    pub code: String,
    pub name: String,
    pub dev_id: u16,
    pub modbus_base: u16,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PointEndpoint {
    pub code: String,
    pub name: String,
    pub protocol: String,
    #[serde(default = "transmit_direction", skip_serializing_if = "is_transmit")]
    pub direction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subset_of: Option<EndpointSource>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EndpointSource {
    pub board_key: String,
    pub endpoint_key: String,
}
fn transmit_direction() -> String {
    "transmit".into()
}
fn is_transmit(direction: &String) -> bool {
    direction == "transmit"
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Root {
    #[serde(rename = "type")]
    pub kind: String,
    pub quantity: u32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub protocol: String,
    pub transport: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mount {
    pub parent: String,
    pub child: String,
    pub quantity: u32,
    pub connections: Vec<Connection>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub board_types: Vec<BoardType>,
    pub root: Root,
    pub mounts: Vec<Mount>,
}
impl Config {
    pub fn parse(mut value: Value) -> Result<Self> {
        // Version 1 attached a single protocol to each mount. Normalize on import,
        // preserving one mount/count even when version 2 declares several protocols.
        if value["version"] == 1 {
            value["version"] = json!(2);
            let mounts = value["mounts"]
                .as_array_mut()
                .ok_or_else(|| AppError::bad("项目 JSON 的 mounts 必须是数组"))?;
            for mount in mounts {
                let object = mount
                    .as_object_mut()
                    .ok_or_else(|| AppError::bad("挂载关系必须是对象"))?;
                if object.contains_key("connections") {
                    return Err(AppError::bad("connections 数组须使用项目配置 version 2"));
                }
                let protocol = object.remove("protocol").unwrap_or(Value::Null);
                let transport = object.remove("transport").unwrap_or(Value::Null);
                if protocol.is_null() != transport.is_null() {
                    return Err(AppError::bad(
                        "旧版配置的协议与传输方式须同时填写，或同时为 null",
                    ));
                }
                object.insert(
                    "connections".into(),
                    if protocol.is_null() {
                        json!([])
                    } else {
                        json!([{"protocol":protocol,"transport":transport}])
                    },
                );
            }
        }
        let c: Self = serde_json::from_value(value)
            .map_err(|e| AppError::bad(format!("项目 JSON 格式错误：{e}")))?;
        c.counts()?;
        Ok(c)
    }
    pub fn counts(&self) -> Result<BTreeMap<String, u32>> {
        if self.version != 2 || self.board_types.is_empty() || self.board_types.len() > 32 {
            return Err(AppError::bad(
                "项目配置须为 version 2（兼容导入 version 1），板卡类型数量须为 1～32",
            ));
        }
        let mut codes = BTreeSet::new();
        let mut models = BTreeSet::new();
        for t in &self.board_types {
            if let Some(rules) = &t.point_rules {
                crate::board_rules::validate(rules)?;
            }
            if t.point_storage
                .as_deref()
                .is_some_and(|storage| !["native", "derived"].contains(&storage))
            {
                return Err(AppError::bad(
                    "point_storage 仅支持 native 或 derived，省略时板卡仅用于拓扑预览",
                ));
            }
            if t.point_storage.is_none() && (t.point_rules.is_some() || t.workbook_import.is_some())
            {
                return Err(AppError::bad(
                    "point_rules 和 workbook_import 需要 native 存储",
                ));
            }
            let mut groups = BTreeSet::new();
            if t.point_storage.as_deref() == Some("derived")
                && (t.point_rules.is_some()
                    || t.workbook_import.is_some()
                    || t.point_endpoints.len() != 1
                    || t.point_endpoints.iter().any(|endpoint| {
                        endpoint.direction != "collect" || endpoint.protocol != "MODBUS"
                    }))
            {
                return Err(AppError::bad(
                    "derived 板卡只支持一个 Modbus 采集端点，不接受存储规则或工作簿导入",
                ));
            }
            if t.point_groups.iter().any(|g| {
                !model::identifier(&g.code)
                    || g.code.len() > 80
                    || g.name.trim().is_empty()
                    || g.name.len() > 300
                    || !groups.insert(&g.code)
            }) || (t.point_storage.is_some() && t.point_groups.is_empty())
                || (t.point_storage.is_none() && !t.point_groups.is_empty())
            {
                return Err(AppError::bad(
                    "native 板卡须在 point_groups 中定义唯一、有效的点表分组",
                ));
            }
            let mut endpoints = BTreeSet::new();
            if t.point_endpoints.iter().any(|e| {
                !model::identifier(&e.code)
                    || e.code.len() > 80
                    || e.name.trim().is_empty()
                    || e.name.len() > 300
                    || !["UPP", "MODBUS"].contains(&e.protocol.as_str())
                    || !["collect", "transmit"].contains(&e.direction.as_str())
                    || (e.direction == "collect"
                        && e.protocol != "UPP"
                        && t.point_storage.as_deref() != Some("derived"))
                    || !endpoints.insert(&e.code)
            }) || (t.point_storage.is_none() && !t.point_endpoints.is_empty())
            {
                return Err(AppError::bad(
                    "point_endpoints 须为 native 板卡定义有效的协议与方向；采集当前支持 UPP",
                ));
            }
            let mut devices = BTreeSet::new();
            let mut device_ids = BTreeSet::new();
            for group in &t.point_groups {
                if group.devices.len() > 1024
                    || group.devices.iter().any(|device| {
                        !model::identifier(&device.code)
                            || device.name.trim().is_empty()
                            || !devices.insert(&device.code)
                            || !device_ids.insert(device.dev_id)
                    })
                {
                    return Err(AppError::bad(
                        "设备实例名称、代码和设备地址须有效，代码和地址在板卡内唯一",
                    ));
                }
            }
            if !model::identifier(&t.code)
                || !model::identifier(&t.model_code)
                || t.code.len() > 80
                || t.model_code.len() > 80
                || t.name.trim().is_empty()
                || t.name.len() > 300
                || !codes.insert(t.code.clone())
                || !models.insert(t.model_code.clone())
            {
                return Err(AppError::bad(
                    "板卡类型代码、模板代码须唯一且为有效标识符，名称不能为空",
                ));
            }
        }
        for board in &self.board_types {
            for endpoint in &board.point_endpoints {
                let Some(source) = &endpoint.subset_of else {
                    continue;
                };
                let target = self
                    .board_types
                    .iter()
                    .find(|candidate| candidate.code == source.board_key);
                let source_endpoint = target.and_then(|candidate| {
                    candidate
                        .point_endpoints
                        .iter()
                        .find(|candidate| candidate.code == source.endpoint_key)
                });
                if endpoint.direction != "collect"
                    || board.code == source.board_key
                    || target.is_none_or(|candidate| {
                        candidate.point_storage.as_deref() != Some("native")
                    })
                    || source_endpoint.is_none_or(|candidate| {
                        candidate.direction != "transmit" || candidate.protocol != endpoint.protocol
                    })
                {
                    return Err(AppError::bad(
                        "subset_of 只能由采集端点引用另一 native 板卡中协议一致的转发端点",
                    ));
                }
            }
        }
        if !codes.contains(&self.root.kind) || self.root.quantity == 0 || self.root.quantity > 1024
        {
            return Err(AppError::bad("根板卡必须存在，数量须为 1～1024"));
        }
        if self.mounts.len() + 1 != codes.len() {
            return Err(AppError::bad("每种非根板卡必须有一个上级挂载关系"));
        }
        let mut children = BTreeSet::new();
        for m in &self.mounts {
            if !codes.contains(&m.parent)
                || !codes.contains(&m.child)
                || m.parent == m.child
                || m.child == self.root.kind
                || !children.insert(m.child.clone())
                || m.quantity == 0
                || m.quantity > 1024
            {
                return Err(AppError::bad(
                    "挂载关系包含未知板卡、重复上级或无效数量（须为 1～1024）",
                ));
            }
            let mut connections = BTreeSet::new();
            for connection in &m.connections {
                if !matches!(connection.protocol.as_str(), "MODBUS" | "UPP")
                    || !matches!(
                        connection.transport.as_str(),
                        "CAN" | "CANFD" | "RS485" | "TCP"
                    )
                {
                    return Err(AppError::bad(
                        "每组连接须配置有效协议与传输方式；connections 为空表示待配置",
                    ));
                }
                if !connections.insert((&connection.protocol, &connection.transport)) {
                    return Err(AppError::bad(
                        "同一挂载关系中不能重复配置相同协议与传输方式",
                    ));
                }
            }
        }
        let mut counts = BTreeMap::from([(self.root.kind.clone(), self.root.quantity)]);
        for _ in 0..codes.len() {
            for m in &self.mounts {
                if let Some(&parent) = counts.get(&m.parent) {
                    let total = parent
                        .checked_mul(m.quantity)
                        .filter(|n| *n <= 1_000_000)
                        .ok_or(AppError::bad("项目挂载数量超过上限"))?;
                    counts.insert(m.child.clone(), total);
                }
            }
        }
        if counts.len() != codes.len() {
            return Err(AppError::bad("板卡挂载存在循环或未连接到根板卡"));
        }
        Ok(counts)
    }
}
pub async fn templates(State(s): State<AppState>, u: User) -> Result<Json<Value>> {
    u.admin()?;
    Ok(Json(
        s.project_files
            .catalog()
            .map_err(|e| AppError::bad(format!("{e:#}")))?,
    ))
}

pub(crate) fn validate_directory(
    files: &crate::project_files::ProjectFiles,
    key: Option<&str>,
    value: &Value,
) -> Result<()> {
    let key = key.ok_or(AppError::bad("项目没有关联配置目录"))?;
    let manifest = files
        .manifest(key)
        .map_err(|e| AppError::bad(format!("{e:#}")))?
        .ok_or(AppError::bad("项目配置目录不存在"))?;
    let configured = Config::parse(manifest["topology"].clone())?;
    for board in Config::parse(value.clone())?.board_types {
        let source = configured.board_types.iter().find(|source|
            source.code == board.code && source.model_code == board.model_code
        ).ok_or_else(|| AppError::bad(format!(
            "板卡 {} / {} 未在项目 {key} 的 project.json 中配置，请先补齐项目清单和板卡目录后重新读取",
            board.code, board.model_code
        )))?;
        if board.directory.is_some() && board.directory != source.directory {
            return Err(AppError::bad(format!(
                "板卡 {} 的 directory 与项目文件不一致，请修改磁盘配置后重新读取",
                board.code
            )));
        }
    }
    Ok(())
}
pub async fn read(State(s): State<AppState>, u: User, Path(pid): Path<i64>) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    let config: Option<Value> =
        sqlx::query_scalar("SELECT topology_config FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    Ok(Json(config.unwrap_or(Value::Null)))
}
pub async fn source(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    let key: Option<String> =
        sqlx::query_scalar("SELECT config_key FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    let key = key.ok_or(AppError::bad("项目没有关联配置目录"))?;
    Ok(Json(
        s.project_files
            .topology_source(&key)
            .map_err(|e| AppError::bad(format!("{e:#}")))?,
    ))
}
pub async fn apply(tx: &mut PgConnection, pid: i64, value: &Value) -> Result<Value> {
    let config = Config::parse(value.clone())?;
    let used = db::all_json(tx, "SELECT to_jsonb(ref) FROM (SELECT board_key,group_key,NULL::text AS endpoint_key FROM points.process_points WHERE project_id=$1 GROUP BY board_key,group_key UNION SELECT board_key,NULL,endpoint_key FROM points.transmit_points WHERE project_id=$1 GROUP BY board_key,endpoint_key UNION SELECT board_key,NULL,endpoint_key FROM points.collect_points WHERE project_id=$1 GROUP BY board_key,endpoint_key UNION SELECT g->>'board_key',NULL,g->>'endpoint_key' FROM jsonb_array_elements(COALESCE(NULLIF(current_setting('app.project_grants',true),''),'[]')::jsonb) g) ref", pid).await?;
    validate_references(&config, &used)?;
    let value = serde_json::to_value(&config)?;
    sqlx::query("UPDATE meta.project_state SET topology_config=$2 WHERE id=$1")
        .bind(pid)
        .bind(&value)
        .execute(&mut *tx)
        .await?;
    Ok(json!({"id":pid,"config":value,"counts":config.counts()?}))
}

/// Every live point and permission refers to stable keys in the applied JSON.
/// History intentionally does not participate: it keeps its original snapshot.
fn validate_references(config: &Config, used: &[Value]) -> Result<()> {
    for reference in used {
        let key = reference["board_key"].as_str().unwrap_or_default();
        let board = config
            .board_types
            .iter()
            .find(|b| b.code == key)
            .ok_or_else(|| {
                AppError::bad(format!("板卡 {key} 已有点表或成员授权，不能删除或修改代码"))
            })?;
        if let Some(group) = reference["group_key"].as_str() {
            if board.point_storage.as_deref() != Some("native")
                || !board.point_groups.iter().any(|g| g.code == group)
            {
                return Err(AppError::bad(format!(
                    "板卡 {key} 的分组 {group} 已有内部数据，不能移除"
                )));
            }
        }
        if let Some(endpoint) = reference["endpoint_key"].as_str() {
            if board.point_storage.as_deref() != Some("native")
                || !board.point_endpoints.iter().any(|e| e.code == endpoint)
            {
                return Err(AppError::bad(format!(
                    "板卡 {key} 的端点 {endpoint} 已有转发数据或成员授权，不能移除"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> Value {
        let mut value = serde_json::from_str::<Value>(include_str!(
            "../config/dc-ups/project.json"
        ))
        .unwrap()["topology"]
            .clone();
        for board in value["board_types"].as_array_mut().unwrap() {
            for endpoint in board
                .get_mut("point_endpoints")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                endpoint.as_object_mut().unwrap().remove("subset_of");
            }
        }
        value
    }
    #[test]
    fn collection_subset_references_a_compatible_foreign_transmit_endpoint() {
        let source = serde_json::from_str::<Value>(include_str!("../config/dc-ups/project.json"))
            .unwrap()["topology"]
            .clone();
        Config::parse(source.clone()).unwrap();
        for relation in [
            json!({"board_key":"MISSING","endpoint_key":"UPP_SERVICE"}),
            json!({"board_key":"DSP","endpoint_key":"MISSING"}),
            json!({"board_key":"UPM","endpoint_key":"UPP_SERVICE"}),
        ] {
            let mut value = source.clone();
            value["board_types"][1]["point_endpoints"][0]["subset_of"] = relation;
            assert!(Config::parse(value).is_err());
        }
        let mut value = source;
        value["board_types"][2]["point_endpoints"][0]["protocol"] = json!("MODBUS");
        assert!(Config::parse(value).is_err());
    }
    #[test]
    fn type_counts_do_not_expand_instances() {
        let mut c = Config::parse(example()).unwrap();
        let n = c.counts().unwrap();
        assert_eq!(c.board_types.len(), 6);
        assert_eq!(n["CSU"], 1);
        assert_eq!(n["UPM_DEMO"], 1);
        assert_eq!(n["UPM"], 24);
        assert_eq!(n["DSP"], 192);
        assert_eq!(n["IDU_T"], 1);
        assert_eq!(n["IDU_R"], 4);
        let upm = c.mounts.iter_mut().find(|m| m.child == "UPM").unwrap();
        assert_eq!(upm.parent, "UPM_DEMO");
        assert_eq!(upm.connections.len(), 1);
        assert_eq!(upm.connections[0].protocol, "MODBUS");
        assert_eq!(upm.connections[0].transport, "RS485");
        // Multiple protocols on a mount still share a single device count.
        upm.connections.push(Connection {
            protocol: "UPP".into(),
            transport: "CANFD".into(),
        });
        assert_eq!(c.counts().unwrap(), n);
    }
    #[test]
    fn rejects_invalid_hierarchy() {
        let mut v = example();
        v["mounts"][0]["parent"] = json!("DSP");
        assert!(Config::parse(v).is_err());
        let mut v = example();
        v["mounts"][0]["quantity"] = json!(0);
        assert!(Config::parse(v).is_err());
        let mut v = example();
        v["mounts"][0]["child"] = json!("OTHER");
        assert!(Config::parse(v).is_err());
        let mut v = example();
        v["board_types"][1]["model_code"] = json!("CSU");
        assert!(Config::parse(v).is_err());
        let mut v = example();
        v["mounts"][0]["connections"][0]["transport"] = json!("UNKNOWN");
        assert!(Config::parse(v).is_err());
        let mut v = example();
        v["version"] = json!(3);
        assert!(Config::parse(v).is_err());
        let mut v = example();
        let duplicate = v["mounts"][0]["connections"][0].clone();
        v["mounts"][0]["connections"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(Config::parse(v).is_err());
        let mut v = example();
        v["mounts"][0]["connections"][0]["transport"] = Value::Null;
        assert!(Config::parse(v).is_err());
    }
    #[test]
    fn reads_legacy_single_protocol_without_multiplying_counts() {
        let mut legacy = example();
        legacy["version"] = json!(1);
        for m in legacy["mounts"].as_array_mut().unwrap() {
            let obj = m.as_object_mut().unwrap();
            let connections = obj.remove("connections").unwrap();
            let first = &connections[0];
            obj.insert("protocol".into(), first["protocol"].clone());
            obj.insert("transport".into(), first["transport"].clone());
        }
        legacy["mounts"][0]["protocol"] = Value::Null;
        legacy["mounts"][0]["transport"] = Value::Null;
        let normalized = Config::parse(legacy.clone()).unwrap();
        assert_eq!(normalized.version, 2);
        assert!(normalized.mounts[0].connections.is_empty());
        assert_eq!(normalized.counts().unwrap()["UPM"], 24);
        assert_eq!(normalized.mounts[1].connections[0].protocol, "UPP");
        legacy["mounts"][0]["protocol"] = json!("MODBUS");
        assert!(Config::parse(legacy.clone()).is_err());
        legacy["mounts"][0]["protocol"] = Value::Null;
        legacy["mounts"][0]["connections"] = json!([]);
        assert!(Config::parse(legacy).is_err());
    }
    #[test]
    fn endpoint_keys_are_unique_and_protocol_driven() {
        let mut config = example();
        config["board_types"][2]["point_endpoints"] = json!([
            {"code":"UPP_SERVICE","name":"DSP 转发","protocol":"UPP"}
        ]);
        assert!(Config::parse(config.clone()).is_ok());
        let endpoint = config["board_types"][2]["point_endpoints"][0].clone();
        config["board_types"][2]["point_endpoints"]
            .as_array_mut()
            .unwrap()
            .push(endpoint);
        assert!(Config::parse(config.clone()).is_err());
        config["board_types"][2]["point_endpoints"]
            .as_array_mut()
            .unwrap()
            .pop();
        config["board_types"][2]["point_endpoints"][0]["protocol"] = json!("MODBUS");
        assert!(Config::parse(config).is_ok());
    }
    #[test]
    fn keeps_referenced_board_group_and_endpoint_keys() {
        let mut value = example();
        value["board_types"][2]["point_endpoints"] = json!([
            {"code":"UPP_SERVICE","name":"DSP 转发","protocol":"UPP"}
        ]);
        let config = Config::parse(value.clone()).unwrap();
        let references = vec![
            json!({"board_key":"DSP","group_key":"LOCAL"}),
            json!({"board_key":"DSP","endpoint_key":"UPP_SERVICE"}),
        ];
        assert!(validate_references(&config, &references).is_ok());
        value["board_types"][2]["point_groups"][0]["code"] = json!("OTHER");
        assert!(validate_references(&Config::parse(value.clone()).unwrap(), &references).is_err());
        value["board_types"][2]["point_groups"][0]["code"] = json!("LOCAL");
        value["board_types"][2]["point_endpoints"][0]["code"] = json!("OTHER");
        assert!(validate_references(&Config::parse(value).unwrap(), &references).is_err());
        assert!(validate_references(&config, &[json!({"board_key":"MISSING"})]).is_err());
    }
}
