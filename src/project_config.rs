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
use sqlx::{Postgres, Transaction};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BoardType {
    pub code: String,
    pub name: String,
    pub model_code: String,
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
pub async fn template(_u: User) -> Result<Json<Value>> {
    let source = std::fs::read_to_string("config/project.example.json")
        .unwrap_or_else(|_| include_str!("../config/project.example.json").to_string());
    Ok(Json(serde_json::to_value(Config::parse(
        serde_json::from_str(&source)?,
    )?)?))
}
pub async fn read(State(s): State<AppState>, u: User, Path(pid): Path<i64>) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    let config: Option<Value> =
        sqlx::query_scalar("SELECT topology_config FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    Ok(Json(config.unwrap_or(Value::Null)))
}
pub async fn apply(tx: &mut Transaction<'_, Postgres>, pid: i64, value: &Value) -> Result<Value> {
    let config = Config::parse(value.clone())?;
    let old: Option<Value> = sqlx::query_scalar("SELECT topology_config FROM projects WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut **tx)
        .await?;
    if let Some(old) = old {
        for t in Config::parse(old)?.board_types {
            if !config
                .board_types
                .iter()
                .any(|n| n.model_code == t.model_code)
            {
                let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM board_models m WHERE m.project_id=$1 AND m.code=$2 AND (EXISTS(SELECT 1 FROM signal_groups g WHERE g.model_id=m.id) OR EXISTS(SELECT 1 FROM endpoints e WHERE e.model_id=m.id)))").bind(pid).bind(&t.model_code).fetch_one(&mut **tx).await?;
                if used {
                    return Err(AppError::bad(format!(
                        "{} 已有信号或协议配置，不能从项目移除",
                        t.name
                    )));
                }
            }
        }
    }
    for t in &config.board_types {
        sqlx::query("INSERT INTO board_models(project_id,code,name) VALUES($1,$2,$3) ON CONFLICT(project_id,code) DO NOTHING").bind(pid).bind(&t.model_code).bind(&t.name).execute(&mut **tx).await?;
    }
    let value = serde_json::to_value(&config)?;
    sqlx::query("UPDATE projects SET topology_config=$2 WHERE id=$1")
        .bind(pid)
        .bind(&value)
        .execute(&mut **tx)
        .await?;
    Ok(json!({"id":pid,"config":value,"counts":config.counts()?}))
}

// A diagram's protocol must agree with the shared endpoint contract when one exists.
pub fn relationship_issues(g: &Value) -> Vec<Value> {
    use crate::topology::{find, num, rows, strv};
    let Ok(config) = Config::parse(g["project_config"].clone()) else {
        return vec![];
    };
    let mut issues = Vec::new();
    for (index, m) in config.mounts.iter().enumerate() {
        let model_id = |code: &str| {
            config
                .board_types
                .iter()
                .find(|t| t.code == code)
                .and_then(|t| {
                    rows(g, "board_models")
                        .iter()
                        .find(|b| b["code"] == t.model_code)
                })
                .map(|b| num(b, "id"))
        };
        let Some(parent) = model_id(&m.parent) else {
            continue;
        };
        let Some(child) = model_id(&m.child) else {
            continue;
        };
        let mut actual: BTreeMap<i64, BTreeSet<(&str, &str)>> = BTreeMap::new();
        for ce in rows(g, "endpoints")
            .iter()
            .filter(|e| num(e, "model_id") == parent)
        {
            for se in rows(g, "endpoints").iter().filter(|e| {
                num(e, "model_id") == child
                    && e["role"] != ce["role"]
                    && e["contract_id"] == ce["contract_id"]
            }) {
                if let Some(contract) = find(g, "protocol_contracts", num(ce, "contract_id")) {
                    let matches = actual.entry(num(contract, "id")).or_default();
                    // A contract may also be served on unrelated interfaces. Compare
                    // only the transports that these two types have in common.
                    if ce["transport"] == se["transport"] {
                        matches.insert((strv(contract, "protocol"), strv(ce, "transport")));
                    }
                }
            }
        }
        if actual.values().any(|connections| {
            connections.is_empty()
                || connections.iter().any(|(p, t)| {
                    !m.connections
                        .iter()
                        .any(|c| c.protocol == *p && c.transport == *t)
                })
        }) {
            issues.push(json!({"key":format!("project_config:protocol:{index}"),"level":"error","entity":"project_config","id":0,"name":format!("{} ↔ {}",m.parent,m.child),"code":"protocol","message":"项目 JSON 的协议/传输方式与现有板卡端点契约不一致，请同步检查挂载关系和端点配置"}));
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> Value {
        serde_json::from_str(include_str!("../config/project.example.json")).unwrap()
    }
    #[test]
    fn type_counts_do_not_expand_instances() {
        let c = Config::parse(example()).unwrap();
        let n = c.counts().unwrap();
        assert_eq!(c.board_types.len(), 5);
        assert_eq!(n["CSU"], 1);
        assert_eq!(n["UPM"], 24);
        assert_eq!(n["DSP"], 192);
        assert_eq!(n["IDU_T"], 1);
        assert_eq!(n["IDU_R"], 4);
        assert_eq!(c.mounts[0].connections.len(), 2);
        assert!(
            c.mounts[0]
                .connections
                .iter()
                .all(|c| c.transport == "CANFD")
        );
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
    fn validates_both_canfd_protocols_against_shared_endpoints() {
        let mut graph = json!({
            "project_config": example(),
            "board_models": [{"id":1,"code":"CSU"},{"id":2,"code":"UPM_ARM"}],
            "protocol_contracts": [{"id":10,"protocol":"MODBUS"},{"id":20,"protocol":"UPP"}],
            "endpoints": [
                {"model_id":1,"contract_id":10,"role":"client","transport":"CANFD"},
                {"model_id":2,"contract_id":10,"role":"server","transport":"CANFD"},
                {"model_id":1,"contract_id":20,"role":"client","transport":"CANFD"},
                {"model_id":2,"contract_id":20,"role":"server","transport":"CANFD"},
                {"model_id":2,"contract_id":10,"role":"server","transport":"RS485"}
            ]
        });
        assert!(relationship_issues(&graph).is_empty());
        graph["project_config"]["mounts"][0]["connections"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_eq!(relationship_issues(&graph).len(), 1);
        graph["project_config"] = example();
        graph["endpoints"][0]["role"] = json!("server");
        graph["endpoints"][1]["role"] = json!("client");
        assert!(relationship_issues(&graph).is_empty());
        graph["endpoints"][3]["transport"] = json!("CAN");
        assert_eq!(relationship_issues(&graph).len(), 1);
    }
}
