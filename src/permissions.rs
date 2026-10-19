//! Project membership scopes use stable board/endpoint keys from project JSON.
use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
    model,
    topology::rows,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub board_key: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_key: Option<String>,
}
impl Grant {
    fn new(board_key: &str, scope: &str, endpoint_key: Option<&str>) -> Self {
        Self {
            board_key: board_key.into(),
            scope: scope.into(),
            endpoint_key: endpoint_key.map(str::to_owned),
        }
    }
}
#[derive(Clone, Debug)]
pub struct Access {
    role: String,
    edit_scope: String,
    grants: Vec<Grant>,
}
fn board<'a>(graph: &'a Value, key: &str) -> Option<&'a Value> {
    graph["project_config"]["board_types"]
        .as_array()?
        .iter()
        .find(|b| b["code"] == key)
}
fn endpoint<'a>(board: &'a Value, key: &str) -> Option<&'a Value> {
    board["point_endpoints"]
        .as_array()?
        .iter()
        .find(|e| e["code"] == key)
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
                    g.board_key == resource.board_key && (g.scope == "board" || g == resource)
                })
    }
    pub fn value(&self, graph: &Value) -> Value {
        let catalog: Vec<_> = graph["project_config"]["board_types"].as_array().into_iter().flatten().map(|b| {
            let endpoints: Vec<_> = b["point_endpoints"].as_array().into_iter().flatten().map(|e| {
                json!({"endpoint_key":e["code"],"name":e["name"],"protocol":e["protocol"]})
            }).collect();
            json!({"board_key":b["code"],"board_name":b["name"],"endpoints":endpoints})
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
pub async fn load(tx: &mut PgConnection, pid: i64) -> Result<Access> {
    let allowed: bool = sqlx::query_scalar("SELECT app_can_access($1)")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    if !allowed {
        return Err(AppError::forbidden());
    }
    let member: Value = sqlx::query_scalar("SELECT app_access()")
        .fetch_one(tx)
        .await?;
    Ok(Access {
        role: member["role"].as_str().unwrap_or("viewer").into(),
        edit_scope: member["edit_scope"].as_str().unwrap_or("scoped").into(),
        grants: serde_json::from_value(
            member["grants"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into(),
        )?,
    })
}
pub async fn read(State(s): State<AppState>, u: User, Path(pid): Path<i64>) -> Result<Json<Value>> {
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let access = load(&mut tx, pid).await?;
    Ok(Json(access.value(&catalog(&mut tx, pid).await?)))
}
pub async fn catalog(tx: &mut PgConnection, pid: i64) -> Result<Value> {
    let config = sqlx::query_scalar::<_, Option<Value>>(
        "SELECT topology_config FROM project_state WHERE id=$1",
    )
    .bind(pid)
    .fetch_one(&mut *tx)
    .await?;
    Ok(json!({"project_config":config}))
}
pub async fn require_all(tx: &mut PgConnection, pid: i64) -> Result<()> {
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

/// Missing ownership is project-wide; never grant access to an unknown key.
pub fn resources(graph: &Value, table: &str, row: &Value) -> BTreeSet<Grant> {
    let mut out = BTreeSet::new();
    let key = row["board_key"].as_str().unwrap_or_default();
    let Some(definition) = board(graph, key) else {
        return out;
    };
    if definition["point_storage"] != "native" {
        return out;
    }
    match table {
        "process_points" => {
            out.insert(Grant::new(key, "internal", None));
        }
        "transmit_points" => {
            if let Some(ep) = row["endpoint_key"]
                .as_str()
                .filter(|e| endpoint(definition, e).is_some())
            {
                out.insert(Grant::new(key, "protocol", Some(ep)));
            }
        }
        _ => {}
    }
    out
}
fn described(graph: &Value, grant: &Grant) -> Value {
    let definition = board(graph, &grant.board_key);
    let name = definition
        .and_then(|b| b["name"].as_str())
        .unwrap_or(&grant.board_key);
    let suffix = match grant.scope.as_str() {
        "board" => "全部配置",
        "internal" => "内部/处理点表",
        _ => definition
            .and_then(|b| endpoint(b, grant.endpoint_key.as_deref().unwrap_or_default()))
            .and_then(|e| e["name"].as_str())
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
    for table in ["process_points", "transmit_points"] {
        let b: BTreeMap<_, _> = rows(before, table)
            .iter()
            .map(|r| (r["id"].to_string(), r))
            .collect();
        let a: BTreeMap<_, _> = rows(after, table)
            .iter()
            .map(|r| (r["id"].to_string(), r))
            .collect();
        for id in b.keys().chain(a.keys()).collect::<BTreeSet<_>>() {
            if b.get(id) == a.get(id) {
                continue;
            }
            // Authorize the former and new owner, including ownership changes.
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
pub fn validate_grants_graph(graph: &Value, grants: &[Grant]) -> Result<()> {
    if grants.len() > 1000 {
        return Err(AppError::bad("最多配置 1000 个编辑范围"));
    }
    let mut seen = BTreeSet::new();
    for grant in grants {
        if !model::identifier(&grant.board_key)
            || grant.board_key.len() > 80
            || !["board", "internal", "protocol"].contains(&grant.scope.as_str())
            || (grant.scope == "protocol") != grant.endpoint_key.is_some()
            || grant
                .endpoint_key
                .as_ref()
                .is_some_and(|e| !model::identifier(e) || e.len() > 80)
            || !seen.insert(grant)
        {
            return Err(AppError::bad("板卡/协议编辑范围无效或重复"));
        }
        let valid = board(graph, &grant.board_key).is_some_and(|b| {
            grant
                .endpoint_key
                .as_deref()
                .is_none_or(|key| endpoint(b, key).is_some())
        });
        if !valid {
            return Err(AppError::bad("授权板卡或端点未在当前项目 JSON 中定义"));
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
    fn graph() -> Value {
        json!({"project_config":{"board_types":[
            {"code":"DSP","name":"DSP 功率板","point_storage":"native","point_endpoints":[{"code":"UPP_SERVICE","name":"UPP","protocol":"UPP"}]},
            {"code":"OTHER","name":"另一个板卡","point_storage":"native","point_endpoints":[{"code":"UPP_SERVICE","name":"UPP","protocol":"UPP"}]}
        ]},"process_points":[],"transmit_points":[]})
    }
    #[test]
    fn board_includes_internal_and_protocol_but_not_other_board() {
        let access = scoped(vec![Grant::new("DSP", "board", None)]);
        assert!(access.allows(&Grant::new("DSP", "internal", None)));
        assert!(access.allows(&Grant::new("DSP", "protocol", Some("UPP_SERVICE"))));
        assert!(!access.allows(&Grant::new("OTHER", "protocol", Some("UPP_SERVICE"))));
        let viewer = Access {
            role: "viewer".into(),
            edit_scope: "all".into(),
            grants: access.grants,
        };
        assert!(!viewer.any());
        assert!(!viewer.allows(&Grant::new("DSP", "internal", None)));
    }
    #[test]
    fn native_points_use_applied_board_and_explicit_endpoint_grants() {
        let graph = graph();
        let process = json!({"id":1,"board_key":"DSP"});
        let transmit = json!({"id":1,"board_key":"DSP","endpoint_key":"UPP_SERVICE"});
        let internal = scoped(vec![Grant::new("DSP", "internal", None)]);
        assert!(can_edit_row(&internal, &graph, "process_points", &process));
        assert!(!can_edit_row(
            &internal,
            &graph,
            "transmit_points",
            &transmit
        ));
        assert!(can_edit_row(
            &scoped(vec![Grant::new("DSP", "board", None)]),
            &graph,
            "transmit_points",
            &transmit
        ));
        assert!(can_edit_row(
            &scoped(vec![Grant::new("DSP", "protocol", Some("UPP_SERVICE"))]),
            &graph,
            "transmit_points",
            &transmit
        ));
        assert!(!can_edit_row(
            &scoped(vec![Grant::new("DSP", "protocol", Some("OTHER_ENDPOINT"))]),
            &graph,
            "transmit_points",
            &transmit
        ));
        assert!(!can_edit_row(
            &internal,
            &graph,
            "process_points",
            &json!({"board_key":"UNKNOWN"})
        ));
    }
    #[test]
    fn moving_owned_records_checks_former_and_new_board() {
        let mut before = graph();
        before["process_points"] = json!([{"id":1,"board_key":"OTHER"}]);
        let mut after = before.clone();
        after["process_points"][0]["board_key"] = json!("DSP");
        let err = check_change(
            &scoped(vec![Grant::new("DSP", "board", None)]),
            &before,
            &after,
        )
        .unwrap_err();
        assert_eq!(err.0, StatusCode::FORBIDDEN);
        assert_eq!(err.2.unwrap()["required"][0]["board_key"], "OTHER");
    }
    #[test]
    fn same_endpoint_key_on_another_board_never_shares_permission() {
        let mut before = graph();
        before["transmit_points"] =
            json!([{"id":1,"board_key":"OTHER","endpoint_key":"UPP_SERVICE","name":"before"}]);
        let mut after = before.clone();
        after["transmit_points"][0]["name"] = json!("after");
        let partial = scoped(vec![Grant::new("DSP", "protocol", Some("UPP_SERVICE"))]);
        assert!(check_change(&partial, &before, &after).is_err());
        let correct = scoped(vec![Grant::new("OTHER", "protocol", Some("UPP_SERVICE"))]);
        assert!(check_change(&correct, &before, &after).is_ok());
    }
    #[test]
    fn changing_configuration_requires_project_scope() {
        let before = graph();
        let mut after = before.clone();
        after["project_config"]["board_types"][0]["name"] = json!("renamed");
        assert!(
            check_change(
                &scoped(vec![Grant::new("DSP", "board", None)]),
                &before,
                &after
            )
            .is_err()
        );
        let catalog = scoped(vec![]).value(&before);
        assert_eq!(catalog["catalog"][0]["board_key"], "DSP");
        assert_eq!(
            catalog["catalog"][0]["endpoints"][0]["endpoint_key"],
            "UPP_SERVICE"
        );
    }
}
