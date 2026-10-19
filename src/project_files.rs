//! Self-contained project folders. Loading never writes to the database.
use crate::{auth::User, db, error::AppError, point_tables, project_config};
use anyhow::{Context, Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    key: String,
    name: String,
    #[serde(default)]
    description: String,
    topology: Value,
    workspace: Value,
    // Project-relative source file, imported only by the explicit creation command.
    #[serde(skip_serializing_if = "Option::is_none")]
    workbook: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    workbook_boards: Vec<String>,
    // Optional portable, project-scoped PostgreSQL archive.
    #[serde(skip_serializing_if = "Option::is_none")]
    dump: Option<String>,
}

struct ProjectFile {
    manifest: Manifest,
    directory: PathBuf,
    point_tables: Value,
    dump: Option<PathBuf>,
}

pub struct ProjectFiles {
    root: PathBuf,
}

fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(
        &std::fs::read(path).with_context(|| format!("读取 {}", path.display()))?,
    )
    .with_context(|| format!("解析 {}", path.display()))
}

fn contained_path(path: &Path, project: &Path, directory: bool) -> Result<()> {
    let resolved = path
        .canonicalize()
        .with_context(|| format!("解析项目配置路径 {}", path.display()))?;
    ensure!(
        resolved.starts_with(project),
        "{}: 配置路径不能越出所属项目目录",
        path.display()
    );
    ensure!(
        if directory {
            resolved.is_dir()
        } else {
            resolved.is_file()
        },
        "{}: 配置须为{}",
        path.display(),
        if directory { "目录" } else { "普通文件" }
    );
    Ok(())
}

fn project_relative_reference(
    project: &Path,
    relative: &str,
    property: &str,
) -> Result<std::path::PathBuf> {
    let path = Path::new(relative);
    ensure!(
        !relative.trim().is_empty()
            && path
                .components()
                .all(|part| matches!(part, Component::Normal(_) | Component::CurDir)),
        "{}: {property} 必须为项目内的相对路径，不能包含 .. 或绝对路径",
        project.join("project.json").display(),
    );
    Ok(project.join(path))
}

fn project_relative_path(
    project: &Path,
    relative: &str,
    property: &str,
    directory: bool,
) -> Result<std::path::PathBuf> {
    let path = project_relative_reference(project, relative, property)?;
    contained_path(&path, &project.canonicalize()?, directory)?;
    Ok(path)
}

fn workbook_path(project: &Path, relative: &str) -> Result<std::path::PathBuf> {
    project_relative_path(project, relative, "workbook", false)
}

fn validate_key(key: &str) -> Result<()> {
    ensure!(
        !key.is_empty()
            && key.len() <= 64
            && key.as_bytes()[0].is_ascii_lowercase()
            && key
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_-".contains(&c)),
        "项目 key 使用小写字母开头的字母、数字、_、-（最多 64 字节）"
    );
    Ok(())
}

fn find_dump(project: &Path, explicit: Option<&str>) -> Result<Option<PathBuf>> {
    let explicit = explicit
        .map(|relative| project_relative_path(project, relative, "dump", false))
        .transpose()?;
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(project)? {
        let path = entry?.path();
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dump"))
        {
            contained_path(&path, &project.canonicalize()?, false)?;
            candidates.push(path);
        }
    }
    if let Some(path) = explicit {
        let canonical = path.canonicalize()?;
        ensure!(
            candidates
                .iter()
                .all(|candidate| candidate.canonicalize().is_ok_and(|p| p == canonical)),
            "{}: 多个 Dump 文件，请只保留要导入的一个归档",
            project.display()
        );
        Ok(Some(path))
    } else {
        ensure!(
            candidates.len() <= 1,
            "{}: 多个 Dump 文件，请只保留要导入的一个归档",
            project.display()
        );
        Ok(candidates.pop())
    }
}

fn hash_folder(path: &Path, project: &Path, hash: &mut Sha256) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("读取项目文件 {}", path.display()))?;
    ensure!(
        !metadata.file_type().is_symlink() && (metadata.is_file() || metadata.is_dir()),
        "{}: 导入项目只支持普通文件和目录，不能包含符号链接或特殊文件",
        path.display()
    );
    let relative_path = path.strip_prefix(project)?;
    ensure!(
        relative_path.components().count() <= 64,
        "项目目录最多嵌套 64 层"
    );
    let relative = relative_path.to_str().context("项目文件路径必须为 UTF-8")?;
    hash.update((relative.len() as u64).to_be_bytes());
    hash.update(relative.as_bytes());
    if metadata.is_dir() {
        hash.update(b"directory");
        let mut entries = std::fs::read_dir(path)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort();
        for entry in entries {
            hash_folder(&entry, project, hash)?;
        }
    } else {
        hash.update(b"file");
        hash.update(metadata.len().to_be_bytes());
        let mut file = std::fs::File::open(path)?;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
    }
    Ok(())
}

fn enable_table(tables: &mut Vec<Value>, kind: &str, enabled: bool) {
    let position = tables.iter().position(|value| value == kind);
    if !enabled {
        if let Some(position) = position {
            tables.remove(position);
        }
        return;
    }
    if position.is_some() {
        return;
    }
    let kinds = ["process", "collect", "forward"];
    let rank = kinds.iter().position(|value| *value == kind).unwrap();
    let position = tables.iter().position(|value| {
        value
            .as_str()
            .and_then(|value| kinds.iter().position(|kind| *kind == value))
            .is_none_or(|existing| existing > rank)
    });
    tables.insert(position.unwrap_or(tables.len()), json!(kind));
}

fn workspace_kind<'a>(kind: &'a str, path: &Path) -> Result<&'a str> {
    match kind {
        "transmit" => Ok("forward"),
        "process" | "collect" | "fields" | "data" | "routes" | "expansion" | "links"
        | "endpoints" | "contexts" | "groups" => Ok(kind),
        _ => Err(anyhow!(
            "{}: 未知 workspace 表格标识 {kind}；转发表使用 transmit",
            path.display()
        )),
    }
}

fn load_table_directory(project_path: &Path, manifest: &Manifest) -> Result<Value> {
    let project = project_path.canonicalize()?;
    let manifest_path = project_path.join("project.json");
    let codes: BTreeSet<_> = manifest.topology["board_types"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|board| board["code"].as_str())
        .collect();
    let workspace = manifest
        .workspace
        .as_object()
        .with_context(|| format!("{}: workspace 必须为对象", manifest_path.display()))?;
    ensure!(
        workspace.keys().all(|key| key == "boards"),
        "{}: workspace 只支持 boards",
        manifest_path.display()
    );
    let board_workspace = manifest.workspace["boards"]
        .as_object()
        .with_context(|| format!("{}: workspace.boards 必须为对象", manifest_path.display()))?;
    ensure!(
        board_workspace
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>()
            == codes,
        "{}: workspace.boards 必须完整对应 topology.board_types[].code",
        manifest_path.display()
    );
    let mut directories = BTreeMap::new();
    let mut seen_directories = BTreeSet::new();
    for board in manifest.topology["board_types"].as_array().unwrap() {
        let code = board["code"].as_str().unwrap();
        let directory = board["directory"].as_str().with_context(|| {
            format!(
                "{}: 板卡 {code} 必须显式指定 directory",
                manifest_path.display()
            )
        })?;
        let path = project_relative_path(
            project_path,
            directory,
            &format!("板卡 {code} directory"),
            true,
        )?;
        ensure!(
            seen_directories.insert(path.canonicalize()?),
            "{}: 多个板卡不能绑定同一目录 {}",
            manifest_path.display(),
            path.display()
        );
        directories.insert(code, path);
    }
    let mut result = json!({"version":1,"boards":{},"workspace":{"boards":{}}});
    for code in codes {
        let board_path = &directories[code];
        let workspace = board_workspace[code].as_object().with_context(|| {
            format!(
                "{}: workspace.boards.{code} 必须为对象",
                manifest_path.display()
            )
        })?;
        ensure!(
            workspace
                .keys()
                .all(|key| matches!(key.as_str(), "tables" | "labels")),
            "{}: workspace.boards.{code} 只支持 tables 和 labels",
            manifest_path.display()
        );
        let table_list = workspace
            .get("tables")
            .and_then(Value::as_array)
            .with_context(|| {
                format!(
                    "{}: workspace.boards.{code}.tables 必须为数组",
                    manifest_path.display()
                )
            })?;
        let mut tables = Vec::new();
        let mut seen = BTreeSet::new();
        for table in table_list {
            let kind = table
                .as_str()
                .with_context(|| format!("{}: 表格标识必须为字符串", manifest_path.display()))?;
            let kind = workspace_kind(kind, &manifest_path)?;
            ensure!(
                seen.insert(kind),
                "{}: workspace.boards.{code} 重复表格 {kind}",
                manifest_path.display()
            );
            tables.push(json!(kind));
        }
        let mut labels = json!({});
        if let Some(value) = workspace.get("labels") {
            let object = value.as_object().with_context(|| {
                format!(
                    "{}: workspace.boards.{code}.labels 必须为对象",
                    manifest_path.display()
                )
            })?;
            for (kind, label) in object {
                let kind = workspace_kind(kind, &manifest_path)?;
                ensure!(
                    label.as_str().is_some_and(|s| !s.trim().is_empty()),
                    "{}: workspace.boards.{code}.labels.{kind} 必须为非空字符串",
                    manifest_path.display()
                );
                labels[kind] = label.clone();
            }
        }
        for entry in std::fs::read_dir(&board_path)
            .with_context(|| format!("读取 {}", board_path.display()))?
        {
            let path = entry?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            ensure!(
                matches!(
                    path.file_name().and_then(|name| name.to_str()),
                    Some("process.json" | "collect.json" | "transmit.json")
                ),
                "{}: 未知点表文件名，只支持 process.json、collect.json、transmit.json",
                path.display()
            );
        }
        for (filename, kind) in [
            ("process", "process"),
            ("collect", "collect"),
            ("transmit", "forward"),
        ] {
            let path = board_path.join(format!("{filename}.json"));
            contained_path(&path, &project, false)?;
            let mut value = read_json(&path)?;
            let object = value
                .as_object_mut()
                .with_context(|| format!("{}: 表格配置须为对象", path.display()))?;
            const REQUIRED: [&str; 9] = [
                "version",
                "enabled",
                "label",
                "description",
                "columns",
                "editor",
                "ordering",
                "inline",
                "fields",
            ];
            // All nine business/metadata properties are explicit; no global defaults are read.
            ensure!(
                object.keys().all(|key| REQUIRED.contains(&key.as_str()))
                    && REQUIRED.iter().all(|key| object.contains_key(*key)),
                "{}: 表格须完整包含 version、enabled、label、description、columns、editor、ordering、inline、fields，且不能包含其他属性",
                path.display()
            );
            ensure!(
                object.remove("version") == Some(json!(1)),
                "{}: version 必须为 1",
                path.display()
            );
            let enabled = object
                .remove("enabled")
                .and_then(|value| value.as_bool())
                .with_context(|| format!("{}: enabled 必须为布尔值", path.display()))?;
            point_tables::validate_table_file(kind, &value)
                .map_err(|error| anyhow!("{}: {}", path.display(), error.1))?;
            enable_table(&mut tables, kind, enabled);
            labels[kind] = value["label"].clone();
            result["boards"][code][kind] = value;
        }
        result["workspace"]["boards"][code] = json!({"tables":tables,"labels":labels});
    }
    point_tables::validate_definition(&result)
        .map_err(|error| anyhow!("{}: {}", project_path.display(), error.1))?;
    Ok(result)
}

impl ProjectFiles {
    pub fn load() -> Result<Self> {
        let directory = std::env::var("PROJECT_CONFIG_DIR").unwrap_or_else(|_| "config".into());
        Self::load_from(Path::new(&directory))
    }

    pub(crate) fn load_from(directory: &Path) -> Result<Self> {
        let root = directory
            .canonicalize()
            .with_context(|| format!("读取项目配置目录 {}", directory.display()))?;
        ensure!(root.is_dir(), "项目配置根路径须为目录");
        let files = Self { root };
        // Fail early on invalid configuration, but do not keep a stale startup copy.
        files.projects()?;
        Ok(files)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn projects(&self) -> Result<BTreeMap<String, ProjectFile>> {
        let mut projects = BTreeMap::new();
        for entry in std::fs::read_dir(&self.root)
            .with_context(|| format!("读取项目配置目录 {}", self.root.display()))?
        {
            let path = entry?.path();
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with('.'))
                || !path.is_dir()
            {
                continue;
            }
            let key = path
                .file_name()
                .and_then(|name| name.to_str())
                .context("项目配置目录名必须为 UTF-8")?;
            projects.insert(key.to_owned(), self.project(key)?);
        }
        Ok(projects)
    }

    fn project(&self, key: &str) -> Result<ProjectFile> {
        validate_key(key)?;
        let path = self.root.join(key);
        ensure!(
            path.exists(),
            "未找到项目配置目录 {key}，请检查 PROJECT_CONFIG_DIR"
        );
        contained_path(&path, &self.root, true)?;
        let file = path.join("project.json");
        contained_path(&file, &path.canonicalize()?, false)?;
        let mut manifest: Manifest = serde_json::from_value(read_json(&file)?)
            .with_context(|| format!("项目清单格式错误 {}", file.display()))?;
        ensure!(
            manifest.version == 1 && manifest.key == key,
            "{}: version 必须为 1；key 必须与目录名相同",
            file.display()
        );
        manifest.name = manifest.name.trim().to_owned();
        ensure!(
            !manifest.name.is_empty() && manifest.name.chars().count() <= 120,
            "{}: 项目名称须为 1～120 字符",
            file.display()
        );
        manifest.topology = serde_json::to_value(
            project_config::Config::parse(manifest.topology)
                .map_err(|error| anyhow!("{}: {}", file.display(), error.1))?,
        )?;
        if !manifest.workbook_boards.is_empty() {
            ensure!(
                manifest.workbook_boards == ["DSP"]
                    && manifest.topology["board_types"]
                        .as_array()
                        .is_some_and(|types| types.iter().any(|t| t["code"] == "DSP"
                            && t["model_code"] == "DSP"
                            && t["point_storage"] == "native")),
                "workbook_boards 当前只支持已配置 native 存储的 DSP 板卡"
            );
        }
        if manifest.workbook.is_some()
            && manifest.topology["board_types"]
                .as_array()
                .is_some_and(|types| {
                    types
                        .iter()
                        .any(|t| t["model_code"] == "DSP" && t["point_storage"] == "native")
                })
        {
            ensure!(
                manifest.workbook_boards == ["DSP"],
                "原生 DSP 工作簿必须配置 workbook_boards: [\"DSP\"]，避免导入其他板卡的旧格式数据"
            );
        }
        if let Some(workbook) = &manifest.workbook {
            workbook_path(&path, workbook)?;
        }
        let dump = find_dump(&path, manifest.dump.as_deref())?;
        let point_tables = load_table_directory(&path, &manifest)?;
        Ok(ProjectFile {
            manifest,
            directory: path,
            point_tables,
            dump,
        })
    }

    pub fn definition(&self, key: Option<&str>) -> Result<Value> {
        let key = key.context("项目没有关联配置目录，请先选择项目配置")?;
        Ok(self.project(key)?.point_tables)
    }

    pub fn catalog(&self) -> Result<Value> {
        Ok(json!(self.projects()?.values().map(|project| {
            let manifest = &project.manifest;
            json!({"key":manifest.key,"name":manifest.name,"description":manifest.description,"topology":manifest.topology})
        }).collect::<Vec<_>>()))
    }

    pub fn manifest(&self, key: &str) -> Result<Option<Value>> {
        validate_key(key)?;
        if !self.root.join(key).try_exists()? {
            return Ok(None);
        }
        Ok(Some(serde_json::to_value(self.project(key)?.manifest)?))
    }

    /// Read server-edited topology and table definitions on every request.
    pub fn topology_source(&self, key: &str) -> Result<Value> {
        let normalized = self.project(key)?.manifest.topology;
        let sha256 = hex::encode(Sha256::digest(serde_json::to_vec(&normalized)?));
        Ok(json!({"key":key,"config":normalized,"sha256":sha256}))
    }

    pub(crate) fn dump_path(&self, key: &str) -> Result<Option<PathBuf>> {
        Ok(self.project(key)?.dump)
    }

    /// Hash the complete folder so a preview cannot overwrite subsequent SSH edits.
    /// Symlinks are rejected to keep this snapshot unambiguous and confined to one folder.
    pub(crate) fn fingerprint(&self, key: &str) -> Result<Option<String>> {
        validate_key(key)?;
        let path = self.root.join(key);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let mut hash = Sha256::new();
        hash_folder(&path, &path, &mut hash)?;
        Ok(Some(hex::encode(hash.finalize())))
    }

    /// Import the optional source into a newly inserted project using its creation transaction.
    pub(crate) async fn import_source(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        pid: i64,
        key: &str,
        user: &User,
    ) -> crate::error::Result<Value> {
        let project = self
            .project(key)
            .map_err(|error| AppError::bad(format!("{error:#}")))?;
        if let Some(path) = project.dump {
            let payload = crate::project_dump::decode(&path, key).await?;
            let before = crate::topology::snapshot(tx, pid, true).await?;
            let restored = crate::project_dump::replace(tx, pid, &payload).await?;
            project_config::apply(tx, pid, &project.manifest.topology).await?;
            let graph = crate::topology::snapshot(tx, pid, true).await?;
            let report = crate::topology_validation::validate(&graph);
            if report["errors"].as_u64().unwrap_or(0) != 0 {
                return Err(AppError::bad("项目 Dump 数据校验失败，未创建项目"));
            }
            crate::dsp_points::history(tx, pid, user.id, "project.dump.import", &before, &graph)
                .await?;
            let bytes = std::fs::read(&path).map_err(|_| AppError::bad("读取项目 Dump 失败"))?;
            let hash = hex::encode(Sha256::digest(bytes));
            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("project.dump");
            sqlx::query("INSERT INTO imports(project_id,filename,sha256,report,created_by) VALUES($1,$2,$3,$4,$5)")
                .bind(pid).bind(filename).bind(&hash).bind(&report).bind(user.id)
                .execute(&mut **tx).await?;
            return Ok(
                json!({"filename":filename,"sha256":hash,"validation":report,"restored":restored}),
            );
        }
        let Some(workbook) = &project.manifest.workbook else {
            return Ok(Value::Null);
        };
        let path = workbook_path(&project.directory, workbook)
            .map_err(|error| AppError::bad(format!("{error:#}")))?;
        let bytes = std::fs::read(&path)
            .map_err(|error| AppError::bad(format!("读取工作簿 {}: {error}", path.display())))?;
        if bytes.len() > 15 * 1024 * 1024 {
            return Err(AppError::bad("工作簿不能超过 15 MiB"));
        }
        let hash = hex::encode(Sha256::digest(&bytes));
        if !project.manifest.workbook_boards.is_empty() {
            if project.manifest.workbook_boards != ["DSP"] {
                return Err(AppError::bad(
                    "当前定向工作簿导入仅支持 workbook_boards: [\"DSP\"]",
                ));
            }
            let data =
                tokio::task::spawn_blocking(move || crate::dsp_workbook::parse_workbook(bytes))
                    .await
                    .map_err(|_| AppError::bad("DSP 工作簿解析失败"))??;
            let before = crate::topology::snapshot(tx, pid, true).await?;
            crate::dsp_points::import(tx, pid, &data).await?;
            let after = crate::topology::snapshot(tx, pid, true).await?;
            let report = crate::topology_validation::validate(&after);
            if report["errors"].as_u64().unwrap_or(0) != 0 {
                let mut error = AppError::bad("DSP 点表校验失败，项目未创建");
                error.2 = Some(json!({"validation":report}));
                return Err(error);
            }
            crate::dsp_points::history(tx, pid, user.id, "workbook.import", &before, &after)
                .await?;
            let filename = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("points.xlsx");
            sqlx::query("INSERT INTO imports(project_id,filename,sha256,report,created_by) VALUES($1,$2,$3,$4,$5)")
                .bind(pid).bind(filename).bind(&hash).bind(&report).bind(user.id).execute(&mut **tx).await?;
            return Ok(
                json!({"filename":filename,"sha256":hash,"boards":["DSP"],"process_count":data.process.len(),"transmit_count":data.transmit.len(),"validation":report}),
            );
        }
        Err(AppError::bad(
            "工作簿导入仅支持 workbook_boards: [\"DSP\"]；其他板卡暂未启用点表",
        ))
    }

    pub async fn create(&self, pool: &PgPool, key: &str) -> Result<()> {
        let project = self.project(key)?;
        let m = &project.manifest;
        let username = std::env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".into());
        let user: User = sqlx::query_as(
            "SELECT id,username,display_name,is_admin FROM users WHERE username=$1 AND is_admin AND active",
        ).bind(username).fetch_optional(pool).await?
            .context("ADMIN_USERNAME 必须对应一个启用的管理员账号")?;
        let mut tx = db::context(pool, &user, None, true)
            .await
            .map_err(|e| anyhow!(e.1))?;
        // Serialize concurrent creation commands, preserving unique directory bindings.
        sqlx::query("SELECT pg_advisory_xact_lock(192837465, 1)")
            .execute(&mut *tx)
            .await?;
        let existing: Option<i64> =
            sqlx::query_scalar("SELECT id FROM projects WHERE config_key=$1")
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(pid) = existing {
            tx.commit().await?;
            println!("项目 {key} 已存在（ID {pid}），未覆盖任何数据。");
            return Ok(());
        }
        let same_name: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE name=$1)")
                .bind(&m.name)
                .fetch_one(&mut *tx)
                .await?;
        ensure!(
            !same_name,
            "已存在名为「{}」的项目，未重复创建。请在网页查看已有项目，或为新项目配置不同的名称。",
            m.name
        );
        let pid: i64 = sqlx::query_scalar(
            "INSERT INTO projects(name,description,config_key) VALUES($1,$2,$3) RETURNING id",
        )
        .bind(&m.name)
        .bind(&m.description)
        .bind(key)
        .fetch_one(&mut *tx)
        .await?;
        project_config::apply(&mut tx, pid, &m.topology)
            .await
            .map_err(|e| anyhow!(e.1))?;
        let imported = self
            .import_source(&mut tx, pid, key, &user)
            .await
            .map_err(|error| anyhow!(error.1))?;
        db::audit(&mut tx, user.id, Some(pid), "project.create", "project", None,
            Some(json!({"id":pid,"config_key":key,"name":m.name,"topology":m.topology,"import":imported})))
            .await.map_err(|e| anyhow!(e.1))?;
        tx.commit().await?;
        println!(
            "已创建项目「{}」（ID {pid}）。登录后在项目列表中选择；成员权限需在网页中分配。",
            m.name
        );
        if !imported.is_null() {
            println!(
                "已导入项目数据：{}；校验错误 {} 条、提示 {} 条，请在校验中心处理。",
                imported["filename"].as_str().unwrap_or_default(),
                imported["validation"]["errors"],
                imported["validation"]["warnings"]
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let fixture = Self(std::env::temp_dir().join(format!(
                "protocol-project-files-{}-{timestamp}-{id}",
                std::process::id()
            )));
            std::fs::create_dir_all(&fixture.0).unwrap();
            fixture
        }

        fn write(&self, relative: &str, value: &Value) {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
        }

        fn read(&self, relative: &str) -> Value {
            read_json(&self.0.join(relative)).unwrap()
        }

        fn project(&self, key: &str, label: &str) {
            self.write(&format!("{key}/project.json"), &json!({
                "version":1,"key":key,"name":label,"description":"测试项目",
                "topology":{"version":2,"board_types":[{"code":"DSP","name":"DSP","model_code":"DSP_TEMPLATE","directory":"DSP"}],"root":{"type":"DSP","quantity":1},"mounts":[]},
                "workspace":{"boards":{"DSP":{"tables":["process","collect","transmit","fields"],"labels":{"fields":"协议字段","process":"旧页签标题"}}}}
            }));
            for kind in ["process", "collect", "transmit"] {
                let field = if kind == "process" {
                    "name"
                } else {
                    "signal_id"
                };
                self.write(&format!("{key}/DSP/{kind}.json"), &json!({
                    "version":1,"enabled":true,"label":format!("{label} {kind}"),"description":"",
                    "columns":[field],"editor":[field],"ordering":{"mode":"disabled","group_by":[]},
                    "inline":{},"fields":{(field):{"label":label,"type":"text"}}
                }));
            }
        }

        fn load(&self) -> Result<ProjectFiles> {
            ProjectFiles::load_from(&self.0)
        }

        fn error(&self) -> String {
            match self.load() {
                Ok(_) => panic!("invalid project unexpectedly loaded"),
                Err(error) => format!("{error:#}"),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn project_folders_are_independent_and_have_no_fallback() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        fixture.project("beta", "乙项目");
        // These obsolete files are not loaded or merged.
        fixture.write("point-tables.json", &json!({"version":999}));
        fixture.write("alpha/point-tables.json", &json!({"version":999}));
        fixture.write(".hidden/note.json", &json!({}));
        let files = fixture.load().unwrap();
        assert_eq!(
            files.definition(Some("alpha")).unwrap()["boards"]["DSP"]["process"]["fields"]["name"]
                ["label"],
            "甲项目"
        );
        assert_eq!(
            files.definition(Some("beta")).unwrap()["boards"]["DSP"]["process"]["fields"]["name"]["label"],
            "乙项目"
        );
        assert!(files.definition(None).is_err());
        assert!(files.definition(Some("missing")).is_err());
        assert!(files.manifest("missing").unwrap().is_none());
        assert_eq!(files.manifest("alpha").unwrap().unwrap()["name"], "甲项目");
        assert_eq!(files.catalog().unwrap().as_array().unwrap().len(), 2);
        let config = files.definition(Some("alpha")).unwrap();
        assert!(config.get("fields").is_none());
        assert!(config["boards"]["DSP"].get("transmit").is_none());
        assert_eq!(
            config["boards"]["DSP"]["forward"]["label"],
            "甲项目 transmit"
        );
        assert_eq!(
            config["workspace"]["boards"]["DSP"]["labels"]["process"],
            "甲项目 process"
        );
        assert_eq!(
            config["workspace"]["boards"]["DSP"]["labels"]["fields"],
            "协议字段"
        );
    }

    #[test]
    fn topology_source_and_manifest_read_server_mount_changes_live() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let mut manifest = fixture.read("alpha/project.json");
        manifest["topology"]["board_types"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "code":"UPM","name":"UPM","model_code":"UPM_ARM","directory":"UPM"
            }));
        manifest["topology"]["mounts"] =
            json!([{"parent":"DSP","child":"UPM","quantity":1,"connections":[]}]);
        manifest["workspace"]["boards"]["UPM"] = json!({"tables":["process","collect","transmit"]});
        for filename in ["process", "collect", "transmit"] {
            fixture.write(
                &format!("alpha/UPM/{filename}.json"),
                &fixture.read(&format!("alpha/DSP/{filename}.json")),
            );
        }
        fixture.write("alpha/project.json", &manifest);
        let files = fixture.load().unwrap();
        let before = files.topology_source("alpha").unwrap();
        manifest["topology"]["mounts"][0]["quantity"] = json!(4);
        fixture.write("alpha/project.json", &manifest);
        let after = files.topology_source("alpha").unwrap();
        assert_eq!(after["config"]["mounts"][0]["quantity"], 4);
        assert_ne!(before["sha256"], after["sha256"]);
        assert_eq!(
            files.manifest("alpha").unwrap().unwrap()["topology"]["mounts"][0]["quantity"],
            4
        );
        assert!(files.definition(Some("alpha")).unwrap()["boards"]["UPM"].is_object());
    }

    #[test]
    fn live_reload_validates_new_boards_tables_and_project_identity() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let files = fixture.load().unwrap();
        let original = fixture.read("alpha/project.json");
        let mut manifest = original.clone();
        manifest["topology"]["board_types"][0]["model_code"] = json!("NEW_MODEL");
        fixture.write("alpha/project.json", &manifest);
        assert_eq!(
            files.topology_source("alpha").unwrap()["config"]["board_types"][0]["model_code"],
            "NEW_MODEL"
        );
        manifest["topology"]["board_types"][0]["directory"] = json!("new-directory");
        fixture.write("alpha/project.json", &manifest);
        assert!(files.topology_source("alpha").is_err());
        std::fs::rename(
            fixture.0.join("alpha/DSP"),
            fixture.0.join("alpha/new-directory"),
        )
        .unwrap();
        assert!(files.topology_source("alpha").is_ok());
        let mut table = fixture.read("alpha/new-directory/process.json");
        table["label"] = json!("立即生效的标题");
        fixture.write("alpha/new-directory/process.json", &table);
        assert_eq!(
            files.definition(Some("alpha")).unwrap()["boards"]["DSP"]["process"]["label"],
            "立即生效的标题"
        );
        for (field, replacement) in [("key", json!("beta")), ("version", json!(2))] {
            let mut invalid = manifest.clone();
            invalid[field] = replacement;
            fixture.write("alpha/project.json", &invalid);
            assert!(
                files
                    .topology_source("alpha")
                    .unwrap_err()
                    .to_string()
                    .contains("version 必须为 1；key 必须与目录名相同")
            );
        }
        fixture.write("alpha/project.json", &manifest);
        fixture.project("beta", "乙项目");
        assert_eq!(files.catalog().unwrap().as_array().unwrap().len(), 2);
        assert_eq!(files.manifest("beta").unwrap().unwrap()["name"], "乙项目");
        assert!(files.topology_source("unknown").is_err());
    }

    #[test]
    fn topology_source_hash_tracks_normalized_topology_only() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let files = fixture.load().unwrap();
        let first = files.topology_source("alpha").unwrap();
        assert_eq!(first, files.topology_source("alpha").unwrap());
        let mut manifest = fixture.read("alpha/project.json");
        manifest["description"] = json!("只调整说明与 JSON 排版");
        std::fs::write(
            fixture.0.join("alpha/project.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(first, files.topology_source("alpha").unwrap());
        assert_eq!(first["sha256"].as_str().unwrap().len(), 64);
        assert_eq!(first["key"], "alpha");
    }

    #[test]
    fn native_dsp_workbook_requires_explicit_board_selection() {
        let fixture = Fixture::new();
        fixture.project("alpha", "原生 DSP");
        let mut manifest = fixture.read("alpha/project.json");
        manifest["topology"]["board_types"][0]["model_code"] = json!("DSP");
        manifest["topology"]["board_types"][0]["point_storage"] = json!("native");
        manifest["topology"]["board_types"][0]["point_groups"] =
            json!([{"code":"LOCAL","name":"本地内部数据"}]);
        fixture.write("alpha/project.json", &manifest);
        // Empty native projects do not require an Excel import selector.
        assert!(fixture.load().is_ok());

        manifest["workbook"] = json!("source.xlsx");
        // Configuration loading checks paths; it does not parse workbook bytes.
        std::fs::write(fixture.0.join("alpha/source.xlsx"), b"source fixture").unwrap();
        fixture.write("alpha/project.json", &manifest);
        assert!(
            fixture
                .error()
                .contains("原生 DSP 工作簿必须配置 workbook_boards")
        );

        manifest["workbook_boards"] = json!([]);
        fixture.write("alpha/project.json", &manifest);
        assert!(
            fixture
                .error()
                .contains("原生 DSP 工作簿必须配置 workbook_boards")
        );

        manifest["workbook_boards"] = json!(["DSP"]);
        fixture.write("alpha/project.json", &manifest);
        let files = fixture.load().unwrap();
        let loaded = files.manifest("alpha").unwrap().unwrap();
        assert_eq!(loaded["workbook_boards"], json!(["DSP"]));
        assert_eq!(loaded["workbook"], "source.xlsx");
    }

    #[test]
    fn workbook_board_selector_rejects_unsupported_lists_and_legacy_dsp() {
        let fixture = Fixture::new();
        fixture.project("alpha", "原生 DSP");
        let mut manifest = fixture.read("alpha/project.json");
        manifest["topology"]["board_types"][0]["model_code"] = json!("DSP");
        manifest["topology"]["board_types"][0]["point_storage"] = json!("native");
        manifest["topology"]["board_types"][0]["point_groups"] =
            json!([{"code":"LOCAL","name":"本地内部数据"}]);
        manifest["workbook"] = json!("source.xlsx");
        std::fs::write(fixture.0.join("alpha/source.xlsx"), b"source fixture").unwrap();
        for selection in [json!(["UPM"]), json!(["DSP", "UPM"]), json!(["DSP", "DSP"])] {
            manifest["workbook_boards"] = selection;
            fixture.write("alpha/project.json", &manifest);
            assert!(fixture.error().contains("workbook_boards 当前只支持"));
        }
        manifest["workbook_boards"] = json!(["DSP"]);
        let board = manifest["topology"]["board_types"][0]
            .as_object_mut()
            .unwrap();
        board.remove("point_storage");
        board.remove("point_groups");
        fixture.write("alpha/project.json", &manifest);
        assert!(
            fixture
                .error()
                .contains("workbook_boards 当前只支持已配置 native")
        );
    }

    #[test]
    fn every_project_board_and_table_requires_its_own_file() {
        for missing in [
            "project.json",
            "DSP/process.json",
            "DSP/collect.json",
            "DSP/transmit.json",
        ] {
            let fixture = Fixture::new();
            fixture.project("alpha", "甲项目");
            std::fs::remove_file(fixture.0.join("alpha").join(missing)).unwrap();
            assert!(fixture.error().contains(missing));
        }
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let mut manifest = fixture.read("alpha/project.json");
        manifest["topology"]["board_types"]
            .as_array_mut()
            .unwrap()
            .push(json!({"code":"UPM","name":"UPM","model_code":"UPM_ARM","directory":"UPM"}));
        manifest["topology"]["mounts"] =
            json!([{"parent":"DSP","child":"UPM","quantity":1,"connections":[]}]);
        manifest["workspace"]["boards"]["UPM"] = json!({"tables":["process"]});
        fixture.write("alpha/project.json", &manifest);
        assert!(fixture.error().contains("/UPM"));
    }

    #[test]
    fn manifest_selects_nested_directories_independently_of_board_codes() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        std::fs::create_dir_all(fixture.0.join("alpha/boards")).unwrap();
        std::fs::rename(
            fixture.0.join("alpha/DSP"),
            fixture.0.join("alpha/boards/power"),
        )
        .unwrap();
        let mut manifest = fixture.read("alpha/project.json");
        manifest["topology"]["board_types"][0]["directory"] = json!("boards/power");
        manifest["topology"]["board_types"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({"code":"UPM","name":"UPM","model_code":"UPM_ARM","directory":"controller"}),
            );
        manifest["topology"]["mounts"] =
            json!([{"parent":"DSP","child":"UPM","quantity":1,"connections":[]}]);
        manifest["workspace"]["boards"]["UPM"] = json!({"tables":["process","collect","transmit"]});
        fixture.write("alpha/project.json", &manifest);
        for filename in ["process", "collect", "transmit"] {
            let mut table = fixture.read(&format!("alpha/boards/power/{filename}.json"));
            table["label"] = json!(format!("UPM {filename}"));
            fixture.write(&format!("alpha/controller/{filename}.json"), &table);
        }
        let files = fixture.load().unwrap();
        let config = files.definition(Some("alpha")).unwrap();
        assert_eq!(
            config["boards"]["DSP"]["process"]["label"],
            "甲项目 process"
        );
        assert_eq!(config["boards"]["UPM"]["process"]["label"], "UPM process");
        assert!(config["boards"].get("power").is_none());

        manifest["topology"]["board_types"][1]["directory"] = json!("boards/power/.");
        fixture.write("alpha/project.json", &manifest);
        assert!(fixture.error().contains("多个板卡不能绑定同一目录"));
    }

    #[test]
    fn directory_is_required_and_must_stay_inside_project() {
        for directory in [
            Value::Null,
            json!(""),
            json!("../external"),
            json!("/tmp/external"),
        ] {
            let fixture = Fixture::new();
            fixture.project("alpha", "甲项目");
            let mut manifest = fixture.read("alpha/project.json");
            manifest["topology"]["board_types"][0]["directory"] = directory;
            fixture.write("alpha/project.json", &manifest);
            assert!(fixture.error().contains("directory"));
        }
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        std::fs::remove_dir_all(fixture.0.join("alpha/DSP")).unwrap();
        fixture.write("alpha/DSP", &json!({}));
        assert!(fixture.error().contains("须为目录"));
    }

    #[test]
    fn complete_table_definitions_are_validated_without_inheritance() {
        for (field, replacement, expected) in [
            ("version", json!(2), "version 必须为 1"),
            ("enabled", json!("true"), "enabled 必须为布尔值"),
            ("columns", json!(["unknown_column"]), "unknown_column"),
            ("editor", json!(["id"]), "id"),
            ("fields", json!({}), "name"),
        ] {
            let fixture = Fixture::new();
            fixture.project("alpha", "甲项目");
            let mut value = fixture.read("alpha/DSP/process.json");
            value[field] = replacement;
            fixture.write("alpha/DSP/process.json", &value);
            let error = fixture.error();
            assert!(error.contains(expected), "{error}");
            assert!(error.contains("process.json"), "{error}");
        }
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let mut value = fixture.read("alpha/DSP/process.json");
        value.as_object_mut().unwrap().remove("ordering");
        fixture.write("alpha/DSP/process.json", &value);
        assert!(fixture.error().contains("完整包含"));
    }

    #[test]
    fn visibility_is_explicit_and_auxiliary_order_is_preserved() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let mut manifest = fixture.read("alpha/project.json");
        manifest["workspace"]["boards"]["DSP"]["tables"] = json!(["transmit", "fields", "data"]);
        fixture.write("alpha/project.json", &manifest);
        let mut collect = fixture.read("alpha/DSP/collect.json");
        collect["enabled"] = json!(false);
        fixture.write("alpha/DSP/collect.json", &collect);
        let files = fixture.load().unwrap();
        assert_eq!(
            files.definition(Some("alpha")).unwrap()["workspace"]["boards"]["DSP"]["tables"],
            json!(["process", "forward", "fields", "data"])
        );
        assert!(
            files.definition(Some("alpha")).unwrap()["boards"]["DSP"]["process"]
                .get("enabled")
                .is_none()
        );
    }

    #[test]
    fn old_table_names_and_missing_workspace_are_rejected() {
        for extra in ["DSP/forward.json", "DSP/tansmit.json"] {
            let fixture = Fixture::new();
            fixture.project("alpha", "甲项目");
            fixture.write(&format!("alpha/{extra}"), &json!({}));
            assert!(fixture.error().contains("DSP/"));
        }
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let mut manifest = fixture.read("alpha/project.json");
        manifest["workspace"]["boards"] = json!({});
        fixture.write("alpha/project.json", &manifest);
        assert!(fixture.error().contains("workspace.boards"));
        let fixture = Fixture::new();
        std::fs::create_dir_all(fixture.0.join("unexpected")).unwrap();
        assert!(fixture.error().contains("unexpected/project.json"));
    }

    #[test]
    fn workbook_must_be_contained_in_its_project_folder() {
        for workbook in ["../outside.xlsx", "/tmp/outside.xlsx"] {
            let fixture = Fixture::new();
            fixture.project("alpha", "甲项目");
            let mut manifest = fixture.read("alpha/project.json");
            manifest["workbook"] = json!(workbook);
            fixture.write("alpha/project.json", &manifest);
            assert!(fixture.error().contains("workbook 必须为项目内的相对路径"));
        }
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        fixture.write("alpha/sources/points.xlsx", &json!({}));
        let mut manifest = fixture.read("alpha/project.json");
        manifest["workbook"] = json!("sources/points.xlsx");
        fixture.write("alpha/project.json", &manifest);
        assert!(fixture.load().is_ok());
        manifest["workbook"] = json!("sources/missing.xlsx");
        fixture.write("alpha/project.json", &manifest);
        assert!(fixture.error().contains("sources/missing.xlsx"));
        assert!(workbook_path(&fixture.0.join("alpha"), "sources/missing.xlsx").is_err());
    }

    #[test]
    fn dump_selection_is_explicit_or_an_unambiguous_root_archive() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let files = fixture.load().unwrap();
        assert!(files.dump_path("alpha").unwrap().is_none());
        std::fs::write(fixture.0.join("alpha/project.dump"), b"PGDMP").unwrap();
        assert_eq!(
            files.dump_path("alpha").unwrap(),
            Some(fixture.0.join("alpha/project.dump"))
        );
        std::fs::write(fixture.0.join("alpha/second.Dump"), b"PGDMP").unwrap();
        assert!(
            files
                .dump_path("alpha")
                .unwrap_err()
                .to_string()
                .contains("多个 Dump")
        );
        std::fs::remove_file(fixture.0.join("alpha/second.Dump")).unwrap();
        let mut manifest = fixture.read("alpha/project.json");
        manifest["dump"] = json!("project.dump");
        fixture.write("alpha/project.json", &manifest);
        assert!(files.dump_path("alpha").unwrap().is_some());
        std::fs::create_dir_all(fixture.0.join("alpha/data")).unwrap();
        std::fs::rename(
            fixture.0.join("alpha/project.dump"),
            fixture.0.join("alpha/data/points.backup"),
        )
        .unwrap();
        assert!(files.dump_path("alpha").is_err());
        manifest["dump"] = json!("data/points.backup");
        fixture.write("alpha/project.json", &manifest);
        assert_eq!(
            files.dump_path("alpha").unwrap(),
            Some(fixture.0.join("alpha/data/points.backup"))
        );
        manifest["dump"] = json!("../outside.dump");
        fixture.write("alpha/project.json", &manifest);
        assert!(
            files
                .dump_path("alpha")
                .unwrap_err()
                .to_string()
                .contains("dump 必须为项目内的相对路径")
        );
    }

    #[test]
    fn complete_folder_fingerprint_detects_file_content_names_and_new_projects() {
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let files = fixture.load().unwrap();
        assert_eq!(files.root(), fixture.0.canonicalize().unwrap());
        assert!(files.fingerprint("missing").unwrap().is_none());
        assert!(files.fingerprint("../outside").is_err());
        let first = files.fingerprint("alpha").unwrap().unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(files.fingerprint("alpha").unwrap().unwrap(), first);
        std::fs::write(fixture.0.join("alpha/project.dump"), b"PGDMP-one").unwrap();
        let archive = files.fingerprint("alpha").unwrap().unwrap();
        assert_ne!(first, archive);
        std::fs::write(fixture.0.join("alpha/project.dump"), b"PGDMP-two").unwrap();
        let changed = files.fingerprint("alpha").unwrap().unwrap();
        assert_ne!(archive, changed);
        std::fs::rename(
            fixture.0.join("alpha/project.dump"),
            fixture.0.join("alpha/renamed.dump"),
        )
        .unwrap();
        assert_ne!(changed, files.fingerprint("alpha").unwrap().unwrap());
        fixture.write(".imports/incomplete/project.json", &json!({}));
        assert_eq!(files.catalog().unwrap().as_array().unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn folder_fingerprints_reject_internal_and_external_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let files = fixture.load().unwrap();
        symlink(
            fixture.0.join("alpha/project.json"),
            fixture.0.join("alpha/alias.json"),
        )
        .unwrap();
        assert!(
            files
                .fingerprint("alpha")
                .unwrap_err()
                .to_string()
                .contains("符号链接")
        );
        symlink(fixture.0.join("alpha"), fixture.0.join("beta")).unwrap();
        assert!(files.fingerprint("beta").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn table_directory_file_and_workbook_symlinks_cannot_escape_project() {
        use std::os::unix::fs::symlink;
        let outside = Fixture::new();
        outside.project("external", "外部项目");
        for relative in ["DSP", "DSP/process.json"] {
            let fixture = Fixture::new();
            fixture.project("alpha", "甲项目");
            let link = fixture.0.join("alpha").join(relative);
            if link.is_dir() {
                std::fs::remove_dir_all(&link).unwrap();
            } else {
                std::fs::remove_file(&link).unwrap();
            }
            symlink(outside.0.join("external").join(relative), &link).unwrap();
            assert!(fixture.error().contains("不能越出所属项目目录"));
        }
        let fixture = Fixture::new();
        fixture.project("alpha", "甲项目");
        let mut manifest = fixture.read("alpha/project.json");
        manifest["workbook"] = json!("source.xlsx");
        fixture.write("alpha/project.json", &manifest);
        symlink(
            outside.0.join("external/project.json"),
            fixture.0.join("alpha/source.xlsx"),
        )
        .unwrap();
        assert!(fixture.error().contains("不能越出所属项目目录"));
    }
}
