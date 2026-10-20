use crate::{
    AppState,
    auth::{User, hash_password},
    codegen, db,
    error::{AppError, Result},
    model, topology, topology_validation,
};
use axum::{
    Json,
    extract::{Multipart, Path, Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub async fn projects(State(s): State<AppState>, u: User) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, None, false).await?;
    let mut rows: Vec<Value> = sqlx::query_scalar(r#"
        SELECT to_jsonb(p) || jsonb_build_object(
            'role', CASE WHEN app_is_admin() THEN 'admin' ELSE
                (SELECT role FROM meta.project_members WHERE project_id=p.id AND user_id=app_user_id()) END)
        FROM meta.projects p WHERE p.status='ready' ORDER BY p.id"#)
        .fetch_all(&mut *tx).await?;
    tx.rollback().await?;
    for project in &mut rows {
        let pid = project["id"]
            .as_i64()
            .ok_or(AppError::bad("项目登记无效"))?;
        let mut business = db::read_snapshot_context(&s.pool, &u, pid).await?;
        let state: Value = sqlx::query_scalar("SELECT (to_jsonb(p)-'edit_owner_id'-'edit_owner_name'-'edit_owner_username'-'edit_expires_at') || jsonb_build_object('point_count',(SELECT count(*) FROM points.process_points WHERE project_id=$1)) FROM meta.project_state p WHERE p.id=$1")
            .bind(pid).fetch_one(&mut *business).await?;
        project
            .as_object_mut()
            .unwrap()
            .extend(state.as_object().unwrap().clone());
    }
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
pub struct ProjectInput {
    config_key: Option<String>,
    name: Option<String>,
    #[serde(default)]
    config: Option<Value>,
    #[serde(default)]
    description: Option<String>,
}
pub async fn create_project(
    State(s): State<AppState>,
    u: User,
    Json(input): Json<ProjectInput>,
) -> Result<Json<Value>> {
    u.admin()?;
    let key = input
        .config_key
        .as_deref()
        .ok_or(AppError::bad("请选择项目配置目录 config_key"))?;
    let manifest = s
        .project_files
        .manifest(key)
        .map_err(|e| AppError::bad(format!("{e:#}")))?
        .ok_or(AppError::bad(
            "项目配置目录不存在，请检查 config 下的项目文件夹",
        ))?;
    let name = input
        .name
        .as_deref()
        .unwrap_or(manifest["name"].as_str().unwrap())
        .trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(AppError::bad("请输入 1～120 字符的项目名称"));
    }
    let description = input
        .description
        .as_deref()
        .unwrap_or(manifest["description"].as_str().unwrap_or(""));
    let config = input.config.as_ref().unwrap_or(&manifest["topology"]);
    crate::project_config::validate_directory(&s.project_files, Some(key), config)?;
    let project = s
        .project_files
        .create_configured(&s.pool, &u, key, name, description, config)
        .await?;
    Ok(Json(project))
}
pub async fn overview(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    let project: Value = sqlx::query_scalar("SELECT to_jsonb(p)-'edit_owner_id'-'edit_owner_name'-'edit_owner_username'-'edit_expires_at' FROM meta.project_state p WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    let g = topology::snapshot(&mut tx, pid, true).await?;
    let config = crate::project_config::Config::parse(g["project_config"].clone())?;
    let stats = json!({"total":topology::rows(&g,"process_points").len(),"boards":config.board_types.len(),"signals":topology::rows(&g,"process_points").len(),"links":config.mounts.len()});
    let transmit = topology::rows(&g, "transmit_points").len();
    let report = topology_validation::validate(&g);
    let activity=db::all_json(&mut tx,"SELECT to_jsonb(t) FROM (SELECT a.id,a.action,a.entity,a.created_at,a.actor_name AS display_name FROM history.events a WHERE kind='audit' AND project_id=$1 ORDER BY a.id DESC LIMIT 8) t",pid).await?;
    Ok(Json(
        json!({"project":project,"has_configuration":topology::TABLES.iter().any(|t|g[*t].as_array().is_some_and(|a|!a.is_empty())),"stats":stats,"transmit_count":transmit,"validation":report,"activity":activity}),
    ))
}
pub async fn validate(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    sqlx::query("SELECT id FROM meta.project_state WHERE id=$1 FOR SHARE")
        .bind(pid)
        .execute(&mut *tx)
        .await?;
    let graph = topology::snapshot(&mut tx, pid, true).await?;
    let mut report = topology_validation::validate(&graph);
    let issues = crate::table_calculation::issues(&mut tx, pid, &s.project_files, &graph).await?;
    report["errors"] = json!(report["errors"].as_u64().unwrap_or(0) + issues.len() as u64);
    report["issues"].as_array_mut().unwrap().extend(issues);
    Ok(Json(report))
}
#[derive(Deserialize)]
pub struct ImportScope {
    #[serde(default)]
    board: String,
}
pub async fn preview_import(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
    Query(scope): Query<ImportScope>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    crate::permissions::require_all(&mut tx, pid).await?;
    let key: String = sqlx::query_scalar("SELECT config_key FROM meta.project_state WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    let definitions = s
        .project_files
        .definition(Some(&key))
        .map_err(|e| AppError::bad(format!("{e:#}")))?;
    let board_key = if scope.board.is_empty() {
        definitions["imports"]
            .as_object()
            .and_then(|v| v.keys().next())
            .cloned()
            .ok_or(AppError::bad("项目未配置工作簿映射"))?
    } else {
        scope.board
    };
    let configured = crate::native_points::native_board(&mut tx, pid, &board_key)
        .await?
        .ok_or(AppError::bad("请先应用所选板卡的原生点表配置"))?;
    let definition = definitions["imports"][&board_key].clone();
    crate::workbook_import::validate_for(&configured, &definition)?;
    tx.rollback().await?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| AppError::bad("上传文件无效"))?
        .ok_or(AppError::bad("请选择 Excel 文件"))?;
    let filename = field.file_name().unwrap_or("points.xlsx").to_owned();
    if !filename.to_lowercase().ends_with(".xlsx") {
        return Err(AppError::bad("仅支持 .xlsx 工作簿"));
    }
    let bytes = field
        .bytes()
        .await
        .map_err(|_| AppError::bad("文件过大或上传失败"))?
        .to_vec();
    let hash = hex::encode(Sha256::digest(&bytes));
    let device_count = configured["point_groups"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|g| g["devices"].as_array().map_or(0, Vec::len))
        .sum::<usize>()
        .max(1);
    let board = configured.clone();
    let import_definition = definition.clone();
    let data = tokio::task::spawn_blocking(move || {
        crate::workbook_import::parse_workbook(bytes, &board, &import_definition)
    })
    .await
    .map_err(|_| AppError::bad("Excel 解析失败"))??;
    let data = serde_json::to_value(data)?;
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    crate::permissions::require_all(&mut tx, pid).await?;
    let revision = db::lock_project(&mut tx, pid).await?;
    sqlx::query(
        "DELETE FROM meta.previews WHERE kind='import' AND created_by=$1 AND project_id=$2",
    )
    .bind(u.id)
    .bind(pid)
    .execute(&mut *tx)
    .await?;
    let id: i64 = sqlx::query_scalar("INSERT INTO meta.previews(kind,project_id,created_by,filename,sha256,revision,payload,expires_at) VALUES('import',$1,$2,$3,$4,$5,$6,now()+interval '1 hour') RETURNING id")
        .bind(pid).bind(u.id).bind(&filename).bind(&hash).bind(revision)
        .bind(json!({"kind":"board_native","board_key":board_key,"board":configured,"definition":definition,"data":data})).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let process = data["process"].as_array().unwrap();
    let group_counts:Vec<Value> = crate::topology::rows(&configured,"point_groups").iter().map(|g|json!({"code":g["code"],"name":g["name"],"count":process.iter().filter(|p|p["group_key"]==g["code"]).count()})).collect();
    Ok(Json(
        json!({"id":id,"filename":filename,"sha256":hash,"revision":revision,
        "import_scope":board_key.to_lowercase(),"board_key":board_key,"board_name":configured["name"],
        "point_count":process.len(),"group_counts":group_counts,
        "collect_count":data["collect"].as_array().unwrap().len(),
        "transmit_count":data["transmit"].as_array().unwrap().len(),
        "mapping_count":data["transmit"].as_array().unwrap().len(),
        "device_count":device_count,"warnings":data["warnings"],"sheets":crate::workbook_import::sheets(&definition),
        "sample":process.iter().take(6).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
pub struct CommitImport {
    #[serde(default)]
    replace: bool,
}
pub async fn commit_import(
    State(s): State<AppState>,
    u: User,
    Path((pid, id)): Path<(i64, i64)>,
    Json(input): Json<CommitImport>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    crate::permissions::require_all(&mut tx, pid).await?;
    let rev = db::lock_project(&mut tx, pid).await?;
    let row:Value=sqlx::query_scalar("SELECT to_jsonb(i) FROM meta.previews i WHERE kind='import' AND project_id=$1 AND id=$2 AND created_by=$3 AND expires_at>now() FOR UPDATE").bind(pid).bind(id).bind(u.id).fetch_optional(&mut *tx).await?.ok_or(AppError::bad("预览已过期或已使用，请重新上传"))?;
    if row["revision"] != rev {
        return Err(AppError::revision_conflict(
            row["revision"].as_i64().unwrap_or_default() as i32,
            rev,
        ));
    }
    let before = db::snapshot(&mut tx, pid).await?;
    if row["payload"]["kind"] != "board_native" {
        return Err(AppError::bad("旧导入预览已失效，请重新上传"));
    }
    let scope = row["payload"]["board_key"]
        .as_str()
        .ok_or(AppError::bad("预览缺少板卡"))?;
    let board = crate::native_points::native_board(&mut tx, pid, scope).await?;
    let key: String = sqlx::query_scalar("SELECT config_key FROM meta.project_state WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    let definitions = s
        .project_files
        .definition(Some(&key))
        .map_err(|e| AppError::bad(format!("{e:#}")))?;
    if board.as_ref() != Some(&row["payload"]["board"])
        || definitions["imports"][scope] != row["payload"]["definition"]
    {
        return Err(AppError::conflict(
            "板卡或工作簿映射配置已变化，请重新上传并预览",
        ));
    }
    if !input.replace
        && topology::TABLES
            .iter()
            .any(|t| before[*t].as_array().is_some_and(|a| !a.is_empty()))
    {
        return Err(AppError::conflict("项目已有配置，必须明确确认替换"));
    }
    let data: crate::workbook_import::ImportData =
        serde_json::from_value(row["payload"]["data"].clone())?;
    crate::native_protocol::import(&mut tx, pid, scope, &data).await?;
    let graph = topology::snapshot(&mut tx, pid, true).await?;
    let report = topology_validation::validate(&graph);
    let errors = topology::new_errors(&topology_validation::validate(&before), &report);
    if !errors.is_empty() {
        let mut error = AppError::bad("点表导入校验失败，数据未保存");
        error.2 = Some(json!({"errors":errors}));
        return Err(error);
    }
    let point_count = row["payload"]["data"]["process"]
        .as_array()
        .map_or(0, Vec::len);
    db::touch(&mut tx, pid).await?;
    db::record_import(
        &mut tx,
        pid,
        u.id,
        row["filename"]
            .as_str()
            .ok_or(AppError::bad("导入预览缺少文件名"))?,
        row["sha256"]
            .as_str()
            .ok_or(AppError::bad("导入预览缺少文件校验值"))?,
        &report,
    )
    .await?;
    sqlx::query("DELETE FROM meta.previews WHERE kind='import' AND id=$1 AND project_id=$2 AND created_by=$3")
        .bind(id)
        .bind(pid)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    let after = topology::snapshot(&mut tx, pid, true).await?;
    crate::native_points::history(&mut tx, pid, u.id, "workbook.import", &before, &after).await?;
    db::audit(&mut tx,u.id,Some(pid),"import.commit","workbook",Some(before),Some(json!({"filename":row["filename"],"sha256":row["sha256"],"point_count":point_count,"validation":report}))).await?;
    crate::edit_lock::release_owned(&mut tx, pid, u.id).await?;
    tx.commit().await?;
    Ok(Json(report))
}
pub async fn generate(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    // PostgreSQL provides a consistent snapshot across all generation queries.
    let mut tx = db::read_snapshot_context(&s.pool, &u, pid).await?;
    Ok(Json(
        codegen::generate(&mut tx, pid, &s.project_files).await?,
    ))
}
pub async fn releases(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    Ok(Json(json!(db::all_json(&mut tx,"SELECT to_jsonb(r)-'snapshot'-'files' FROM history.releases r WHERE project_id=$1 ORDER BY id DESC",pid).await?)))
}
#[derive(Deserialize)]
pub struct ReleaseInput {
    name: String,
    revision: i32,
}
pub async fn release(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
    Json(input): Json<ReleaseInput>,
) -> Result<Json<Value>> {
    if input.name.trim().is_empty() || input.name.len() > 80 {
        return Err(AppError::bad("版本名称应为 1～80 字符"));
    }
    let mut tx = db::context(&s.pool, &u, Some(pid), true).await?;
    crate::permissions::require_all(&mut tx, pid).await?;
    let rev = db::lock_project(&mut tx, pid).await?;
    if input.revision != rev {
        return Err(AppError::revision_conflict(input.revision, rev));
    }
    let generated = codegen::generate(&mut tx, pid, &s.project_files).await?;
    if generated["blocked"] == true {
        return Err(AppError::conflict(
            "存在阻断性校验错误，请在校验中心修复后发布",
        ));
    }
    let snapshot = db::snapshot(&mut tx, pid).await?;
    let hash = hex::encode(Sha256::digest(serde_json::to_vec(&generated["files"])?));
    let row:Value=sqlx::query_scalar("INSERT INTO history.releases AS inserted(project_id,name,revision,snapshot,files,sha256,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,current_setting('app.actor_name',true)) RETURNING to_jsonb(inserted.*)-'snapshot'-'files'").bind(pid).bind(input.name.trim()).bind(rev).bind(snapshot).bind(&generated["files"]).bind(hash).bind(u.id).fetch_one(&mut *tx).await?;
    db::audit(
        &mut tx,
        u.id,
        Some(pid),
        "release.create",
        &row["id"].to_string(),
        None,
        Some(row.clone()),
    )
    .await?;
    crate::edit_lock::release_owned(&mut tx, pid, u.id).await?;
    tx.commit().await?;
    Ok(Json(row))
}
pub async fn download_release(
    State(s): State<AppState>,
    u: User,
    Path((pid, id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    let row: Value = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM history.releases r WHERE project_id=$1 AND id=$2",
    )
    .bind(pid)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::not_found())?;
    let bytes = codegen::zip_files(
        &row["files"],
        &json!({"project_id":pid,"release_id":id,"name":row["name"],"revision":row["revision"],"sha256":row["sha256"],"created_at":row["created_at"]}),
    )?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=protocol-{pid}-release-{id}.zip"),
            ),
        ],
        bytes,
    ))
}
pub async fn export_json(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<impl IntoResponse> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    sqlx::query("SELECT id FROM meta.project_state WHERE id=$1 FOR SHARE")
        .bind(pid)
        .execute(&mut *tx)
        .await?;
    let snap = db::snapshot(&mut tx, pid).await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/json; charset=utf-8".to_owned(),
            ),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=protocol-{pid}.json"),
            ),
        ],
        serde_json::to_string_pretty(&snap)?,
    ))
}
pub async fn audit(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, Some(pid), false).await?;
    Ok(Json(json!(db::all_json(&mut tx,"SELECT to_jsonb(t) FROM (SELECT a.id,a.project_id,a.actor_id AS user_id,a.actor_name,a.action,a.entity,a.before_data,a.after_data,a.created_at,a.actor_name AS display_name FROM history.events a WHERE kind='audit' AND project_id=$1 ORDER BY a.id DESC LIMIT 200) t",pid).await?)))
}
pub async fn members(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
) -> Result<Json<Value>> {
    let mut tx = db::context(&s.pool, &u, None, false).await?;
    let allowed: bool = sqlx::query_scalar("SELECT app_can_access($1,false) AND EXISTS(SELECT 1 FROM meta.projects WHERE id=$1 AND status='ready')")
        .bind(pid).fetch_one(&mut *tx).await?;
    if !allowed {
        return Err(AppError::forbidden());
    }
    Ok(Json(json!(db::all_json(&mut tx,"SELECT to_jsonb(t) FROM (SELECT u.id,u.username,u.display_name,u.active,m.role,m.edit_scope,COALESCE((SELECT jsonb_agg(jsonb_build_object('board_key',g.board_key,'scope',g.scope,'endpoint_key',g.endpoint_key) ORDER BY g.board_key,g.scope,g.endpoint_key) FROM meta.project_member_grants g WHERE g.project_id=m.project_id AND g.user_id=m.user_id),'[]'::jsonb) AS grants FROM meta.project_members m JOIN auth.users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.id) t",pid).await?)))
}
#[derive(Deserialize)]
pub struct MemberInput {
    user_id: i64,
    role: String,
    edit_scope: Option<String>,
    grants: Option<Vec<crate::permissions::Grant>>,
}
pub async fn set_member(
    State(s): State<AppState>,
    u: User,
    Path(pid): Path<i64>,
    Json(input): Json<MemberInput>,
) -> Result<Json<Value>> {
    u.admin()?;
    if !["engineer", "viewer", "remove"].contains(&input.role.as_str()) {
        return Err(AppError::bad("角色无效"));
    }
    let mut tx = db::context(&s.pool, &u, None, true).await?;
    let administrator: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM auth.users WHERE id=$1 AND active AND is_admin FOR SHARE",
    )
    .bind(u.id)
    .fetch_optional(&mut *tx)
    .await?;
    if administrator.is_none() {
        return Err(AppError::forbidden());
    }
    db::require_admin(&mut tx).await?;
    let registry: crate::database::Registry = sqlx::query_as("SELECT id,project_uid::text AS project_uid,config_key,name,description,database_name,status FROM meta.projects WHERE id=$1 AND status='ready' FOR UPDATE")
        .bind(pid).fetch_optional(&mut *tx).await?.ok_or_else(AppError::not_found)?;
    if input
        .edit_scope
        .as_ref()
        .is_some_and(|scope| !["all", "scoped"].contains(&scope.as_str()))
    {
        return Err(AppError::bad("编辑范围必须为 all 或 scoped"));
    }
    if let Some(grants) = &input.grants {
        // The platform registry lock excludes all project writers while this
        // immutable configuration snapshot is used to validate new permissions.
        let pool = s.pool.pool_for_registry(&registry, false).await?;
        let mut business = pool.begin().await?;
        sqlx::query("SET TRANSACTION READ ONLY")
            .execute(&mut *business)
            .await?;
        sqlx::query("SELECT set_config('app.user_id',$1,true),set_config('app.project_id',$2,true),set_config('app.access',$3,true)")
            .bind(u.id.to_string()).bind(pid.to_string())
            .bind(json!({"role":"admin","edit_scope":"all","grants":[]}).to_string())
            .execute(&mut *business).await?;
        let config: Value =
            sqlx::query_scalar("SELECT topology_config FROM meta.project_state WHERE id=$1")
                .bind(pid)
                .fetch_one(&mut *business)
                .await?;
        crate::permissions::validate_grants_graph(&json!({"project_config":config}), grants)?;
        business.rollback().await?;
    }
    let before: Option<Value> = sqlx::query_scalar("SELECT to_jsonb(m)||jsonb_build_object('grants',COALESCE((SELECT jsonb_agg(to_jsonb(g)-'project_id'-'user_id') FROM meta.project_member_grants g WHERE g.project_id=m.project_id AND g.user_id=m.user_id),'[]'::jsonb)) FROM meta.project_members m WHERE m.project_id=$1 AND m.user_id=$2").bind(pid).bind(input.user_id).fetch_optional(&mut *tx).await?;
    if input.role == "remove" {
        sqlx::query("DELETE FROM meta.project_members WHERE project_id=$1 AND user_id=$2")
            .bind(pid)
            .bind(input.user_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("INSERT INTO meta.project_members(project_id,user_id,role,edit_scope) VALUES($1,$2,$3,COALESCE($4,'all')) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,edit_scope=COALESCE($4,project_members.edit_scope)").bind(pid).bind(input.user_id).bind(&input.role).bind(&input.edit_scope).execute(&mut *tx).await?;
        if let Some(grants) = &input.grants {
            sqlx::query(
                "DELETE FROM meta.project_member_grants WHERE project_id=$1 AND user_id=$2",
            )
            .bind(pid)
            .bind(input.user_id)
            .execute(&mut *tx)
            .await?;
            for grant in grants {
                sqlx::query("INSERT INTO meta.project_member_grants(project_id,user_id,board_key,scope,endpoint_key) VALUES($1,$2,$3,$4,$5)").bind(pid).bind(input.user_id).bind(&grant.board_key).bind(&grant.scope).bind(&grant.endpoint_key).execute(&mut *tx).await?;
            }
        }
    }
    let after: Option<Value> = sqlx::query_scalar("SELECT to_jsonb(m)||jsonb_build_object('grants',COALESCE((SELECT jsonb_agg(to_jsonb(g)-'project_id'-'user_id') FROM meta.project_member_grants g WHERE g.project_id=m.project_id AND g.user_id=m.user_id),'[]'::jsonb)) FROM meta.project_members m WHERE m.project_id=$1 AND m.user_id=$2").bind(pid).bind(input.user_id).fetch_optional(&mut *tx).await?;
    db::audit(
        &mut tx,
        u.id,
        Some(pid),
        "member.update",
        &input.user_id.to_string(),
        before,
        after,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn users(State(s): State<AppState>, u: User) -> Result<Json<Value>> {
    u.admin()?;
    let rows: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(u)-'password_hash' FROM auth.users u ORDER BY id")
            .fetch_all(&s.pool.platform)
            .await?;
    Ok(Json(json!(rows)))
}
#[derive(Deserialize)]
pub struct UserInput {
    username: String,
    display_name: String,
    password: String,
    #[serde(default)]
    is_admin: bool,
}
pub async fn create_user(
    State(s): State<AppState>,
    u: User,
    Json(input): Json<UserInput>,
) -> Result<Json<Value>> {
    u.admin()?;
    if !model::identifier(&input.username)
        || input.username.len() > 80
        || input.display_name.trim().is_empty()
        || input.display_name.len() > 100
    {
        return Err(AppError::bad(
            "用户名须为字母、数字、下划线，显示名称不能为空",
        ));
    }
    let hash = hash_password(input.password).await?;
    let mut tx = db::context(&s.pool, &u, None, true).await?;
    // Same ordering as update_user: serialize user creation with revocation.
    sqlx::query("LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    db::require_admin(&mut tx).await?;
    let row:Value=sqlx::query_scalar("INSERT INTO auth.users(username,display_name,password_hash,is_admin) VALUES($1,$2,$3,$4) RETURNING to_jsonb(users.*)-'password_hash'").bind(input.username).bind(input.display_name).bind(hash).bind(input.is_admin).fetch_one(&mut *tx).await?;
    db::audit(
        &mut tx,
        u.id,
        None,
        "user.create",
        &row["id"].to_string(),
        None,
        Some(row.clone()),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}
#[derive(Deserialize)]
pub struct UserUpdate {
    active: bool,
    is_admin: bool,
    #[serde(default)]
    password: String,
}
pub async fn update_user(
    State(s): State<AppState>,
    u: User,
    Path(id): Path<i64>,
    Json(input): Json<UserUpdate>,
) -> Result<Json<Value>> {
    u.admin()?;
    if id == u.id && (!input.active || !input.is_admin) {
        return Err(AppError::bad("不能禁用自己或撤销自己的管理员权限"));
    }
    let hash = if input.password.is_empty() {
        None
    } else {
        Some(hash_password(input.password).await?)
    };
    let mut tx = db::context(&s.pool, &u, None, true).await?;
    sqlx::query("LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    db::require_admin(&mut tx).await?;
    let row:Value=sqlx::query_scalar("UPDATE auth.users SET active=$2,is_admin=$3,password_hash=COALESCE($4,password_hash) WHERE id=$1 RETURNING to_jsonb(users.*)-'password_hash'").bind(id).bind(input.active).bind(input.is_admin).bind(hash).fetch_optional(&mut *tx).await?.ok_or(AppError::not_found())?;
    sqlx::query("DELETE FROM auth.sessions WHERE user_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    db::audit(
        &mut tx,
        u.id,
        None,
        "user.update",
        &id.to_string(),
        None,
        Some(row.clone()),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(row))
}
pub async fn health(State(s): State<AppState>) -> Result<Json<Value>> {
    sqlx::query("SELECT 1").execute(&s.pool.platform).await?;
    Ok(Json(json!({"status":"ok","database":"PostgreSQL"})))
}
pub async fn fallback() -> (StatusCode, Json<Value>) {
    (StatusCode::NOT_FOUND, Json(json!({"error":"API 不存在"})))
}
