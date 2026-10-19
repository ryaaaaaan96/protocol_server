//! Project membership grants. Authorization is checked against both sides of the
//! full graph diff, after related changes and SQL-derived effects are materialized.
use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
    topology::{self, find, num, rows},
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub model_id: i64,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<i64>,
}
impl Grant {
    fn new(model_id: i64, scope: &str, contract_id: Option<i64>) -> Self {
        Self {
            model_id,
            scope: scope.into(),
            contract_id,
        }
    }
}
#[derive(Clone, Debug)]
pub struct Access {
    role: String,
    edit_scope: String,
    grants: Vec<Grant>,
}
impl Access {
    pub fn all(&self) -> bool {
        self.role == "admin" || self.role == "engineer" && self.edit_scope == "all"
    }
    pub fn any(&self) -> bool {
        self.all() || self.role == "engineer" && !self.grants.is_empty()
    }
    pub fn allows(&self, resource: &Grant) -> bool {
        self.all()
            || self.role == "engineer"
                && self.grants.iter().any(|g| {
                    g.model_id == resource.model_id && (g.scope == "board" || g == resource)
                })
    }
    pub fn value(&self, graph: &Value) -> Value {
        let catalog: Vec<_> = rows(graph,"board_models").iter().map(|model| {
            let endpoints: Vec<_> = rows(graph,"endpoints").iter().filter(|e| e["model_id"] == model["id"]).collect();
            let contracts: BTreeSet<_> = endpoints.iter().map(|e| num(e,"contract_id")).collect();
            let protocols: Vec<_> = contracts.into_iter().filter_map(|id| find(graph,"protocol_contracts",id)).map(|c| {
                let matched: Vec<_> = endpoints.iter().filter(|e| e["contract_id"] == c["id"]).collect();
                let transports: BTreeSet<_> = matched.iter().filter_map(|e| e["transport"].as_str()).collect();
                json!({"contract_id":c["id"],"name":c["name"],"code":c["code"],"protocol":c["protocol"],"transports":transports,"endpoints":matched.iter().map(|e|e["name"].clone()).collect::<Vec<_>>()})
            }).collect();
            json!({"model_id":model["id"],"model_name":model["name"],"model_code":model["code"],"protocols":protocols})
        }).collect();
        json!({"role":self.role,"edit_scope":self.edit_scope,"grants":self.grants,"can_edit":self.any(),"can_manage_project":self.all(),"catalog":catalog})
    }
    pub fn require_any(&self) -> Result<()> {
        if self.any() {
            Ok(())
        } else {
            Err(denied(vec![
                json!({"scope":"assigned","label":"至少一个板卡或协议编辑范围"}),
            ]))
        }
    }
    pub fn require_all(&self) -> Result<()> {
        if self.all() {
            Ok(())
        } else {
            Err(denied(vec![
                json!({"scope":"project","label":"全项目编辑权限"}),
            ]))
        }
    }
}
pub async fn load(tx: &mut Transaction<'_, Postgres>, pid: i64) -> Result<Access> {
    let member: Value = sqlx::query_scalar("SELECT CASE WHEN app_is_admin() THEN jsonb_build_object('role','admin','edit_scope','all') ELSE COALESCE((SELECT to_jsonb(m) FROM project_members m WHERE m.project_id=$1 AND m.user_id=app_user_id()), '{}'::jsonb) END")
        .bind(pid).fetch_one(&mut **tx).await?;
    let grants: Vec<Value> = db::all_json(tx,"SELECT jsonb_build_object('model_id',model_id,'scope',scope,'contract_id',contract_id) FROM project_member_grants g WHERE project_id=$1 AND user_id=app_user_id() AND (scope<>'protocol' OR EXISTS(SELECT 1 FROM endpoints e WHERE e.project_id=g.project_id AND e.model_id=g.model_id AND e.contract_id=g.contract_id)) ORDER BY model_id,scope,contract_id",pid).await?;
    Ok(Access {
        role: member["role"].as_str().unwrap_or("viewer").into(),
        edit_scope: member["edit_scope"].as_str().unwrap_or("scoped").into(),
        grants: grants
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<_, _>>()?,
    })
}
pub async fn read(State(s): State<AppState>, u: User, Path(pid): Path<i64>) -> Result<Json<Value>> {
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let access = load(&mut tx, pid).await?;
    let graph = catalog(&mut tx, pid).await?;
    Ok(Json(access.value(&graph)))
}
/// The grant picker needs the scope catalog, not workbook cells or point rows.
pub async fn catalog(tx: &mut Transaction<'_, Postgres>, pid: i64) -> Result<Value> {
    let mut graph = json!({});
    graph["project_config"] =
        sqlx::query_scalar::<_, Option<Value>>("SELECT topology_config FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut **tx)
            .await?
            .unwrap_or(Value::Null);
    for table in ["board_models", "endpoints", "protocol_contracts"] {
        graph[table] = json!(
            db::all_json(
                tx,
                &format!("SELECT to_jsonb(t) FROM {table} t WHERE project_id=$1 ORDER BY id"),
                pid
            )
            .await?
        );
    }
    Ok(graph)
}
pub async fn require_all(tx: &mut Transaction<'_, Postgres>, pid: i64) -> Result<()> {
    load(tx, pid).await?.require_all()
}
fn denied(required: Vec<Value>) -> AppError {
    let labels = required
        .iter()
        .filter_map(|v| v["label"].as_str())
        .take(6)
        .collect::<Vec<_>>()
        .join("、");
    AppError(
        StatusCode::FORBIDDEN,
        format!("此修改超出你的编辑范围，需要：{labels}。请联系管理员分配权限；当前草稿仍保留。"),
        Some(json!({"code":"EDIT_SCOPE_DENIED","required":required})),
    )
}

/// An empty resource set denotes project-wide/unassigned data, never implicit access.
pub fn resources(graph: &Value, table: &str, row: &Value) -> BTreeSet<Grant> {
    let mut out = BTreeSet::new();
    let internal = |mid| Grant::new(mid, "internal", None);
    let board = |mid| Grant::new(mid, "board", None);
    let protocol =
        |e: &Value| Grant::new(num(e, "model_id"), "protocol", Some(num(e, "contract_id")));
    match table {
        "process_points" | "transmit_points" => {
            if let Some(kind) = graph["project_config"]["board_types"]
                .as_array()
                .and_then(|types| types.iter().find(|kind| kind["code"] == row["board_key"]))
            {
                if let Some(model) = rows(graph, "board_models")
                    .iter()
                    .find(|m| m["code"] == kind["model_code"])
                {
                    let mid = num(model, "id");
                    if table == "process_points" {
                        out.insert(internal(mid));
                    } else if let Some(endpoint) = rows(graph, "endpoints").iter().find(|e| {
                        num(e, "model_id") == mid
                            && e["code"] == row["endpoint_key"]
                            && e["role"] == "server"
                    }) {
                        out.insert(protocol(endpoint));
                    } else {
                        out.insert(board(mid));
                    }
                }
            }
        }
        "board_models" => {
            out.insert(board(num(row, "id")));
        }
        "boards" => {
            out.insert(board(num(row, "model_id")));
        }
        "signal_groups" | "device_contexts" => {
            out.insert(internal(num(row, "model_id")));
        }
        "signals" | "v_signals" => {
            if let Some(group) = find(graph, "signal_groups", num(row, "group_id")) {
                out.insert(internal(num(group, "model_id")));
            }
        }
        "signal_ranges" => {
            if let Some(signal) = find(graph, "signals", num(row, "signal_id")) {
                out.extend(resources(graph, "signals", signal));
            }
        }
        "endpoints" => {
            out.insert(protocol(row));
        }
        "signal_bindings" | "v_bindings" => {
            if let Some(e) = find(graph, "endpoints", num(row, "endpoint_id")) {
                out.insert(protocol(e));
            }
        }
        "protocol_contracts" | "protocol_fields" | "v_protocol_fields" => {
            let cid = if table == "protocol_contracts" {
                num(row, "id")
            } else {
                num(row, "contract_id")
            };
            for e in rows(graph, "endpoints")
                .iter()
                .filter(|e| num(e, "contract_id") == cid)
            {
                out.insert(protocol(e));
            }
        }
        "board_links" | "v_topology_links" => {
            for key in ["client_endpoint_id", "server_endpoint_id"] {
                if let Some(e) = find(graph, "endpoints", num(row, key)) {
                    out.insert(protocol(e));
                }
            }
        }
        "passthrough_routes" | "v_passthrough_fields" => {
            for key in ["client_endpoint_id", "server_endpoint_id"] {
                if let Some(e) = find(graph, "endpoints", num(row, key)) {
                    out.insert(protocol(e));
                }
            }
        }
        "data_items" => {
            for signal in rows(graph, "signals")
                .iter()
                .filter(|s| s["data_item_id"] == row["id"])
            {
                out.extend(resources(graph, "signals", signal));
            }
            for field in rows(graph, "protocol_fields")
                .iter()
                .filter(|f| f["data_item_id"] == row["id"])
            {
                out.extend(resources(graph, "protocol_fields", field));
            }
        }
        "platform_signals" => {
            for signal in rows(graph, "signals")
                .iter()
                .filter(|s| s["sig_symbol"] == row["symbol"])
            {
                out.extend(resources(graph, "signals", signal));
            }
        }
        _ => {}
    }
    out
}
fn described(graph: &Value, grant: &Grant) -> Value {
    let model = find(graph, "board_models", grant.model_id);
    let name = model.and_then(|m| m["name"].as_str()).unwrap_or("未知板卡");
    let suffix = match grant.scope.as_str() {
        "board" => "全部配置",
        "internal" => "内部/处理点表",
        _ => grant
            .contract_id
            .and_then(|id| find(graph, "protocol_contracts", id))
            .and_then(|c| c["name"].as_str())
            .unwrap_or("协议"),
    };
    let mut result = json!(grant);
    result["label"] = json!(format!("{name} / {suffix}"));
    result
}
pub fn check_change(access: &Access, before: &Value, after: &Value) -> Result<()> {
    if access.all() {
        return Ok(());
    }
    access.require_any()?;
    if before["project_config"] != after["project_config"] {
        return access.require_all();
    }
    let mut required = BTreeMap::new();
    for table in topology::TABLES.iter().chain(topology::VIEWS.iter()) {
        let key = |r: &Value| {
            if *table == "v_passthrough_fields" {
                format!("{}:{}", r["route_id"], r["field_id"])
            } else {
                r["id"].to_string()
            }
        };
        let b: BTreeMap<_, _> = rows(before, table).iter().map(|r| (key(r), r)).collect();
        let a: BTreeMap<_, _> = rows(after, table).iter().map(|r| (key(r), r)).collect();
        for id in b.keys().chain(a.keys()).collect::<BTreeSet<_>>() {
            if b.get(id) == a.get(id) {
                continue;
            }
            // Both former and new ownership must be authorized. This also checks
            // address shifts, shared definitions, generated range normalization,
            // cascades and every row of a batch/reorder without a request allowlist.
            for (graph, row) in [(before, b.get(id)), (after, a.get(id))] {
                if let Some(row) = row {
                    let scopes = resources(graph, table, row);
                    if scopes.is_empty() {
                        return access.require_all();
                    }
                    for scope in scopes {
                        if !access.allows(&scope) {
                            required.insert(scope.clone(), described(graph, &scope));
                        }
                    }
                }
            }
        }
    }
    if required.is_empty() {
        Ok(())
    } else {
        Err(denied(required.into_values().collect()))
    }
}
pub fn can_edit_row(access: &Access, graph: &Value, table: &str, row: &Value) -> bool {
    let scopes = resources(graph, table, row);
    access.all() || !scopes.is_empty() && scopes.iter().all(|r| access.allows(r))
}
pub async fn validate_grants(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    grants: &[Grant],
) -> Result<()> {
    if grants.len() > 1000 {
        return Err(AppError::bad("最多配置 1000 个编辑范围"));
    }
    let mut seen = BTreeSet::new();
    for grant in grants {
        if grant.model_id <= 0
            || !["board", "internal", "protocol"].contains(&grant.scope.as_str())
            || (grant.scope == "protocol") != grant.contract_id.is_some()
            || !seen.insert(grant)
        {
            return Err(AppError::bad("板卡/协议编辑范围无效或重复"));
        }
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM board_models WHERE project_id=$1 AND id=$2) AND ($3::bigint IS NULL OR EXISTS(SELECT 1 FROM endpoints WHERE project_id=$1 AND model_id=$2 AND contract_id=$3))")
            .bind(pid).bind(grant.model_id).bind(grant.contract_id).fetch_one(&mut **tx).await?;
        if !valid {
            return Err(AppError::bad("授权板卡或协议不属于当前项目/板卡"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scoped(grants: Vec<Grant>) -> Access {
        Access {
            role: "engineer".into(),
            edit_scope: "scoped".into(),
            grants,
        }
    }
    #[test]
    fn board_includes_internal_and_protocol_but_not_other_board() {
        let access = scoped(vec![Grant::new(1, "board", None)]);
        assert!(access.allows(&Grant::new(1, "internal", None)));
        assert!(access.allows(&Grant::new(1, "protocol", Some(3))));
        assert!(!access.allows(&Grant::new(2, "protocol", Some(3))));
        assert!(!access.all());
        let viewer = Access {
            role: "viewer".into(),
            edit_scope: "all".into(),
            grants: access.grants,
        };
        assert!(!viewer.any());
        assert!(!viewer.allows(&Grant::new(1, "internal", None)));
    }
    #[test]
    fn native_points_use_applied_board_and_explicit_protocol_grants() {
        let mut graph = json!({"project_config":{"board_types":[{"code":"POWER","model_code":"DSP","point_storage":"native"}]},
            "board_models":[{"id":1,"code":"DSP"},{"id":2,"code":"UPM"}],"endpoints":[]});
        let process = json!({"id":1,"board_key":"POWER"});
        let transmit = json!({"id":1,"board_key":"POWER","endpoint_key":"UPP_SERVICE"});
        let internal = scoped(vec![Grant::new(1, "internal", None)]);
        assert!(can_edit_row(&internal, &graph, "process_points", &process));
        assert!(!can_edit_row(
            &internal,
            &graph,
            "transmit_points",
            &transmit
        ));
        assert!(can_edit_row(
            &scoped(vec![Grant::new(1, "board", None)]),
            &graph,
            "transmit_points",
            &transmit
        ));
        assert!(!can_edit_row(
            &scoped(vec![Grant::new(2, "board", None)]),
            &graph,
            "process_points",
            &process
        ));
        graph["endpoints"] =
            json!([{"id":9,"model_id":1,"code":"UPP_SERVICE","role":"server","contract_id":3}]);
        assert!(can_edit_row(
            &scoped(vec![Grant::new(1, "protocol", Some(3))]),
            &graph,
            "transmit_points",
            &transmit
        ));
        assert!(!can_edit_row(
            &scoped(vec![Grant::new(1, "protocol", Some(4))]),
            &graph,
            "transmit_points",
            &transmit
        ));
    }
    #[test]
    fn moving_owned_records_does_not_discard_the_old_owner() {
        let before = json!({"signal_groups":[{"id":1,"model_id":1},{"id":2,"model_id":2}],"signals":[{"id":1,"group_id":2}]});
        let mut after = before.clone();
        after["signals"][0]["group_id"] = json!(1);
        let access = scoped(vec![Grant::new(1, "board", None)]);
        let err = check_change(&access, &before, &after).unwrap_err();
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert_eq!(err.2.unwrap()["required"][0]["model_id"], 2);
    }
    #[test]
    fn computed_address_shifts_require_all_contract_consumers() {
        let before = json!({"endpoints":[{"id":1,"model_id":1,"contract_id":7},{"id":2,"model_id":2,"contract_id":7}],"v_protocol_fields":[{"id":5,"contract_id":7,"effective_address":10}]});
        let mut after = before.clone();
        after["v_protocol_fields"][0]["effective_address"] = json!(11);
        let partial = scoped(vec![Grant::new(1, "protocol", Some(7))]);
        assert!(check_change(&partial, &before, &after).is_err());
        let both = scoped(vec![
            Grant::new(1, "protocol", Some(7)),
            Grant::new(2, "protocol", Some(7)),
        ]);
        assert!(check_change(&both, &before, &after).is_ok());
    }
    #[test]
    fn unassigned_definitions_are_project_wide() {
        let before = json!({"data_items":[]});
        let after = json!({"data_items":[{"id":1,"name":"unassigned"}]});
        assert!(
            check_change(&scoped(vec![Grant::new(1, "board", None)]), &before, &after).is_err()
        );
    }
}
