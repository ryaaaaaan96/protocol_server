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
use std::collections::BTreeSet;

pub const TABLES: &[&str] = &[
    "board_models",
    "boards",
    "data_items",
    "signal_groups",
    "signals",
    "signal_ranges",
    "device_contexts",
    "protocol_contracts",
    "protocol_fields",
    "endpoints",
    "signal_bindings",
    "board_links",
    "passthrough_routes",
    "platform_signals",
    "source_records",
];
pub const VIEWS: &[&str] = &[
    "v_signals",
    "v_protocol_fields",
    "v_bindings",
    "v_passthrough_fields",
    "v_topology_links",
];
pub fn columns(entity: &str) -> Option<&'static str> {
    Some(match entity {
        "board_models" => "name,code,description,firmware_profile",
        "boards" => "name,code,model_id",
        "data_items" => "name,data_type,byte_length,unit,default_value,min_value,max_value,notes",
        "signal_groups" => "model_id,name,code",
        "signals" => {
            "group_id,data_item_id,name,enum_name,sig_id,sig_symbol,flags,callback,process_enabled,internal_type"
        }
        "signal_ranges" => {
            "signal_id,default_value,min_value,max_value,boot_restore,manual_restore"
        }
        "device_contexts" => "model_id,group_id,name,code,dev_id,kind",
        "protocol_contracts" => "name,code,protocol,description",
        "protocol_fields" => {
            "contract_id,data_item_id,name,ordinal,access,address_mode,address,model,register_type,wire_type,wire_length,scale,byte_order"
        }
        "endpoints" => "model_id,contract_id,name,code,role,transport,port,enabled",
        "signal_bindings" => {
            "endpoint_id,context_id,field_id,signal_id,poll_interval,set_priority,scan_priority"
        }
        "board_links" => {
            "name,client_board_id,client_endpoint_id,client_context_id,server_board_id,server_endpoint_id,remote_address,dev_code"
        }
        "passthrough_routes" => {
            "name,server_endpoint_id,client_endpoint_id,context_id,base_address,end_address,register_type,writable,callback"
        }
        "platform_signals" => "symbol,signal_id",
        _ => return None,
    })
}
pub fn rows<'a>(g: &'a Value, k: &str) -> &'a [Value] {
    g[k].as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn num(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or(0)
}
pub fn strv<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn find<'a>(g: &'a Value, t: &str, id: i64) -> Option<&'a Value> {
    rows(g, t).iter().find(|v| num(v, "id") == id)
}
pub async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    computed: bool,
) -> Result<Value> {
    let config: Option<Value> =
        sqlx::query_scalar("SELECT topology_config FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut **tx)
            .await?;
    let mut g = json!({"schema_version":2,"project_config":config});
    for &t in TABLES
        .iter()
        .chain(if computed { VIEWS.iter() } else { [].iter() })
    {
        let select = if t == "source_records" {
            "to_jsonb(t)"
        } else {
            "to_jsonb(t)"
        };
        g[t] = json!(
            db::all_json(
                tx,
                &format!(
                    "SELECT {select} FROM {t} t WHERE project_id=$1 ORDER BY {}",
                    if t == "v_passthrough_fields" {
                        "route_id,register_address"
                    } else {
                        "id"
                    }
                ),
                pid
            )
            .await?
        );
    }
    g["revision"] = json!(
        sqlx::query_scalar::<_, i32>("SELECT revision FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut **tx)
            .await?
    );
    Ok(g)
}
pub async fn read(State(s): State<AppState>, u: User, Path(pid): Path<i64>) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    sqlx::query("SELECT id FROM projects WHERE id=$1 FOR SHARE")
        .bind(pid)
        .execute(&mut *tx)
        .await?;
    let mut g = snapshot(&mut tx, pid, true).await?;
    g["validation"] = crate::topology_validation::validate(&g);
    // Raw workbook cells can be large; fetch them on demand from source_records.
    g["source_records"]=json!(rows(&g,"source_records").iter().map(|r|json!({"id":r["id"],"sheet":r["sheet"],"row_number":r["row_number"],"classification":r["classification"]})).collect::<Vec<_>>());
    for d in g["data_items"].as_array_mut().unwrap() {
        d.as_object_mut().unwrap().remove("raw_json");
    }
    Ok(Json(g))
}
pub async fn source(
    State(s): State<AppState>,
    u: User,
    Path((pid, id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    Ok(Json(
        sqlx::query_scalar(
            "SELECT to_jsonb(s) FROM source_records s WHERE project_id=$1 AND id=$2",
        )
        .bind(pid)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::not_found())?,
    ))
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Change {
    pub revision: i32,
    pub entity: String,
    pub operation: String,
    pub id: Option<i64>,
    #[serde(default)]
    pub values: Value,
}
pub async fn apply(tx: &mut Transaction<'_, Postgres>, pid: i64, c: &Change) -> Result<Value> {
    if c.entity == "project_config" {
        if c.operation != "update" {
            return Err(AppError::bad("项目 JSON 配置仅支持整体更新"));
        }
        return crate::project_config::apply(tx, pid, &c.values).await;
    }
    if c.entity == "board_models" && c.operation != "create" {
        let referenced:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects p JOIN board_models m ON m.project_id=p.id CROSS JOIN LATERAL jsonb_array_elements(p.topology_config->'board_types') t WHERE p.id=$1 AND m.id=$2 AND t->>'model_code'=m.code AND ($3 OR ($4::text IS NOT NULL AND $4<>m.code)))")
            .bind(pid).bind(c.id).bind(c.operation=="delete").bind(c.values["code"].as_str()).fetch_one(&mut **tx).await?;
        if referenced {
            return Err(AppError::bad(
                "板卡类型已在项目 JSON 中引用，不能删除或修改模板代码",
            ));
        }
    }
    let allowed = columns(&c.entity).ok_or(AppError::bad("不可编辑此类数据"))?;
    if c.operation == "delete" {
        return Ok(sqlx::query_scalar(&format!(
            "DELETE FROM {} WHERE project_id=$1 AND id=$2 RETURNING to_jsonb({}.*)",
            c.entity, c.entity
        ))
        .bind(pid)
        .bind(c.id.ok_or(AppError::bad("缺少记录 ID"))?)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::not_found())?);
    }
    if !["create", "update"].contains(&c.operation.as_str()) {
        return Err(AppError::bad("操作类型无效"));
    }
    let values = c
        .values
        .as_object()
        .ok_or(AppError::bad("字段必须是对象"))?;
    if values.is_empty() {
        return Err(AppError::bad("未提供字段"));
    }
    for (key, v) in values {
        if !allowed.split(',').any(|k| k == key) {
            return Err(AppError::bad(format!("字段 {key} 不允许修改")));
        }
        if v.is_string() && v.as_str().unwrap().len() > 4096 {
            return Err(AppError::bad("字段内容过长"));
        }
        if ["name", "code", "enum_name", "symbol"].contains(&key.as_str())
            && v.as_str()
                .is_none_or(|x| x.trim().is_empty() || x.len() > 300)
        {
            return Err(AppError::bad("名称或标识符不能为空，最多 300 字节"));
        }
        if ["code", "enum_name", "symbol", "callback", "sig_symbol"].contains(&key.as_str())
            && !v.is_null()
            && !v.as_str().is_some_and(model::identifier)
        {
            return Err(AppError::bad(format!("{key} 必须为合法 C 标识符")));
        }
        if key == "flags" && !v.as_str().is_some_and(model::flag_expression) {
            return Err(AppError::bad("配置标志必须是整数、宏名或按位或表达式"));
        }
    }
    let cols = values.keys().cloned().collect::<Vec<_>>().join(",");
    let t = &c.entity;
    let sql = if c.operation == "create" {
        format!(
            "INSERT INTO {t}(project_id,{cols}) SELECT $1,{cols} FROM jsonb_populate_record(NULL::{t},$2) RETURNING to_jsonb({t}.*)"
        )
    } else {
        format!(
            "UPDATE {t} SET ({cols})=(SELECT {cols} FROM jsonb_populate_record(NULL::{t},$2)) WHERE project_id=$1 AND id=$3 RETURNING to_jsonb({t}.*)"
        )
    };
    let q = sqlx::query_scalar(&sql).bind(pid).bind(&c.values);
    let row = if c.operation == "create" {
        q.fetch_optional(&mut **tx).await?
    } else {
        q.bind(c.id.ok_or(AppError::bad("缺少记录 ID"))?)
            .fetch_optional(&mut **tx)
            .await?
    };
    row.ok_or(AppError::not_found())
}
fn issue_keys(report: &Value) -> BTreeSet<String> {
    rows(report, "issues")
        .iter()
        .filter(|v| v["level"] == "error")
        .map(|v| v["key"].to_string())
        .collect()
}
fn new_errors(before: &Value, after: &Value) -> Vec<Value> {
    let keys = issue_keys(before);
    rows(after, "issues")
        .iter()
        .filter(|v| v["level"] == "error" && !keys.contains(&v["key"].to_string()))
        .cloned()
        .collect()
}
fn impact(before: &Value, after: &Value) -> Value {
    let mut diffs = Vec::new();
    let config_changed = before["project_config"] != after["project_config"];
    if config_changed {
        diffs.push(json!({"entity":"project_config","key":"project_config","before":before["project_config"],"after":after["project_config"]}));
    }
    for t in [
        "board_models",
        "signal_groups",
        "protocol_contracts",
        "signal_ranges",
        "platform_signals",
        "passthrough_routes",
        "data_items",
        "v_signals",
        "v_protocol_fields",
        "v_bindings",
        "v_passthrough_fields",
        "v_topology_links",
        "boards",
        "device_contexts",
        "endpoints",
    ] {
        let key = |r: &Value| {
            if t == "v_passthrough_fields" {
                format!("{}:{}", r["route_id"], r["field_id"])
            } else {
                r["id"].to_string()
            }
        };
        let b: std::collections::BTreeMap<_, _> =
            rows(before, t).iter().map(|r| (key(r), r)).collect();
        let a: std::collections::BTreeMap<_, _> =
            rows(after, t).iter().map(|r| (key(r), r)).collect();
        for id in b.keys().chain(a.keys()).collect::<BTreeSet<_>>() {
            if b.get(id) != a.get(id) {
                diffs.push(json!({"entity":t,"key":id,"before":b.get(id),"after":a.get(id)}));
            }
        }
    }
    let mut models = BTreeSet::new();
    let mut board_ids = BTreeSet::new();
    for diff in &diffs {
        let table = strv(diff, "entity");
        for (g, side) in [(before, "before"), (after, "after")] {
            let r = &diff[side];
            if r.is_null() {
                continue;
            }
            if r["model_id"].is_number() {
                models.insert(num(r, "model_id"));
            }
            if table == "board_models" {
                models.insert(num(r, "id"));
            }
            if table == "boards" {
                board_ids.insert(num(r, "id"));
            }
            if table == "v_topology_links" {
                board_ids.insert(num(r, "client_board_id"));
                board_ids.insert(num(r, "server_board_id"));
            }
            let mut contracts = BTreeSet::new();
            if table == "protocol_contracts" {
                contracts.insert(num(r, "id"));
            }
            if table == "v_protocol_fields" {
                contracts.insert(num(r, "contract_id"));
            }
            if table == "data_items" {
                for sig in rows(g, "v_signals")
                    .iter()
                    .filter(|s| s["data_item_id"] == r["id"])
                {
                    models.insert(num(sig, "model_id"));
                }
                for f in rows(g, "protocol_fields")
                    .iter()
                    .filter(|f| f["data_item_id"] == r["id"])
                {
                    contracts.insert(num(f, "contract_id"));
                }
            }
            for e in rows(g, "endpoints")
                .iter()
                .filter(|e| contracts.contains(&num(e, "contract_id")))
            {
                models.insert(num(e, "model_id"));
            }
        }
    }
    let affected: Vec<_> = rows(after, "boards")
        .iter()
        .filter(|b| models.contains(&num(b, "model_id")) || board_ids.contains(&num(b, "id")))
        .map(|b| json!({"id":b["id"],"name":b["name"],"code":b["code"]}))
        .collect();
    let mut types = Vec::new();
    if let Ok(config) = crate::project_config::Config::parse(after["project_config"].clone()) {
        let counts = config.counts().unwrap_or_default();
        for t in config.board_types {
            if config_changed
                || rows(after, "board_models")
                    .iter()
                    .any(|m| m["code"] == t.model_code && models.contains(&num(m, "id")))
            {
                types.push(json!({"code":t.code,"name":t.name,"quantity":counts[&t.code]}));
            }
        }
    }
    json!({"count":diffs.len(),"affected_boards":affected,"affected_types":types,"changes":diffs.into_iter().take(200).collect::<Vec<_>>()})
}
pub async fn preview(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
    Json(c): Json<Change>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    let revision = db::lock_project(&mut tx, pid).await?;
    if revision != c.revision {
        return Err(AppError::conflict("项目已被修改，请刷新后重新预览"));
    }
    let before = snapshot(&mut tx, pid, true).await?;
    let before_report = crate::topology_validation::validate(&before);
    sqlx::query("SAVEPOINT proposed_change")
        .execute(&mut *tx)
        .await?;
    let applied = apply(&mut tx, pid, &c).await;
    if let Err(e) = applied {
        sqlx::query("ROLLBACK TO SAVEPOINT proposed_change")
            .execute(&mut *tx)
            .await?;
        return Ok(Json(
            json!({"allowed":false,"revision":revision,"errors":[{"message":e.1}],"impact":{"count":0,"changes":[]}}),
        ));
    }
    let after = snapshot(&mut tx, pid, true).await?;
    let after_report = crate::topology_validation::validate(&after);
    let errors = new_errors(&before_report, &after_report);
    let effects = impact(&before, &after);
    sqlx::query("ROLLBACK TO SAVEPOINT proposed_change")
        .execute(&mut *tx)
        .await?;
    if !errors.is_empty() {
        return Ok(Json(
            json!({"allowed":false,"revision":revision,"errors":errors,"impact":effects,"validation":after_report}),
        ));
    }
    let id:i64=sqlx::query_scalar("INSERT INTO change_previews(project_id,created_by,revision,change) VALUES($1,$2,$3,$4) RETURNING id").bind(pid).bind(u.id).bind(revision).bind(serde_json::to_value(&c)?).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"allowed":true,"revision":revision,"errors":[],"impact":effects,"validation":after_report}),
    ))
}
pub async fn commit(
    State(s): State<AppState>,
    u: User,
    Path((pid, id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    let revision = db::lock_project(&mut tx, pid).await?;
    let pending:Value=sqlx::query_scalar("SELECT change FROM change_previews WHERE project_id=$1 AND id=$2 AND created_by=$3 AND expires_at>now() FOR UPDATE").bind(pid).bind(id).bind(u.id).fetch_optional(&mut *tx).await?.ok_or(AppError::bad("变更预览已过期、已提交或不属于当前用户"))?;
    let c: Change = serde_json::from_value(pending)?;
    if revision != c.revision {
        return Err(AppError::conflict("预览后项目已被修改，请重新预览"));
    }
    let before = snapshot(&mut tx, pid, true).await?;
    let row = apply(&mut tx, pid, &c).await?;
    let after = snapshot(&mut tx, pid, true).await?;
    if !new_errors(
        &crate::topology_validation::validate(&before),
        &crate::topology_validation::validate(&after),
    )
    .is_empty()
    {
        return Err(AppError::conflict("变更导致关联配置不一致"));
    }
    let effects = impact(&before, &after);
    db::audit(&mut tx,u.id,Some(pid),&format!("topology.{}",c.operation),&format!("{}:{}",c.entity,row["id"]),Some(json!({"record":if c.entity=="project_config" {Some(json!({"config":before["project_config"]}))}else{find(&before,&c.entity,num(&row,"id")).cloned()},"revision":revision})),Some(json!({"record":if c.operation=="delete" {Value::Null}else{row.clone()},"impact":effects}))).await?;
    db::touch(&mut tx, pid).await?;
    sqlx::query("DELETE FROM change_previews WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"record":row,"revision":revision+1,"impact":effects}),
    ))
}
