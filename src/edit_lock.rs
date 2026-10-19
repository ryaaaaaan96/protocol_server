//! Project editing leases; every writer serializes through the project row lock.
use crate::{
    AppState,
    auth::User,
    db,
    error::{AppError, Result},
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use sqlx::PgConnection;

const LEASE_SECONDS: i64 = 120;

async fn status(tx: &mut PgConnection, pid: i64, uid: i64) -> Result<Value> {
    let lease: Option<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('owner',jsonb_build_object('id',user_id,'display_name',owner_name,'username',owner_username),'expires_at',expires_at) FROM project_edit_locks WHERE project_id=$1 AND expires_at>clock_timestamp() AND COALESCE(NULLIF(current_setting('app.project_editors',true),''),'[]')::jsonb @> to_jsonb(user_id)"
    ).bind(pid).fetch_optional(&mut *tx).await?;
    let lease = lease.unwrap_or(Value::Null);
    let mut permissions = crate::permissions::load(tx, pid).await?.value(&json!({}));
    permissions.as_object_mut().unwrap().remove("catalog");
    Ok(
        json!({"locked":!lease.is_null(),"owned":lease["owner"]["id"]==uid,
        "owner":lease["owner"],"expires_at":lease["expires_at"],"lease_seconds":LEASE_SECONDS,"permissions":permissions}),
    )
}
fn denied(status: Value) -> AppError {
    let locked = status["locked"] == true;
    let message = if locked {
        format!(
            "{} 正在编辑此项目，当前只能查看；对方提交或结束编辑后可开始编辑",
            status["owner"]["display_name"]
                .as_str()
                .unwrap_or("其他成员")
        )
    } else {
        "请先点击“开始编辑”取得项目编辑权；未保存的修改仍保留在当前页面".into()
    };
    AppError(
        StatusCode::LOCKED,
        message,
        Some(json!({
            "code":if locked {"PROJECT_EDIT_LOCKED"} else {"EDIT_LOCK_REQUIRED"},"lock":status
        })),
    )
}
pub async fn require(tx: &mut PgConnection, pid: i64, uid: i64) -> Result<()> {
    db::lock_project(tx, pid).await?;
    let state = status(tx, pid, uid).await?;
    if state["owned"] != true {
        return Err(denied(state));
    }
    Ok(())
}
/// Folder imports hold the project row lock for their entire transaction, so an
/// idle project needs no lasting lease. An existing editor still takes priority.
pub async fn require_available(tx: &mut PgConnection, pid: i64, uid: i64) -> Result<()> {
    db::lock_project(tx, pid).await?;
    let state = status(tx, pid, uid).await?;
    if state["locked"] == true && state["owned"] != true {
        return Err(denied(state));
    }
    Ok(())
}
pub async fn release_owned(tx: &mut PgConnection, pid: i64, uid: i64) -> Result<()> {
    sqlx::query("DELETE FROM project_edit_locks WHERE project_id=$1 AND user_id=$2")
        .bind(pid)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    Ok(())
}
pub async fn read(State(s): State<AppState>, u: User, Path(pid): Path<i64>) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    Ok(Json(status(&mut tx, pid, u.id).await?))
}
async fn change(s: AppState, u: User, pid: i64, operation: &str) -> Result<Json<Value>> {
    let mut tx = db::unlocked_write_context(&s.pool, &u, pid).await?;
    db::lock_project(&mut tx, pid).await?;
    let current = status(&mut tx, pid, u.id).await?;
    if operation != "release" {
        crate::permissions::load(&mut tx, pid)
            .await?
            .require_any()?;
    }
    if current["locked"] == true && current["owned"] != true {
        return Err(denied(current));
    }
    if operation == "renew" && current["owned"] != true {
        return Err(denied(current));
    }
    if operation == "release" {
        release_owned(&mut tx, pid, u.id).await?;
    } else {
        sqlx::query("INSERT INTO project_edit_locks(project_id,user_id,owner_name,owner_username,expires_at) VALUES($1,$2,current_setting('app.actor_name',true),current_setting('app.username',true),clock_timestamp()+make_interval(secs=>$3::double precision)) ON CONFLICT(project_id) DO UPDATE SET user_id=excluded.user_id,owner_name=excluded.owner_name,owner_username=excluded.owner_username,expires_at=excluded.expires_at")
            .bind(pid).bind(u.id).bind(LEASE_SECONDS as f64).execute(&mut *tx).await?;
    }
    let result = status(&mut tx, pid, u.id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn acquire(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    change(s, u, pid, "acquire").await
}
pub async fn renew(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    change(s, u, pid, "renew").await
}
pub async fn release(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    change(s, u, pid, "release").await
}
