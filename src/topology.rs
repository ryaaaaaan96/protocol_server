use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Acquire, PgConnection};
use std::collections::BTreeSet;

pub const TABLES: &[&str] = &["process_points", "transmit_points"];
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
pub async fn snapshot(tx: &mut PgConnection, pid: i64, _computed: bool) -> Result<Value> {
    let project: Value = sqlx::query_scalar("SELECT jsonb_build_object('project_config',topology_config,'revision',revision,'schema_version',schema_version) FROM project_state WHERE id=$1")
        .bind(pid).fetch_one(&mut *tx).await?;
    let mut graph = project;
    for table in TABLES {
        graph[*table] = json!(
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
pub async fn read(State(s): State<AppState>, u: User, Path(pid): Path<i64>) -> Result<Json<Value>> {
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let mut graph = snapshot(&mut tx, pid, true).await?;
    graph["validation"] = crate::topology_validation::validate(&graph);
    graph["permissions"] = crate::permissions::load(&mut tx, pid).await?.value(&graph);
    Ok(Json(graph))
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Change {
    pub revision: i32,
    pub entity: String,
    pub operation: String,
    pub id: Option<i64>,
    #[serde(default)]
    pub values: Value,
    #[serde(default)]
    pub expected: Value,
}
pub async fn apply(tx: &mut PgConnection, pid: i64, c: &Change) -> Result<Value> {
    if crate::point_tables::is_point_entity(&c.entity) {
        return Box::pin(crate::point_tables::apply(tx, pid, c)).await;
    }
    if c.entity == "project_config" {
        if c.operation != "update" {
            return Err(AppError::bad("项目 JSON 配置仅支持整体更新"));
        }
        return crate::project_config::apply(tx, pid, &c.values).await;
    }
    Err(AppError::bad(
        "此业务实体已移除；请通过点表接口或项目 JSON 配置修改",
    ))
}
fn issue_keys(report: &Value) -> BTreeSet<String> {
    rows(report, "issues")
        .iter()
        .filter(|v| v["level"] == "error")
        .map(|v| v["key"].to_string())
        .collect()
}
pub(crate) fn new_errors(before: &Value, after: &Value) -> Vec<Value> {
    let keys = issue_keys(before);
    rows(after, "issues")
        .iter()
        .filter(|v| v["level"] == "error" && !keys.contains(&v["key"].to_string()))
        .cloned()
        .collect()
}
fn impact(before: &Value, after: &Value) -> Value {
    let mut changes = Vec::new();
    let config_changed = before["project_config"] != after["project_config"];
    let mut boards = BTreeSet::new();
    if config_changed {
        changes.push(json!({"entity":"project_config","key":"project_config","before":before["project_config"],"after":after["project_config"]}));
    }
    for table in TABLES {
        let old: std::collections::BTreeMap<_, _> = rows(before, table)
            .iter()
            .map(|r| (num(r, "id"), r))
            .collect();
        let new: std::collections::BTreeMap<_, _> = rows(after, table)
            .iter()
            .map(|r| (num(r, "id"), r))
            .collect();
        for id in old.keys().chain(new.keys()).collect::<BTreeSet<_>>() {
            if old.get(id) != new.get(id) {
                for row in [old.get(id), new.get(id)].into_iter().flatten() {
                    boards.insert(strv(row, "board_key").to_owned());
                }
                changes.push(
                    json!({"entity":table,"key":id,"before":old.get(id),"after":new.get(id)}),
                );
            }
        }
    }
    let mut types = Vec::new();
    if let Ok(config) = crate::project_config::Config::parse(after["project_config"].clone()) {
        let counts = config.counts().unwrap_or_default();
        for board in config.board_types {
            if config_changed || boards.contains(&board.code) {
                types.push(
                    json!({"code":board.code,"name":board.name,"quantity":counts[&board.code]}),
                );
            }
        }
    }
    json!({"count":changes.len(),"affected_types":types,"changes":changes.into_iter().take(200).collect::<Vec<_>>()})
}
pub async fn preview(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
    Json(mut c): Json<Change>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    let revision = db::lock_project(&mut tx, pid).await?;
    let before = snapshot(&mut tx, pid, true).await?;
    let merged = revision != c.revision;
    if merged {
        if c.revision > revision
            || !crate::change_merge::can_preview(&s, &mut tx, pid, &c, &before).await?
        {
            return Err(crate::change_merge::conflict(
                &c,
                revision,
                "修改字段或顺序已变化，无法自动合并",
            ));
        }
        c.revision = revision;
    }
    let access = crate::permissions::load(&mut tx, pid).await?;
    if c.entity == "project_config" {
        access.require_all()?;
    }
    let before_report = crate::topology_validation::validate(&before);
    // SQLx manages the savepoint and rolls it back on early return/drop.
    let mut proposed = tx.begin().await?;
    let applied = apply_change(&s, &mut proposed, pid, &c).await;
    let applied = match applied {
        Ok(record) => record,
        Err(e) => {
            proposed.rollback().await?;
            let errors =
                e.2.and_then(|details| details.get("errors").cloned())
                    .unwrap_or_else(|| json!([{"message":e.1}]));
            return Ok(Json(
                json!({"allowed":false,"revision":revision,"errors":errors,"impact":{"count":0,"changes":[]}}),
            ));
        }
    };
    let after = snapshot(&mut proposed, pid, true).await?;
    crate::permissions::check_change(&access, &before, &after)?;
    let after_report = crate::topology_validation::validate(&after);
    let mut errors = new_errors(&before_report, &after_report);
    if c.entity == "point_batch" {
        crate::point_batch::annotate(&mut errors, &applied);
    }
    let effects = impact(&before, &after);
    proposed.rollback().await?;
    if !errors.is_empty() {
        return Ok(Json(
            json!({"allowed":false,"revision":revision,"errors":errors,"impact":effects,"validation":after_report}),
        ));
    }
    let base = crate::change_merge::document(&before);
    let patch = json_patch::diff(&base, &crate::change_merge::document(&after));
    sqlx::query("DELETE FROM change_previews WHERE project_id=$1 AND expires_at<=now()")
        .bind(pid)
        .execute(&mut *tx)
        .await?;
    let id:i64=sqlx::query_scalar("INSERT INTO change_previews(project_id,created_by,revision,change,merge_base,merge_patch) VALUES($1,$2,$3,$4,$5,$6) RETURNING id")
        .bind(pid).bind(u.id).bind(revision).bind(serde_json::to_value(&c)?)
        .bind(base).bind(serde_json::to_value(patch)?).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"allowed":true,"merged":merged,"revision":revision,"errors":[],"impact":effects,"validation":after_report}),
    ))
}
pub async fn commit(
    State(s): State<AppState>,
    u: User,
    Path((pid, id)): Path<(i64, i64)>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    let revision = db::lock_project(&mut tx, pid).await?;
    let pending:Value=sqlx::query_scalar("SELECT to_jsonb(p) FROM change_previews p WHERE project_id=$1 AND id=$2 AND created_by=$3 AND expires_at>now() FOR UPDATE").bind(pid).bind(id).bind(u.id).fetch_optional(&mut *tx).await?.ok_or(AppError::bad("变更预览已过期、已提交或不属于当前用户"))?;
    let c: Change = serde_json::from_value(pending["change"].clone())?;
    let access = crate::permissions::load(&mut tx, pid).await?;
    if c.entity == "project_config" {
        access.require_all()?;
    }
    let merged = revision != c.revision;
    let before = snapshot(&mut tx, pid, true).await?;
    let has_baseline = crate::change_merge::eligible(&c)
        && !pending["merge_base"].is_null()
        && !pending["merge_patch"].is_null();
    if c.entity == "point_batch" && c.operation == "create" {
        crate::point_batch::guard(
            &pending["merge_base"],
            &crate::change_merge::document(&before),
            &c,
            revision,
        )?;
    } else if merged && !has_baseline {
        return Err(AppError::revision_conflict(c.revision, revision));
    }
    let target = if has_baseline {
        // Configuration files can change on restart without advancing the project revision.
        // Even then, commit must reproduce the effects the user reviewed.
        Some(crate::change_merge::rebase(
            &pending["merge_base"],
            &serde_json::from_value(pending["merge_patch"].clone())?,
            &crate::change_merge::document(&before),
            &c,
            revision,
        )?)
    } else {
        None
    };
    let row = apply_change(&s, &mut tx, pid, &c).await.map_err(|error| {
        if merged {
            let mut conflict = crate::change_merge::conflict(
                &c,
                revision,
                &format!("合并后无法应用修改：{}", error.1),
            );
            if let Some(errors) = error.2.and_then(|details| details.get("errors").cloned()) {
                conflict.2.as_mut().unwrap()["errors"] = errors;
            }
            conflict
        } else {
            error
        }
    })?;
    let after = snapshot(&mut tx, pid, true).await?;
    crate::permissions::check_change(&access, &before, &after)?;
    if target.is_some_and(|expected| expected != crate::change_merge::document(&after)) {
        return Err(crate::change_merge::conflict(
            &c,
            revision,
            "合并后关联影响已超出原预览，需重新确认",
        ));
    }
    let mut errors = new_errors(
        &crate::topology_validation::validate(&before),
        &crate::topology_validation::validate(&after),
    );
    if !errors.is_empty() {
        if c.entity == "point_batch" {
            crate::point_batch::annotate(&mut errors, &row);
        }
        let mut error = if merged {
            crate::change_merge::conflict(&c, revision, "合并后关联配置不一致")
        } else {
            AppError::conflict("变更导致关联配置不一致")
        };
        error.2.get_or_insert(json!({}))["errors"] = json!(errors);
        return Err(error);
    }
    let effects = impact(&before, &after);
    let before_record = if c.entity == "point_order" {
        Some(json!({"id":row["id"],"kind":row["kind"],"ids":row["before_ids"]}))
    } else if c.entity == "point_batch" {
        crate::point_batch::audit_before(&before, &c)
    } else if c.entity == "project_config" {
        Some(json!({"config":before["project_config"]}))
    } else if crate::point_tables::is_point_entity(&c.entity) {
        crate::point_tables::audit_before(
            &before,
            &c.entity,
            num(&row, "id"),
            strv(&c.values, "board_key"),
        )
    } else {
        find(&before, &c.entity, num(&row, "id")).cloned()
    };
    db::audit(
        &mut tx, u.id, Some(pid), &format!("topology.{}", c.operation),
        &format!("{}:{}", c.entity, row["id"]),
        Some(json!({"record":before_record,"revision":revision})),
        Some(json!({"record":if c.operation == "delete" {Value::Null} else {row.clone()},"impact":effects,"merged":merged,"base_revision":c.revision})),
    ).await?;
    db::touch(&mut tx, pid).await?;
    crate::dsp_points::history(
        &mut tx,
        pid,
        u.id,
        &format!("point.{}", c.operation),
        &before,
        &after,
    )
    .await?;
    sqlx::query("DELETE FROM change_previews WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::edit_lock::release_owned(&mut tx, pid, u.id).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"record":row,"revision":revision+1,"impact":effects,"merged":merged}),
    ))
}

async fn apply_change(s: &AppState, tx: &mut PgConnection, pid: i64, c: &Change) -> Result<Value> {
    if c.entity == "project_config" {
        let key: Option<String> =
            sqlx::query_scalar("SELECT config_key FROM project_state WHERE id=$1")
                .bind(pid)
                .fetch_one(&mut *tx)
                .await?;
        crate::project_config::validate_directory(&s.project_files, key.as_deref(), &c.values)?;
        if let Some(expected) = c.expected.get("source_sha256") {
            let source = s
                .project_files
                .topology_source(key.as_deref().unwrap())
                .map_err(|e| AppError::bad(format!("{e:#}")))?;
            let proposed =
                serde_json::to_value(crate::project_config::Config::parse(c.values.clone())?)?;
            if expected != &source["sha256"] || proposed != source["config"] {
                return Err(AppError::conflict(
                    "服务器项目文件已变化，请重新读取并检查后导入",
                ));
            }
        }
    }
    if c.entity == "point_batch" {
        crate::point_batch::apply(tx, pid, c).await
    } else if c.entity == "point_order" {
        crate::point_order::apply(tx, pid, c, &s.project_files).await
    } else {
        apply(tx, pid, c).await
    }
}
