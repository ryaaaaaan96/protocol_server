//! Read-only project templates and display definitions. Loading never writes to the database.
use crate::{auth::User, db, importer, point_tables, project_config, topology_import};
use anyhow::{Context, Result, anyhow, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{collections::BTreeMap, path::Path};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    key: String,
    name: String,
    #[serde(default)]
    description: String,
    topology: Value,
    // Relative to project.json. Imported only by the explicit creation command.
    workbook: Option<String>,
}

struct ProjectFile {
    manifest: Manifest,
    directory: std::path::PathBuf,
    point_tables: Value,
}

pub struct ProjectFiles {
    defaults: Value,
    projects: BTreeMap<String, ProjectFile>,
}

pub(crate) fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                merge(base.entry(key).or_insert(Value::Null), value);
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}

fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(
        &std::fs::read(path).with_context(|| format!("读取 {}", path.display()))?,
    )
    .with_context(|| format!("解析 {}", path.display()))
}

impl ProjectFiles {
    pub fn load() -> Result<Self> {
        let directory =
            std::env::var("PROJECT_CONFIG_DIR").unwrap_or_else(|_| "config/projects".into());
        Self::load_from(Path::new(&directory), point_tables::load_definition()?)
    }

    fn load_from(directory: &Path, defaults: Value) -> Result<Self> {
        let mut projects = BTreeMap::new();
        for entry in std::fs::read_dir(directory)
            .with_context(|| format!("读取项目配置目录 {}", directory.display()))?
        {
            let path = entry?.path();
            if !path.is_dir() {
                continue;
            }
            let file = path.join("project.json");
            if !file.exists() {
                continue;
            }
            let mut manifest: Manifest = serde_json::from_value(read_json(&file)?)
                .with_context(|| format!("项目清单格式错误 {}", file.display()))?;
            let key = &manifest.key;
            ensure!(
                manifest.version == 1
                    && !key.is_empty()
                    && key.len() <= 64
                    && key.as_bytes()[0].is_ascii_lowercase()
                    && key.bytes().all(|c| c.is_ascii_lowercase()
                        || c.is_ascii_digit()
                        || b"_-".contains(&c))
                    && path.file_name().and_then(|s| s.to_str()) == Some(key),
                "{}: version 必须为 1；key 必须与目录名相同，使用小写字母开头的字母、数字、_、-（最多 64 字节）",
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
                    .map_err(|e| anyhow!("{}: {}", file.display(), e.1))?,
            )?;
            let mut point_tables = defaults.clone();
            let override_path = path.join("point-tables.json");
            if override_path.exists() {
                let patch = read_json(&override_path)?;
                ensure!(
                    patch.is_object(),
                    "{}: 配置须为 JSON 对象",
                    override_path.display()
                );
                merge(&mut point_tables, &patch);
            }
            point_tables::validate_definition(&point_tables)
                .map_err(|e| anyhow!("{}: {}", override_path.display(), e.1))?;
            projects.insert(
                manifest.key.clone(),
                ProjectFile {
                    manifest,
                    directory: path,
                    point_tables,
                },
            );
        }
        Ok(Self { defaults, projects })
    }

    pub fn definition(&self, key: Option<&str>) -> &Value {
        key.and_then(|key| self.projects.get(key))
            .map(|project| &project.point_tables)
            .unwrap_or(&self.defaults)
    }

    pub async fn create(&self, pool: &PgPool, key: &str) -> Result<()> {
        let project = self.projects.get(key)
            .with_context(|| format!("未找到项目配置 {key}，请检查 config/projects/<项目>/project.json 或 PROJECT_CONFIG_DIR"))?;
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
        let mut imported = Value::Null;
        if let Some(workbook) = &m.workbook {
            let path = project.directory.join(workbook);
            let bytes =
                std::fs::read(&path).with_context(|| format!("读取工作簿 {}", path.display()))?;
            ensure!(bytes.len() <= 15 * 1024 * 1024, "工作簿不能超过 15 MiB");
            let hash = hex::encode(Sha256::digest(&bytes));
            let data = tokio::task::spawn_blocking(move || importer::parse(bytes))
                .await?
                .map_err(|e| anyhow!("{}: {}", path.display(), e.1))?;
            // This project was inserted in this transaction; existing projects never enter import.
            let report = topology_import::import(&mut tx, pid, &data)
                .await
                .map_err(|e| anyhow!(e.1))?;
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("points.xlsx");
            sqlx::query("INSERT INTO imports(project_id,filename,sha256,report,created_by) VALUES($1,$2,$3,$4,$5)")
                .bind(pid).bind(filename).bind(&hash).bind(&report).bind(user.id).execute(&mut *tx).await?;
            imported = json!({"filename":filename,"sha256":hash,"validation":report});
        }
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
                "已导入工作簿：{}；校验错误 {} 条、提示 {} 条，请在校验中心处理。",
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

    #[test]
    fn overrides_merge_fields_and_replace_column_arrays() {
        let mut value = json!({"fields":{"name":{"label":"名称","type":"text"}},"tables":{"process":{"columns":["name","sig_id"]}}});
        merge(
            &mut value,
            &json!({"fields":{"name":{"label":"项目名称"}},"tables":{"process":{"columns":["name"]}}}),
        );
        assert_eq!(
            value["fields"]["name"],
            json!({"label":"项目名称","type":"text"})
        );
        assert_eq!(value["tables"]["process"]["columns"], json!(["name"]));
    }

    #[test]
    fn bundled_project_is_valid_and_unbound_projects_use_defaults() {
        let defaults: Value =
            serde_json::from_str(include_str!("../config/point-tables.json")).unwrap();
        let files =
            ProjectFiles::load_from(Path::new("config/projects"), defaults.clone()).unwrap();
        assert!(files.projects.contains_key("upm"));
        assert_eq!(files.definition(None), &defaults);
        assert_eq!(files.definition(Some("missing")), &defaults);
    }
}
