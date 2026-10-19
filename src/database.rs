//! Database registry and isolated, lazily opened project connection pools.
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use sqlx::{
    PgConnection, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{collections::HashMap, str::FromStr, sync::Arc, time::Duration};
use tokio::sync::Mutex;

pub static PLATFORM_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/platform");
pub static PROJECT_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/project");

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Registry {
    pub id: i64,
    pub project_uid: String,
    pub config_key: String,
    pub name: String,
    pub description: String,
    pub database_name: String,
    pub status: String,
}

#[derive(Clone)]
pub struct DatabaseRouter {
    pub platform: PgPool,
    runtime_url: Arc<String>,
    migration_url: Option<Arc<String>>,
    pools: Arc<Mutex<HashMap<i64, (String, String, String, PgPool)>>>,
}

fn options(url: &str) -> Result<PgConnectOptions> {
    PgConnectOptions::from_str(url).map_err(|_| AppError::bad("数据库连接配置无效"))
}
fn identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
pub fn project_database_name(key: &str) -> Result<String> {
    if key.is_empty()
        || key.len() > 40
        || !key.as_bytes()[0].is_ascii_lowercase()
        || !key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        return Err(AppError::bad(
            "项目标识应以小写字母开头，只含小写字母、数字、短横线或下划线，最长 40 字节",
        ));
    }
    Ok(format!("protocol_project_{}", key.replace('-', "_")))
}

pub async fn grant_runtime(pool: &PgPool, role: &str, platform: bool) -> Result<()> {
    let role = identifier(role);
    let grants = if platform {
        format!(
            "GRANT USAGE ON SCHEMA public,auth,meta,history TO {role}; REVOKE CREATE ON SCHEMA public,auth,meta,history FROM {role}; GRANT SELECT,INSERT,UPDATE,DELETE ON auth.users,auth.sessions,auth.login_attempts,meta.project_members,meta.project_member_grants TO {role}; GRANT SELECT,INSERT ON history.audit_logs TO {role}; REVOKE UPDATE,DELETE,TRUNCATE ON history.audit_logs FROM {role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA auth,meta,history TO {role}; GRANT SELECT,INSERT,UPDATE ON meta.projects TO {role};"
        )
    } else {
        format!(
            "GRANT USAGE ON SCHEMA public,points,history,meta TO {role}; REVOKE CREATE ON SCHEMA public,points,history,meta FROM {role}; GRANT SELECT,INSERT,UPDATE,DELETE ON points.process_points,points.transmit_points,meta.previews TO {role}; GRANT SELECT,UPDATE ON meta.project_state TO {role}; GRANT SELECT,INSERT ON history.events,history.releases TO {role}; REVOKE UPDATE,DELETE,TRUNCATE ON history.events,history.releases FROM {role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA points,history,meta TO {role};"
        )
    };
    sqlx::raw_sql(&grants).execute(pool).await?;
    Ok(())
}

// Administrative migration connections must keep SQLx's unqualified migration
// ledger in public, even when a role has a custom default search path.
fn admin_project_options(max_connections: u32) -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET search_path TO public,pg_catalog,pg_temp")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
}

async fn project_state_table(pool: &PgPool) -> Result<Option<&'static str>> {
    let (old, grouped): (bool, bool) = sqlx::query_as("SELECT to_regclass('public.project_state') IS NOT NULL,to_regclass('meta.project_state') IS NOT NULL")
        .fetch_one(pool).await?;
    match (old, grouped) {
        (true, true) => Err(AppError::conflict("项目存在重复身份表，拒绝迁移")),
        (true, false) => Ok(Some("public.project_state")),
        (false, true) => Ok(Some("meta.project_state")),
        (false, false) => Ok(None),
    }
}

impl DatabaseRouter {
    pub fn new(platform: PgPool, runtime_url: String, migration_url: Option<String>) -> Self {
        Self {
            platform,
            runtime_url: Arc::new(runtime_url),
            migration_url: migration_url.map(Arc::new),
            pools: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub async fn registry(&self, pid: i64) -> Result<Registry> {
        sqlx::query_as("SELECT id,project_uid::text AS project_uid,config_key,name,description,database_name,status FROM public.app_project_registry($1)")
            .bind(pid).fetch_optional(&self.platform).await?.ok_or_else(AppError::not_found)
    }
    pub async fn reserve_project(
        &self,
        tx: &mut PgConnection,
        key: &str,
        name: &str,
        description: &str,
        creator: i64,
    ) -> Result<Registry> {
        let database_name = project_database_name(key)?;
        let existing: Option<Registry> = sqlx::query_as("SELECT id,project_uid::text AS project_uid,config_key,name,description,database_name,status FROM meta.projects WHERE config_key=$1 FOR UPDATE")
            .bind(key).fetch_optional(&mut *tx).await?;
        if let Some(existing) = existing {
            return Ok(existing);
        }
        let collision: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM meta.projects WHERE database_name=$1)")
                .bind(&database_name)
                .fetch_one(&mut *tx)
                .await?;
        if collision {
            return Err(AppError::conflict(
                "项目标识转换后与已有项目数据库重名，请使用不同的项目标识",
            ));
        }
        Ok(sqlx::query_as("INSERT INTO meta.projects(config_key,name,description,database_name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,project_uid::text AS project_uid,config_key,name,description,database_name,status")
            .bind(key).bind(name).bind(description).bind(database_name).bind(creator).fetch_one(tx).await?)
    }
    pub async fn project_pool(&self, pid: i64) -> Result<PgPool> {
        self.open_project(pid, false).await
    }
    pub async fn project_pool_for_creation(&self, pid: i64) -> Result<PgPool> {
        self.open_project(pid, true).await
    }
    async fn open_project(&self, pid: i64, creating: bool) -> Result<PgPool> {
        let registry = self.registry(pid).await?;
        self.pool_for_registry(&registry, creating).await
    }
    /// Use an already locked registry row to avoid borrowing a second platform
    /// connection while an authorization transaction occupies the first one.
    pub(crate) async fn pool_for_registry(
        &self,
        registry: &Registry,
        creating: bool,
    ) -> Result<PgPool> {
        let pid = registry.id;
        if registry.status != "ready"
            && !(creating && ["creating", "failed"].contains(&registry.status.as_str()))
        {
            return Err(AppError::conflict(
                "项目数据库尚未就绪，请完成项目导入或恢复",
            ));
        }
        if registry.database_name != project_database_name(&registry.config_key)? {
            return Err(AppError::conflict("项目数据库登记名称与标识不匹配"));
        }
        let mut pools = self.pools.lock().await;
        if let Some((key, name, uid, pool)) = pools.get(&pid) {
            if *key != registry.config_key
                || *name != registry.database_name
                || *uid != registry.project_uid
            {
                return Err(AppError::conflict(
                    "项目数据库路由已改变，请重启服务重新验证",
                ));
            }
            let identity: Option<(i64, String, String)> = sqlx::query_as(
                "SELECT id,config_key,project_uid FROM public.app_project_identity()",
            )
            .fetch_optional(pool)
            .await?;
            if identity
                != Some((
                    registry.id,
                    registry.config_key.clone(),
                    registry.project_uid.clone(),
                ))
            {
                return Err(AppError::conflict(
                    "项目数据库身份已改变，已拒绝继续使用缓存连接",
                ));
            }
            return Ok(pool.clone());
        }
        let connect = options(&self.runtime_url)?.database(&registry.database_name);
        let pool = PgPoolOptions::new()
            .min_connections(0)
            .max_connections(5)
            .idle_timeout(Duration::from_secs(120))
            .acquire_timeout(Duration::from_secs(10))
            .after_connect(|conn, _| {
                Box::pin(async move {
                    sqlx::query("SET search_path TO pg_catalog,points,history,meta,public,pg_temp")
                        .execute(conn)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(connect)
            .await?;
        let role_safe: bool = sqlx::query_scalar(
            "SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user",
        )
        .fetch_one(&pool)
        .await?;
        if !role_safe {
            pool.close().await;
            return Err(AppError::bad("项目运行账号不得拥有 superuser 或 BYPASSRLS"));
        }
        let grouped: bool = sqlx::query_scalar(
            "SELECT to_regclass('meta.project_state') IS NOT NULL AND to_regclass('history.events') IS NOT NULL",
        )
        .fetch_one(&pool)
        .await?;
        if !grouped {
            pool.close().await;
            return Err(AppError::conflict(
                "项目数据库尚未升级，请先运行 cargo run -- migrate",
            ));
        }
        // A restricted function exposes only the immutable routing identity.
        let identity: Option<(i64, String, String)> =
            sqlx::query_as("SELECT id,config_key,project_uid FROM public.app_project_identity()")
                .fetch_optional(&pool)
                .await?;
        if identity
            != Some((
                registry.id,
                registry.config_key.clone(),
                registry.project_uid.clone(),
            ))
        {
            pool.close().await;
            return Err(AppError::conflict(
                "项目数据库身份与平台登记不一致，已拒绝连接",
            ));
        }
        pools.insert(
            pid,
            (
                registry.config_key.clone(),
                registry.database_name.clone(),
                registry.project_uid.clone(),
                pool.clone(),
            ),
        );
        Ok(pool)
    }
    async fn admin_pool(&self) -> Result<PgPool> {
        let url = self
            .migration_url
            .as_ref()
            .ok_or_else(|| AppError::bad("创建项目数据库需要配置 MIGRATION_DATABASE_URL"))?;
        let runtime = options(&self.runtime_url)?;
        let admin = options(url)?;
        if runtime.get_host() != admin.get_host()
            || runtime.get_port() != admin.get_port()
            || runtime.get_database() != admin.get_database()
        {
            return Err(AppError::bad(
                "DATABASE_URL 与 MIGRATION_DATABASE_URL 必须指向同一主机、端口和平台数据库，只允许账号不同",
            ));
        }
        Ok(admin_project_options(2).connect_with(admin).await?)
    }
    pub async fn provision_project(&self, pid: i64) -> Result<()> {
        let registry = self.registry(pid).await?;
        if registry.database_name != project_database_name(&registry.config_key)? {
            return Err(AppError::bad("项目数据库登记无效"));
        }
        let admin = self.admin_pool().await?;
        let result = self.provision_with_admin(&admin, &registry).await;
        admin.close().await;
        result
    }
    async fn provision_with_admin(&self, admin: &PgPool, registry: &Registry) -> Result<()> {
        let mut guard = admin.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(778420000000000000::bigint+$1)")
            .bind(registry.id)
            .execute(&mut *guard)
            .await?;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)")
                .bind(&registry.database_name)
                .fetch_one(&mut *guard)
                .await?;
        if !exists {
            sqlx::query(&format!(
                "CREATE DATABASE {}",
                identifier(&registry.database_name)
            ))
            .execute(admin)
            .await?;
            // Mark ownership before any schema work. A crash before this marker
            // leaves an unknown empty database that is safely refused on retry.
            sqlx::query(&format!(
                "COMMENT ON DATABASE {} IS 'protocol-project:{}'",
                identifier(&registry.database_name),
                registry.project_uid
            ))
            .execute(admin)
            .await?;
        }
        let marker: Option<String> = sqlx::query_scalar(
            "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=$1",
        )
        .bind(&registry.database_name)
        .fetch_one(admin)
        .await?;
        let url = self.migration_url.as_ref().unwrap();
        let project = admin_project_options(2)
            .connect_with(options(url)?.database(&registry.database_name))
            .await?;
        let result = async {
            if let Some(table) = project_state_table(&project).await? {
                let identity: Option<(i64,String,String)> = sqlx::query_as(&format!("SELECT id,config_key,project_uid::text FROM {table}")).fetch_optional(&project).await?;
                if identity != Some((registry.id,registry.config_key.clone(),registry.project_uid.clone())) && !(identity.is_none() && marker.as_deref()==Some(&format!("protocol-project:{}",registry.project_uid))) { return Err(AppError::conflict("同名数据库已经属于另一个项目，未修改其内容")); }
            } else {
                let occupied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%' AND schemaname NOT LIKE 'pg_temp%')").fetch_one(&project).await?;
                if occupied || marker.as_deref()!=Some(&format!("protocol-project:{}",registry.project_uid)) { return Err(AppError::conflict("同名数据库不属于此项目，不能接管其内容")); }
            }
            PROJECT_MIGRATOR.run(&project).await.map_err(|e| { tracing::error!(error=%e,"project schema migration failed"); AppError::bad("项目数据库结构升级失败，请查看服务日志") })?;
            sqlx::query("INSERT INTO meta.project_state(id,config_key,name,description,project_uid) VALUES($1,$2,$3,$4,$5::text::uuid) ON CONFLICT(id) DO NOTHING")
                .bind(registry.id).bind(&registry.config_key).bind(&registry.name).bind(&registry.description).bind(&registry.project_uid).execute(&project).await?;
            grant_runtime(&project, options(&self.runtime_url)?.get_username(), false).await?;
            Ok(())
        }.await;
        project.close().await;
        guard.commit().await?;
        result
    }
    pub async fn finish_project(&self, pid: i64) -> Result<()> {
        let admin = self.admin_pool().await?;
        let registry = self.registry(pid).await?;
        let project = admin_project_options(1)
            .connect_with(
                options(self.migration_url.as_ref().unwrap())?.database(&registry.database_name),
            )
            .await?;
        let result = async {
            let row: Option<(String,String)> = sqlx::query_as("SELECT name,description FROM meta.project_state WHERE id=$1 AND config_key=$2 AND project_uid=$3::text::uuid AND topology_config IS NOT NULL AND EXISTS(SELECT 1 FROM history.events WHERE project_id=$1 AND kind='audit' AND action='project.create')")
                .bind(pid).bind(&registry.config_key).bind(&registry.project_uid).fetch_optional(&project).await?;
            let (name,description) = row.ok_or_else(|| AppError::conflict("项目创建事务尚未完成，数据库保持未就绪状态"))?;
            let updated=sqlx::query("UPDATE meta.projects SET name=$2,description=$3,status='ready',updated_at=now() WHERE id=$1 AND project_uid=$4::text::uuid AND config_key=$5")
                .bind(pid).bind(name).bind(description).bind(&registry.project_uid).bind(&registry.config_key).execute(&admin).await?;
            if updated.rows_affected()!=1 { return Err(AppError::conflict("平台项目身份已改变，未更新项目登记")); }
            Ok(())
        }.await;
        project.close().await;
        admin.close().await;
        result
    }
    pub async fn sync_project_metadata(&self, pid: i64) -> Result<()> {
        let registry = self.registry(pid).await?;
        if registry.status != "ready" {
            return self.finish_project(pid).await;
        }
        let admin = self.admin_pool().await?;
        let project = admin_project_options(1)
            .connect_with(
                options(self.migration_url.as_ref().unwrap())?.database(&registry.database_name),
            )
            .await?;
        let result = async {
            let (name,description): (String,String) = sqlx::query_as("SELECT name,description FROM meta.project_state WHERE id=$1 AND config_key=$2 AND project_uid=$3::text::uuid").bind(pid).bind(&registry.config_key).bind(&registry.project_uid).fetch_one(&project).await?;
            let updated=sqlx::query("UPDATE meta.projects SET name=$2,description=$3,updated_at=now() WHERE id=$1 AND project_uid=$4::text::uuid AND config_key=$5").bind(pid).bind(name).bind(description).bind(&registry.project_uid).bind(&registry.config_key).execute(&admin).await?;
            if updated.rows_affected()!=1 { return Err(AppError::conflict("平台项目身份已改变，未更新项目登记")); }
            Ok(())
        }.await;
        project.close().await;
        admin.close().await;
        result
    }
    pub async fn fail_project(&self, pid: i64) -> Result<()> {
        let registry = self.registry(pid).await?;
        let admin = self.admin_pool().await?;
        let result = sqlx::query(
            "UPDATE meta.projects SET status='failed',updated_at=now() WHERE id=$1 AND project_uid=$2::text::uuid AND status<>'ready'",
        )
        .bind(pid).bind(&registry.project_uid)
        .execute(&admin)
        .await;
        admin.close().await;
        result?;
        Ok(())
    }
    pub async fn recover_projects(&self) -> Result<()> {
        if self.migration_url.is_none() {
            return Ok(());
        }
        let admin = self.admin_pool().await?;
        let ids: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM meta.projects WHERE status IN ('creating','failed') ORDER BY id",
        )
        .fetch_all(&admin)
        .await?;
        admin.close().await;
        for pid in ids {
            if let Err(error) = self.finish_project(pid).await {
                tracing::warn!(project_id=pid,error=%error.1,"project creation is incomplete; retry its import to recover");
            }
        }
        Ok(())
    }
}

pub async fn migrate(url: &str) -> anyhow::Result<()> {
    let opts = PgConnectOptions::from_str(url)?;
    let admin = admin_project_options(2).connect_with(opts.clone()).await?;
    let legacy: bool =
        sqlx::query_scalar("SELECT to_regclass('public.process_points') IS NOT NULL OR to_regclass('public.project_state') IS NOT NULL OR to_regclass('meta.project_state') IS NOT NULL")
            .fetch_one(&admin)
            .await?;
    anyhow::ensure!(
        !legacy,
        "迁移连接必须指向平台库；旧单库请先运行 scripts/split-databases.mjs，项目库由平台登记统一升级"
    );
    PLATFORM_MIGRATOR.run(&admin).await?;
    let runtime = PgConnectOptions::from_str(&std::env::var("DATABASE_URL")?)?;
    grant_runtime(&admin, runtime.get_username(), true)
        .await
        .map_err(|e| anyhow::anyhow!(e.1))?;
    let entries: Vec<Registry> = sqlx::query_as("SELECT id,project_uid::text AS project_uid,config_key,name,description,database_name,status FROM meta.projects WHERE status='ready' ORDER BY id").fetch_all(&admin).await?;
    for entry in entries {
        anyhow::ensure!(
            entry.database_name
                == project_database_name(&entry.config_key).map_err(|e| anyhow::anyhow!(e.1))?,
            "项目数据库登记名称不匹配"
        );
        let project = admin_project_options(1)
            .connect_with(opts.clone().database(&entry.database_name))
            .await?;
        let table = project_state_table(&project)
            .await
            .map_err(|e| anyhow::anyhow!(e.1))?
            .ok_or_else(|| anyhow::anyhow!("项目数据库缺少身份表，已停止迁移"))?;
        let identity: Option<(i64, String, String)> = sqlx::query_as(&format!(
            "SELECT id,config_key,project_uid::text FROM {table}"
        ))
        .fetch_optional(&project)
        .await?;
        anyhow::ensure!(
            identity
                == Some((
                    entry.id,
                    entry.config_key.clone(),
                    entry.project_uid.clone()
                )),
            "项目数据库身份不匹配，已停止迁移"
        );
        PROJECT_MIGRATOR.run(&project).await?;
        grant_runtime(&project, runtime.get_username(), false)
            .await
            .map_err(|e| anyhow::anyhow!(e.1))?;
        project.close().await;
    }
    admin.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_names_are_stable_safe_and_bounded() {
        assert_eq!(
            project_database_name("dc-ups").unwrap(),
            "protocol_project_dc_ups"
        );
        assert_eq!(
            project_database_name("dc_ups").unwrap(),
            "protocol_project_dc_ups"
        ); // registry unique constraint rejects collisions
        for key in ["", "DC UPS", "../x", "a\";DROP DATABASE x", "1bad", "a.b"] {
            assert!(project_database_name(key).is_err(), "{key}");
        }
        assert!(project_database_name(&"a".repeat(40)).is_ok());
        assert!(project_database_name(&"a".repeat(41)).is_err());
    }
}
