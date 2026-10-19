//! Project-folder replacement with revision checks and a recoverable filesystem journal.
use crate::{
    AppState,
    auth::User,
    db, edit_lock,
    error::{AppError, Result},
    project_config, project_dump,
    project_files::ProjectFiles,
    topology, topology_validation,
};
use axum::{
    Json,
    extract::{Multipart, Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const LIFETIME: i64 = 30 * 60;

fn bad(error: impl std::fmt::Display) -> AppError {
    AppError::bad(error.to_string())
}
fn io(error: std::io::Error) -> AppError {
    tracing::error!(%error, "project folder operation failed");
    AppError::bad("无法读写项目目录，请检查服务器目录权限和磁盘空间")
}

/// Prevent requests seeing the short interval between directory installation and
/// database commit. The database project lock also serializes concurrent writers.
pub async fn file_gate(State(s): State<AppState>, request: Request, next: Next) -> Response {
    let unavailable = || {
        AppError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "项目导入需要恢复，请重启服务；服务会依据数据库提交记录恢复配置目录",
        )
        .into_response()
    };
    if request.uri().path().ends_with("/project-folders/commit") {
        let mut guard = s.folder_gate.write().await;
        if *guard {
            return unavailable();
        }
        // Cancellation or an indeterminate commit must not let later requests
        // observe a directory whose database transaction still needs recovery.
        *guard = true;
        let response = next.run(request).await;
        *guard = unresolved_journal(s.project_files.root());
        response
    } else {
        let guard = s.folder_gate.read().await;
        if *guard {
            return unavailable();
        }
        next.run(request).await
    }
}
fn unresolved_journal(root: &Path) -> bool {
    match fs::read_dir(root.join(".imports")) {
        Ok(entries) => entries
            .into_iter()
            .any(|entry| entry.map_or(true, |e| e.path().join("journal.json").exists())),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

#[derive(Serialize, Deserialize)]
struct Pending {
    token: String,
    owner: i64,
    expires: i64,
    key: String,
    existing_project_id: Option<i64>,
    revision: Option<i32>,
    original_hash: Option<String>,
    uploaded_hash: String,
    replace_data: bool,
    files: Vec<String>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    token: String,
    key: String,
    had_original: bool,
}

fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(io)?;
    if fs::symlink_metadata(path)
        .map_err(io)?
        .file_type()
        .is_symlink()
    {
        return Err(AppError::bad("导入暂存目录不能为符号链接"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(io)?;
    }
    Ok(())
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("tmp");
    let mut file = fs::File::create(&temporary).map_err(io)?;
    file.write_all(&serde_json::to_vec(value)?).map_err(io)?;
    file.sync_all().map_err(io)?;
    fs::rename(temporary, path).map_err(io)?;
    sync_dir(path.parent().unwrap())
}
fn sync_dir(path: &Path) -> Result<()> {
    fs::File::open(path).and_then(|f| f.sync_all()).map_err(io)
}
fn sync_tree(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path).map_err(io)? {
        let entry = entry.map_err(io)?;
        if entry.file_type().map_err(io)?.is_dir() {
            sync_tree(&entry.path())?;
        }
    }
    sync_dir(path)
}
fn token_valid(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit())
}
fn upload_path(name: &str) -> Result<Vec<&str>> {
    let parts: Vec<_> = name.split('/').collect();
    if name.len() > 512
        || parts.len() < 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || part.contains(['\\', ':'])
                || part.chars().any(char::is_control)
        })
    {
        return Err(AppError::bad(
            "文件路径须包含一个项目根目录，不能包含隐藏文件、绝对路径或 ..",
        ));
    }
    Ok(parts)
}
struct StagingGuard(Option<PathBuf>);
impl Drop for StagingGuard {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_dir_all(path);
        }
    }
}

async fn begin(pool: &PgPool, user: &User) -> Result<Transaction<'static, Postgres>> {
    let mut tx = db::context(pool, user, None, true).await?;
    let administrator: Option<i64> =
        sqlx::query_scalar("SELECT id FROM users WHERE id=$1 AND active AND is_admin FOR SHARE")
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await?;
    if administrator.is_none() {
        return Err(AppError::forbidden());
    }
    db::require_admin(&mut tx).await?;
    // Same lock as CLI/HTTP project creation; also serializes cross-process imports.
    sqlx::query("SELECT pg_advisory_xact_lock(192837465, 1)")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}
async fn target(tx: &mut Transaction<'_, Postgres>, key: &str) -> Result<Option<(i64, i32)>> {
    Ok(
        sqlx::query_as("SELECT id,revision FROM projects WHERE config_key=$1 FOR UPDATE")
            .bind(key)
            .fetch_optional(&mut **tx)
            .await?,
    )
}

/// Used in both preview (rolled back) and commit, with identical validation.
async fn apply(
    tx: &mut Transaction<'_, Postgres>,
    user: &User,
    manifest: &Value,
    existing: Option<(i64, i32)>,
    payload: Option<&Value>,
) -> Result<(i64, Value)> {
    let pid = if let Some((pid, _)) = existing {
        edit_lock::require_available(tx, pid, user.id).await?;
        pid
    } else {
        sqlx::query_scalar(
            "INSERT INTO projects(name,description,config_key) VALUES($1,$2,$3) RETURNING id",
        )
        .bind(manifest["name"].as_str())
        .bind(manifest["description"].as_str().unwrap_or(""))
        .bind(manifest["key"].as_str())
        .fetch_one(&mut **tx)
        .await?
    };
    sqlx::query("SELECT set_config('app.project_id',$1,true)")
        .bind(pid.to_string())
        .execute(&mut **tx)
        .await?;
    let before = topology::snapshot(tx, pid, true).await?;
    let restored = if let Some(payload) = payload {
        project_dump::replace(tx, pid, payload).await?
    } else {
        Value::Null
    };
    project_config::apply(tx, pid, &manifest["topology"]).await?;
    sqlx::query("UPDATE projects SET name=$2,description=$3 WHERE id=$1")
        .bind(pid)
        .bind(manifest["name"].as_str())
        .bind(manifest["description"].as_str().unwrap_or(""))
        .execute(&mut **tx)
        .await?;
    let after = topology::snapshot(tx, pid, true).await?;
    let report = topology_validation::validate(&after);
    let errors = if payload.is_some() {
        topology::rows(&report, "issues")
            .iter()
            .filter(|i| i["level"] == "error")
            .cloned()
            .collect::<Vec<_>>()
    } else {
        topology::new_errors(&topology_validation::validate(&before), &report)
    };
    if !errors.is_empty() {
        return Err(AppError(
            axum::http::StatusCode::BAD_REQUEST,
            "项目配置或 Dump 导致数据校验失败，未导入".into(),
            Some(json!({"errors":errors})),
        ));
    }
    Ok((
        pid,
        json!({"point_count":topology::rows(&after,"process_points").len(),
        "signal_count":topology::rows(&after,"process_points").len(),
        "transmit_count":topology::rows(&after,"transmit_points").len(),"validation":report,"restored":restored}),
    ))
}

pub async fn preview(
    State(s): State<AppState>,
    user: User,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    user.admin()?;
    let mut random = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random);
    let token = hex::encode(random);
    let imports = s.project_files.root().join(".imports");
    private_directory(&imports)?;
    let directory = imports.join(&token);
    private_directory(&directory)?;
    sync_dir(&imports)?;
    let mut cleanup = StagingGuard(Some(directory.clone()));
    let stage = directory.join("stage");
    private_directory(&stage)?;
    let mut root_name = None;
    let mut names = BTreeSet::new();
    let mut total = 0usize;
    while let Some(mut field) = multipart.next_field().await.map_err(bad)? {
        if field.name() != Some("files") {
            return Err(AppError::bad("上传字段必须为 files"));
        }
        let name = field
            .file_name()
            .ok_or(AppError::bad("缺少文件相对路径"))?
            .to_owned();
        let parts = upload_path(&name)?;
        if root_name.as_deref().is_some_and(|root| root != parts[0]) {
            return Err(AppError::bad("一次只能导入一个项目文件夹"));
        }
        root_name = Some(parts[0].to_owned());
        let relative = parts[1..].join("/");
        if !names.insert(relative.clone()) || names.len() > 512 {
            return Err(AppError::bad("存在重复文件，或文件数超过 512"));
        }
        let destination = stage.join(&name);
        fs::create_dir_all(destination.parent().unwrap()).map_err(io)?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(io)?;
        while let Some(chunk) = field.chunk().await.map_err(bad)? {
            total += chunk.len();
            if total > MAX_BYTES {
                return Err(AppError::bad("项目文件总大小不能超过 64 MiB"));
            }
            file.write_all(&chunk).map_err(io)?;
        }
        file.sync_all().map_err(io)?;
    }
    let root_name = root_name.ok_or(AppError::bad("请选择完整项目文件夹"))?;
    let raw: Value = serde_json::from_slice(
        &fs::read(stage.join(&root_name).join("project.json"))
            .map_err(|_| AppError::bad("所选文件夹根目录缺少可读取的 project.json"))?,
    )?;
    let key = raw["key"]
        .as_str()
        .ok_or(AppError::bad("project.json 缺少 key"))?
        .to_owned();
    if key.is_empty()
        || key.len() > 64
        || !key
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
    {
        return Err(AppError::bad(
            "项目 key 只能包含小写字母、数字、下划线和连字符",
        ));
    }
    if root_name != key {
        fs::rename(stage.join(root_name), stage.join(&key)).map_err(io)?;
    }
    // Keep imported point archives private after this directory leaves staging.
    private_directory(&stage.join(&key))?;
    let uploaded = ProjectFiles::load_from(&stage).map_err(bad)?;
    let manifest = uploaded
        .manifest(&key)
        .map_err(bad)?
        .ok_or(AppError::bad("缺少项目清单"))?;
    let dump = uploaded.dump_path(&key).map_err(bad)?;
    let payload = if let Some(path) = &dump {
        Some(project_dump::decode(path, &key).await?)
    } else {
        None
    };
    let original_hash = s.project_files.fingerprint(&key).map_err(bad)?;
    let uploaded_hash = uploaded.fingerprint(&key).map_err(bad)?.unwrap();
    let mut tx = begin(&s.pool, &user).await?;
    let existing = target(&mut tx, &key).await?;
    let (_, summary) = apply(&mut tx, &user, &manifest, existing, payload.as_ref()).await?;
    tx.rollback().await?;
    sync_tree(&stage)?;
    let pending = Pending {
        token: token.clone(),
        owner: user.id,
        expires: chrono::Utc::now().timestamp() + LIFETIME,
        key: key.clone(),
        existing_project_id: existing.map(|v| v.0),
        revision: existing.map(|v| v.1),
        original_hash,
        uploaded_hash,
        replace_data: dump.is_some(),
        files: names.into_iter().collect(),
    };
    write_json(&directory.join("preview.json"), &pending)?;
    cleanup.0 = None;
    Ok(Json(
        json!({"token":token,"key":key,"name":manifest["name"],"existing_project_id":pending.existing_project_id,
        "revision":pending.revision,"replace_data":pending.replace_data,"files":pending.files,"summary":summary}),
    ))
}

#[derive(Deserialize)]
pub struct Commit {
    token: String,
}
pub async fn commit(
    State(s): State<AppState>,
    user: User,
    Json(input): Json<Commit>,
) -> Result<Json<Value>> {
    user.admin()?;
    if !token_valid(&input.token) {
        return Err(AppError::bad("无效的导入预览"));
    }
    let directory = s.project_files.root().join(".imports").join(&input.token);
    let pending: Pending = serde_json::from_slice(
        &fs::read(directory.join("preview.json"))
            .map_err(|_| AppError::bad("导入预览已过期或已提交，请重新选择文件夹"))?,
    )?;
    if pending.owner != user.id {
        return Err(AppError::forbidden());
    }
    if pending.expires < chrono::Utc::now().timestamp() {
        return Err(AppError::bad("导入预览已过期，请重新选择文件夹"));
    }
    let mut tx = begin(&s.pool, &user).await?;
    if directory.join("journal.json").exists() {
        return Err(AppError::conflict("上次导入需要恢复，请重启服务后重试"));
    }
    let existing = target(&mut tx, &pending.key).await?;
    if existing != pending.existing_project_id.zip(pending.revision) {
        return Err(AppError::conflict(
            "项目数据版本已变化，请重新选择文件夹并检查后导入",
        ));
    }
    if s.project_files.fingerprint(&pending.key).map_err(bad)? != pending.original_hash {
        return Err(AppError::conflict(
            "服务器项目文件已变化，请重新选择文件夹并检查后导入",
        ));
    }
    let stage = directory.join("stage");
    let uploaded = ProjectFiles::load_from(&stage).map_err(bad)?;
    if uploaded.fingerprint(&pending.key).map_err(bad)?.as_deref() != Some(&pending.uploaded_hash) {
        return Err(AppError::conflict("暂存文件已变化，请重新上传"));
    }
    let manifest = uploaded
        .manifest(&pending.key)
        .map_err(bad)?
        .ok_or(AppError::bad("缺少项目清单"))?;
    let payload = if let Some(path) = uploaded.dump_path(&pending.key).map_err(bad)? {
        Some(project_dump::decode(&path, &pending.key).await?)
    } else {
        None
    };
    let history_before = if let Some((pid, _)) = existing {
        topology::snapshot(&mut tx, pid, true).await?
    } else {
        json!({})
    };
    let (pid, summary) = apply(&mut tx, &user, &manifest, existing, payload.as_ref()).await?;
    db::touch(&mut tx, pid).await?;
    let history_after = topology::snapshot(&mut tx, pid, true).await?;
    crate::dsp_points::history(
        &mut tx,
        pid,
        user.id,
        "folder.import",
        &history_before,
        &history_after,
    )
    .await?;
    let revision: i32 = sqlx::query_scalar("SELECT revision FROM projects WHERE id=$1")
        .bind(pid)
        .fetch_one(&mut *tx)
        .await?;
    db::audit(&mut tx,user.id,Some(pid),"project.folder_import","project",None,
        Some(json!({"folder_import_token":pending.token,"key":pending.key,"replace_data":pending.replace_data,
            "sha256":pending.uploaded_hash,"summary":summary}))).await?;
    let journal = Journal {
        token: pending.token.clone(),
        key: pending.key.clone(),
        had_original: pending.original_hash.is_some(),
    };
    // Decoding and validating a Dump can take time; check SSH edits again just
    // before replacement, rather than relying only on the request's initial read.
    if s.project_files.fingerprint(&pending.key).map_err(bad)? != pending.original_hash {
        return Err(AppError::conflict(
            "检查期间服务器项目文件已变化，请重新上传并检查",
        ));
    }
    write_json(&directory.join("journal.json"), &journal)?;
    let destination = s.project_files.root().join(&pending.key);
    let install = (|| -> Result<()> {
        if journal.had_original {
            fs::rename(&destination, directory.join("backup")).map_err(io)?;
        }
        fs::rename(stage.join(&pending.key), &destination).map_err(io)?;
        sync_dir(&stage)?;
        sync_dir(s.project_files.root())?;
        sync_dir(&directory)?;
        Ok(())
    })();
    if let Err(error) = install {
        tx.rollback().await?;
        finish_recovery(s.project_files.root(), &directory, &journal, false).map_err(bad)?;
        return Err(error);
    }
    if let Err(error) = tx.commit().await {
        // A lost COMMIT response is ambiguous. The durable audit token is the
        // authority; acquire the same DB lock before deciding which folder wins.
        let mut check = begin(&s.pool, &user).await?;
        let committed = was_committed(&mut check, &journal.token).await?;
        finish_recovery(s.project_files.root(), &directory, &journal, committed).map_err(bad)?;
        check.rollback().await?;
        if !committed {
            return Err(error.into());
        }
    } else if let Err(error) = finish_recovery(s.project_files.root(), &directory, &journal, true) {
        // Data is committed. Retain journal for startup cleanup, never claim rollback.
        tracing::error!(%error,"committed folder import cleanup deferred until restart");
    }
    Ok(Json(
        json!({"project_id":pid,"key":pending.key,"revision":revision,"replace_data":pending.replace_data}),
    ))
}

async fn was_committed(tx: &mut Transaction<'_, Postgres>, token: &str) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM audit_logs WHERE action='project.folder_import' AND after_data->>'folder_import_token'=$1)")
        .bind(token).fetch_one(&mut **tx).await?)
}
fn finish_recovery(
    root: &Path,
    directory: &Path,
    journal: &Journal,
    committed: bool,
) -> anyhow::Result<()> {
    let destination = root.join(&journal.key);
    let backup = directory.join("backup");
    if !committed {
        if backup.exists() {
            if destination.exists() {
                fs::remove_dir_all(&destination)?;
            }
            fs::rename(&backup, &destination)?;
        } else if !journal.had_original
            && !directory.join("stage").join(&journal.key).exists()
            && destination.exists()
        {
            fs::remove_dir_all(&destination)?;
        }
    }
    fs::File::open(root)?.sync_all()?;
    fs::remove_dir_all(directory)?;
    Ok(())
}

/// Called before ProjectFiles::load: a crash between renames may temporarily
/// leave the project directory absent. Never resolve this with a blanket DB restore.
pub async fn recover(pool: &PgPool) -> anyhow::Result<()> {
    let root =
        PathBuf::from(std::env::var("PROJECT_CONFIG_DIR").unwrap_or_else(|_| "config".into()));
    let imports = root.join(".imports");
    if !imports.exists() {
        return Ok(());
    }
    let user: User = sqlx::query_as("SELECT id,username,display_name,is_admin FROM users WHERE active AND is_admin ORDER BY id LIMIT 1").fetch_one(pool).await?;
    let mut tx = begin(pool, &user).await.map_err(|e| anyhow::anyhow!(e.1))?;
    for entry in fs::read_dir(&imports)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !token_valid(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let directory = entry.path();
        let journal = directory.join("journal.json");
        if journal.exists() {
            let journal: Journal = serde_json::from_slice(&fs::read(journal)?)?;
            anyhow::ensure!(
                token_valid(&journal.token)
                    && !journal.key.is_empty()
                    && journal.key.bytes().all(|c| c.is_ascii_lowercase()
                        || c.is_ascii_digit()
                        || c == b'_'
                        || c == b'-'),
                "invalid folder import journal"
            );
            let committed = was_committed(&mut tx, &journal.token)
                .await
                .map_err(|e| anyhow::anyhow!(e.1))?;
            finish_recovery(&root, &directory, &journal, committed)?;
        } else if let Ok(bytes) = fs::read(directory.join("preview.json")) {
            let pending: Pending = serde_json::from_slice(&bytes)?;
            if pending.expires < chrono::Utc::now().timestamp() {
                fs::remove_dir_all(directory)?;
            }
        } else {
            // This server owns the import area; incomplete uploads from a prior
            // process never became reviewable and have no database side effects.
            fs::remove_dir_all(directory)?;
        }
    }
    tx.rollback().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_upload_paths() {
        for path in [
            "project.json",
            "/a/project.json",
            "a/../project.json",
            "a/.env",
            "a/x\\y.json",
            "a//x.json",
            "a/C:/x.json",
            "a/./x.json",
        ] {
            assert!(upload_path(path).is_err(), "{path}");
        }
        assert!(upload_path("项目副本/DSP/process.json").is_ok());
    }
    #[test]
    fn restores_original_folder_after_uncommitted_install() {
        let root = std::env::temp_dir().join(format!("folder-journal-{}", rand::random::<u64>()));
        let pending = root.join(".imports/token");
        fs::create_dir_all(pending.join("backup")).unwrap();
        fs::create_dir_all(root.join("example")).unwrap();
        fs::write(pending.join("backup/old"), "old").unwrap();
        fs::write(root.join("example/new"), "new").unwrap();
        finish_recovery(
            &root,
            &pending,
            &Journal {
                token: "token".into(),
                key: "example".into(),
                had_original: true,
            },
            false,
        )
        .unwrap();
        assert!(root.join("example/old").exists());
        assert!(!root.join("example/new").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recovery_distinguishes_committed_and_not_yet_installed_folders() {
        for (committed, had_original, installed) in [
            (true, true, true),
            (true, false, true),
            (false, true, false),
            (false, false, true),
            (false, false, false),
        ] {
            let root = std::env::temp_dir().join(format!("folder-phase-{}", rand::random::<u64>()));
            let pending = root.join(".imports/token");
            fs::create_dir_all(pending.join("stage")).unwrap();
            if had_original {
                let original = if installed {
                    pending.join("backup")
                } else {
                    root.join("example")
                };
                fs::create_dir_all(&original).unwrap();
                fs::write(original.join("old"), "old").unwrap();
            }
            let proposed = if installed {
                root.join("example")
            } else {
                pending.join("stage/example")
            };
            fs::create_dir_all(&proposed).unwrap();
            fs::write(proposed.join("new"), "new").unwrap();
            finish_recovery(
                &root,
                &pending,
                &Journal {
                    token: "token".into(),
                    key: "example".into(),
                    had_original,
                },
                committed,
            )
            .unwrap();
            assert_eq!(root.join("example/new").exists(), committed);
            assert_eq!(
                root.join("example/old").exists(),
                !committed && had_original
            );
            assert!(!pending.exists());
            fs::remove_dir_all(root).unwrap();
        }
    }
}
