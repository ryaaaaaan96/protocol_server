use crate::{
    auth::User,
    database::{DatabaseRouter, Registry},
    error::{AppError, Result},
};
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, Transaction};
use std::ops::{Deref, DerefMut};

/// Keep the verified platform account/project locked until the business
/// transaction completes, so a concurrent revocation cannot race a write.
pub struct DbTransaction {
    transaction: Transaction<'static, Postgres>,
    authorization: Option<Transaction<'static, Postgres>>,
}
impl Deref for DbTransaction {
    type Target = PgConnection;
    fn deref(&self) -> &Self::Target {
        &self.transaction
    }
}
impl DerefMut for DbTransaction {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.transaction
    }
}
impl DbTransaction {
    pub async fn commit(self) -> Result<()> {
        self.transaction.commit().await?;
        if let Some(authorization) = self.authorization {
            if let Err(error) = authorization.rollback().await {
                tracing::warn!(error=%error,"failed to release completed authorization transaction");
            }
        }
        Ok(())
    }
    pub async fn rollback(self) -> Result<()> {
        self.transaction.rollback().await?;
        if let Some(authorization) = self.authorization {
            if let Err(error) = authorization.rollback().await {
                tracing::warn!(error=%error,"failed to release completed authorization transaction");
            }
        }
        Ok(())
    }
}

pub async fn context(
    router: &DatabaseRouter,
    user: &User,
    project: Option<i64>,
    write: bool,
) -> Result<DbTransaction> {
    let mut tx = begin_context(router, user, project, write, false, false).await?;
    if write && let Some(pid) = project {
        crate::edit_lock::require(&mut tx, pid, user.id).await?;
        crate::permissions::load(&mut tx, pid)
            .await?
            .require_any()?;
    }
    Ok(tx)
}
pub async fn unlocked_write_context(
    router: &DatabaseRouter,
    user: &User,
    project: i64,
) -> Result<DbTransaction> {
    begin_context(router, user, Some(project), true, false, false).await
}
pub async fn creation_context(
    router: &DatabaseRouter,
    user: &User,
    project: i64,
) -> Result<DbTransaction> {
    begin_context(router, user, Some(project), true, false, true).await
}
pub async fn read_snapshot_context(
    router: &DatabaseRouter,
    user: &User,
    project: i64,
) -> Result<DbTransaction> {
    begin_context(router, user, Some(project), false, true, false).await
}
async fn begin_context(
    router: &DatabaseRouter,
    user: &User,
    project: Option<i64>,
    write: bool,
    snapshot: bool,
    creating: bool,
) -> Result<DbTransaction> {
    let mut authorization = router.platform.begin().await?;
    sqlx::query("SELECT set_config('app.user_id',$1,true),set_config('app.project_id','',true),set_config('app.actor_name',$2,true),set_config('app.username',$3,true)")
        .bind(user.id.to_string()).bind(&user.display_name).bind(&user.username).execute(&mut *authorization).await?;
    let Some(pid) = project else {
        return Ok(DbTransaction {
            transaction: authorization,
            authorization: None,
        });
    };
    // All platform writers acquire users before registry, as does this guard.
    let actor: Option<(bool, String, String)> = sqlx::query_as(
        "SELECT is_admin,display_name,username FROM auth.users WHERE id=$1 AND active FOR SHARE",
    )
    .bind(user.id)
    .fetch_optional(&mut *authorization)
    .await?;
    let (admin, actor_name, username) = actor.ok_or_else(AppError::forbidden)?;
    let registry: Registry = sqlx::query_as("SELECT id,project_uid::text AS project_uid,config_key,name,description,database_name,status FROM app_lock_project($1)")
        .bind(pid).fetch_optional(&mut *authorization).await?.ok_or_else(AppError::forbidden)?;
    let status = &registry.status;
    if status != "ready"
        && !(creating && admin && ["creating", "failed"].contains(&status.as_str()))
    {
        return Err(AppError::conflict("项目数据库尚未完成创建或恢复"));
    }
    if creating && !admin {
        return Err(AppError::forbidden());
    }
    let member: Option<(String, String)> = sqlx::query_as(
        "SELECT role,edit_scope FROM meta.project_members WHERE project_id=$1 AND user_id=$2",
    )
    .bind(pid)
    .bind(user.id)
    .fetch_optional(&mut *authorization)
    .await?;
    let (role, edit_scope) = if admin {
        ("admin".to_owned(), "all".to_owned())
    } else {
        member.ok_or_else(AppError::forbidden)?
    };
    let grants: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('board_key',board_key,'scope',scope,'endpoint_key',endpoint_key) FROM meta.project_member_grants WHERE project_id=$1 AND user_id=$2 ORDER BY board_key,scope,endpoint_key")
        .bind(pid).bind(user.id).fetch_all(&mut *authorization).await?;
    if write
        && role != "admin"
        && !(role == "engineer" && (edit_scope == "all" || !grants.is_empty()))
    {
        return Err(AppError::forbidden());
    }
    let all_grants: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(g) FROM meta.project_member_grants g WHERE project_id=$1 ORDER BY user_id,board_key,scope,endpoint_key")
        .bind(pid).fetch_all(&mut *authorization).await?;
    let editors: Vec<i64> = sqlx::query_scalar("SELECT u.id FROM auth.users u WHERE u.active AND (u.is_admin OR EXISTS(SELECT 1 FROM meta.project_members m WHERE m.project_id=$1 AND m.user_id=u.id AND m.role='engineer' AND (m.edit_scope='all' OR EXISTS(SELECT 1 FROM meta.project_member_grants g WHERE g.project_id=m.project_id AND g.user_id=m.user_id))))")
        .bind(pid).fetch_all(&mut *authorization).await?;
    let pool = router.pool_for_registry(&registry, creating).await?;
    let mut transaction = pool.begin().await?;
    if snapshot {
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *transaction)
            .await?;
    }
    let access = json!({"role":role,"edit_scope":edit_scope,"grants":grants});
    sqlx::query("SELECT set_config('app.user_id',$1,true),set_config('app.project_id',$2,true),set_config('app.access',$3,true),set_config('app.project_grants',$4,true),set_config('app.actor_name',$5,true),set_config('app.display_name',$5,true),set_config('app.username',$6,true),set_config('app.project_editors',$7,true)")
        .bind(user.id.to_string()).bind(pid.to_string()).bind(access.to_string()).bind(json!(all_grants).to_string()).bind(actor_name).bind(username).bind(json!(editors).to_string())
        .execute(&mut *transaction).await?;
    Ok(DbTransaction {
        transaction,
        authorization: Some(authorization),
    })
}
pub async fn audit(
    tx: &mut PgConnection,
    user: i64,
    project: Option<i64>,
    action: &str,
    entity: &str,
    before: Option<Value>,
    after: Option<Value>,
) -> Result<()> {
    // Platform membership changes also carry a project ID. The connection's
    // transaction context, not the audit subject, decides which database owns it.
    let local_project: Option<i64> =
        sqlx::query_scalar("SELECT NULLIF(current_setting('app.project_id',true),'')::bigint")
            .fetch_one(&mut *tx)
            .await?;
    if let Some(pid) = local_project {
        if project != Some(pid) {
            return Err(AppError::bad("审计对象与当前项目不一致"));
        }
        sqlx::query("INSERT INTO history.events(project_id,kind,actor_id,actor_name,action,entity,before_data,after_data,project_revision) SELECT $1,'audit',$2,COALESCE(current_setting('app.actor_name',true),''),$3,$4,$5,$6,revision FROM meta.project_state WHERE id=$1")
            .bind(pid).bind(user).bind(action).bind(entity).bind(before).bind(after).execute(tx).await?;
    } else {
        sqlx::query("INSERT INTO history.audit_logs(project_id,user_id,actor_name,action,entity,before_data,after_data) VALUES($1,$2,COALESCE(current_setting('app.actor_name',true),''),$3,$4,$5,$6)")
            .bind(project).bind(user).bind(action).bind(entity).bind(before).bind(after).execute(tx).await?;
    }
    Ok(())
}
pub async fn record_import(
    tx: &mut PgConnection,
    pid: i64,
    user: i64,
    filename: &str,
    sha256: &str,
    report: &Value,
) -> Result<()> {
    let metadata = json!({"filename":filename,"sha256":sha256,"report":report});
    sqlx::query("INSERT INTO history.events(project_id,kind,action,entity,actor_id,actor_name,metadata,project_revision) SELECT $1,'import','import.complete','workbook',$2,COALESCE(current_setting('app.actor_name',true),''),$3,revision FROM meta.project_state WHERE id=$1")
        .bind(pid).bind(user).bind(metadata).execute(tx).await?;
    Ok(())
}
pub async fn touch(tx: &mut PgConnection, pid: i64) -> Result<()> {
    sqlx::query("UPDATE meta.project_state SET revision=revision+1,updated_at=now() WHERE id=$1")
        .bind(pid)
        .execute(tx)
        .await?;
    Ok(())
}
pub async fn require_admin(tx: &mut PgConnection) -> Result<()> {
    let allowed: bool = sqlx::query_scalar("SELECT app_is_admin()")
        .fetch_one(tx)
        .await?;
    if allowed {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}
pub async fn lock_project(tx: &mut PgConnection, pid: i64) -> Result<i32> {
    Ok(
        sqlx::query_scalar("SELECT revision FROM meta.project_state WHERE id=$1 FOR UPDATE")
            .bind(pid)
            .fetch_one(tx)
            .await?,
    )
}
pub async fn all_json(tx: &mut PgConnection, sql: &str, pid: i64) -> Result<Vec<Value>> {
    Ok(sqlx::query_scalar(sql).bind(pid).fetch_all(tx).await?)
}
pub async fn snapshot(tx: &mut PgConnection, pid: i64) -> Result<Value> {
    crate::topology::snapshot(tx, pid, false).await
}
