use crate::{
    auth::User,
    error::{AppError, Result},
};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

pub async fn context(
    pool: &PgPool,
    user: &User,
    project: Option<i64>,
    write: bool,
) -> Result<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.user_id',$1,true), set_config('app.project_id',$2,true)")
        .bind(user.id.to_string())
        .bind(project.map(|v| v.to_string()).unwrap_or_default())
        .execute(&mut *tx)
        .await?;
    if let Some(pid) = project {
        let allowed: bool = sqlx::query_scalar(
            "SELECT app_can_access($1,$2) AND EXISTS(SELECT 1 FROM projects WHERE id=$1)",
        )
        .bind(pid)
        .bind(write)
        .fetch_one(&mut *tx)
        .await?;
        if !allowed {
            return Err(AppError::forbidden());
        }
    }
    Ok(tx)
}
pub async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    user: i64,
    project: Option<i64>,
    action: &str,
    entity: &str,
    before: Option<Value>,
    after: Option<Value>,
) -> Result<()> {
    sqlx::query("INSERT INTO audit_logs(project_id,user_id,action,entity,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(project).bind(user).bind(action).bind(entity).bind(before).bind(after).execute(&mut **tx).await?;
    Ok(())
}
pub async fn touch(tx: &mut Transaction<'_, Postgres>, pid: i64) -> Result<()> {
    sqlx::query("UPDATE projects SET revision=revision+1,updated_at=now() WHERE id=$1")
        .bind(pid)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub async fn require_admin(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    let allowed: bool = sqlx::query_scalar("SELECT app_is_admin()")
        .fetch_one(&mut **tx)
        .await?;
    if allowed {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}
pub async fn lock_project(tx: &mut Transaction<'_, Postgres>, pid: i64) -> Result<i32> {
    // Serializes edits/imports/releases per project, preserving consistent snapshots.
    let version = sqlx::query_scalar("SELECT revision FROM projects WHERE id=$1 FOR UPDATE")
        .bind(pid)
        .fetch_one(&mut **tx)
        .await?;
    Ok(version)
}
pub async fn all_json(
    tx: &mut Transaction<'_, Postgres>,
    sql: &str,
    pid: i64,
) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar(sql)
        .bind(pid)
        .fetch_all(&mut **tx)
        .await?)
}
pub async fn snapshot(tx: &mut Transaction<'_, Postgres>, pid: i64) -> Result<Value> {
    crate::topology::snapshot(tx, pid, false).await
}
