mod api;
mod auth;
mod change_merge;
mod codegen;
mod db;
mod error;
mod importer;
mod model;
mod point_order;
mod point_tables;
mod project_config;
mod project_files;
mod sql_workspace;
mod topology;
mod topology_codegen;
mod topology_import;
mod topology_validation;
mod virtual_service;

use anyhow::Context;
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post, put},
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub secure_cookie: bool,
    pub dummy_hash: String,
    pub project_files: std::sync::Arc<project_files::ProjectFiles>,
}

async fn csrf(request: Request, next: Next) -> std::result::Result<Response, StatusCode> {
    if !matches!(request.method().as_str(), "GET" | "HEAD" | "OPTIONS")
        && request
            .headers()
            .get("x-requested-with")
            .and_then(|h| h.to_str().ok())
            != Some("protocol-studio")
    {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(
        arguments.is_empty()
            || arguments == ["migrate"]
            || (arguments.len() == 2 && arguments[0] == "create-project"),
        "用法：protocol-server [migrate | create-project <项目目录名>]"
    );
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "protocol_server=info,tower_http=info".into()),
        )
        .init();
    if arguments.first().is_some_and(|a| a == "migrate") {
        let url =
            std::env::var("MIGRATION_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"))?;
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        topology_import::migrate_legacy(&pool).await?;
        tracing::info!("PostgreSQL migrations applied");
        return Ok(());
    }
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&std::env::var("DATABASE_URL").context("请先运行 ./scripts/init-db.sh，或配置已有 PostgreSQL 的 DATABASE_URL")?)
        .await.context("无法连接数据库。首次使用请运行 ./scripts/init-db.sh；已初始化的本地数据库请运行 node scripts/local-db.mjs start；外部数据库请检查其服务和连接配置")?;
    let unsafe_role: bool = sqlx::query_scalar(
        "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user",
    )
    .fetch_one(&pool)
    .await?;
    anyhow::ensure!(
        !unsafe_role,
        "DATABASE_URL must use a non-superuser role without BYPASSRLS; run migrations using MIGRATION_DATABASE_URL separately"
    );
    let schema_ready: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='projects' AND column_name='config_key')",
    ).fetch_one(&pool).await?;
    anyhow::ensure!(
        schema_ready,
        "数据库表结构尚未初始化或需要升级，请先执行 protocol-server migrate（本地可运行 ./scripts/init-db.sh）。启动服务不会自动建表。"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await?;
    if count == 0 {
        let password = std::env::var("ADMIN_PASSWORD").map_err(|_| {
            anyhow::anyhow!("Set ADMIN_PASSWORD (at least 12 characters) for first startup")
        })?;
        let hash = auth::hash_password(password)
            .await
            .map_err(|e| anyhow::anyhow!(e.1))?;
        sqlx::query("INSERT INTO users(username,display_name,password_hash,is_admin) VALUES($1,'系统管理员',$2,true) ON CONFLICT(username) DO NOTHING").bind(std::env::var("ADMIN_USERNAME").unwrap_or("admin".into())).bind(hash).execute(&pool).await?;
    }
    let project_files = project_files::ProjectFiles::load()?;
    if arguments.first().is_some_and(|a| a == "create-project") {
        return project_files.create(&pool, &arguments[1]).await;
    }
    let dummy_hash = auth::hash_password("invalid-password-placeholder".into())
        .await
        .map_err(|e| anyhow::anyhow!(e.1))?;
    let state = AppState {
        pool,
        secure_cookie: std::env::var("COOKIE_SECURE").is_ok_and(|v| v == "true"),
        dummy_hash,
        project_files: std::sync::Arc::new(project_files),
    };
    let api = Router::new()
        .route("/health", get(api::health))
        .route("/auth/login", post(auth::login))
        .route("/auth/me", get(auth::me))
        .route("/auth/logout", post(auth::logout))
        .route("/point-tables/schema", get(point_tables::schema))
        .route(
            "/projects/{pid}/point-tables/schema",
            get(point_tables::project_schema),
        )
        .route(
            "/projects/{pid}/board-models/{mid}/point-tables/{kind}",
            get(point_tables::read),
        )
        .route(
            "/projects/{pid}/board-models/{mid}/point-tables/{kind}/preview",
            post(point_tables::preview),
        )
        .route("/project-template", get(project_config::template))
        .route(
            "/projects/{pid}/board-models/{mid}/point-tables/{kind}/reorder/preview",
            post(point_order::preview),
        )
        .route("/projects/{pid}/configuration", get(project_config::read))
        .route("/projects", get(api::projects).post(api::create_project))
        .route("/projects/{pid}/overview", get(api::overview))
        .route("/projects/{pid}/topology", get(topology::read))
        .route("/projects/{pid}/sources/{id}", get(topology::source))
        .route("/projects/{pid}/changes/preview", post(topology::preview))
        .route(
            "/projects/{pid}/changes/{id}/commit",
            post(topology::commit),
        )
        .route("/projects/{pid}/validation", get(api::validate))
        .route("/projects/{pid}/imports/preview", post(api::preview_import))
        .route(
            "/projects/{pid}/imports/{id}/commit",
            post(api::commit_import),
        )
        .route("/projects/{pid}/generate", get(api::generate))
        .route(
            "/projects/{pid}/releases",
            get(api::releases).post(api::release),
        )
        .route(
            "/projects/{pid}/releases/{id}/download",
            get(api::download_release),
        )
        .route("/projects/{pid}/export", get(api::export_json))
        .route("/projects/{pid}/audit", get(api::audit))
        .route(
            "/projects/{pid}/members",
            get(api::members).put(api::set_member),
        )
        .route("/projects/{pid}/sql", post(sql_workspace::execute))
        .route("/sql/definitions", get(sql_workspace::definitions))
        .route("/users", get(api::users).post(api::create_user))
        .route("/users/{id}", put(api::update_user))
        .fallback(api::fallback)
        .layer(DefaultBodyLimit::max(15 * 1024 * 1024))
        .layer(middleware::from_fn(csrf));
    let static_dir = std::env::var("STATIC_DIR").unwrap_or("frontend/dist".into());
    let app=Router::new().nest("/api",api)
      .fallback_service(ServeDir::new(&static_dir).not_found_service(ServeFile::new(format!("{static_dir}/index.html"))))
      .layer(SetResponseHeaderLayer::if_not_present(axum::http::header::X_CONTENT_TYPE_OPTIONS,HeaderValue::from_static("nosniff")))
      .layer(SetResponseHeaderLayer::if_not_present(axum::http::header::CONTENT_SECURITY_POLICY,HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")))
      .layer(SetResponseHeaderLayer::if_not_present(axum::http::header::CACHE_CONTROL,HeaderValue::from_static("no-store")))
      .layer(TraceLayer::new_for_http()).with_state(state);
    let bind = std::env::var("BIND_ADDR").unwrap_or("127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("Protocol Studio: http://{bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn imports_real_workbook_without_formula_cache() {
        let bytes = std::fs::read("UPM项目测点数据表.xlsx").expect("reference workbook");
        let imported = crate::importer::parse(bytes).expect("parse source workbook");
        assert_eq!(
            imported.points.iter().filter(|p| p.scope == "DSP").count(),
            445
        );
        assert_eq!(
            imported
                .points
                .iter()
                .filter(|p| p.scope == "LOCAL")
                .count(),
            167
        );
        assert_eq!(imported.devices.len(), 9);
        assert_eq!(
            imported
                .points
                .iter()
                .find(|p| p.enum_name == "PARAM_PRODUCT_TYPE")
                .unwrap()
                .upp_offset,
            Some(48)
        );
    }
}
