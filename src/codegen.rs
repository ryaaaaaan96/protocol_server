use crate::error::{AppError, Result};
use serde_json::Value;
use sqlx::PgConnection;
use std::io::{Cursor, Write};
pub(crate) fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('\n', "&#10;")
        .replace('\r', "")
}
pub async fn generate(
    tx: &mut PgConnection,
    pid: i64,
    definitions: &crate::project_files::ProjectFiles,
) -> Result<Value> {
    let graph = crate::topology::snapshot(tx, pid, true).await?;
    let mut generated = crate::topology_codegen::generate(&graph)?;
    let issues = crate::table_calculation::issues(tx, pid, definitions, &graph).await?;
    if !issues.is_empty() {
        generated["blocked"] = Value::Bool(true);
        generated["files"] = serde_json::json!({});
        let count = generated["validation"]["errors"].as_u64().unwrap_or(0) + issues.len() as u64;
        generated["validation"]["issues"]
            .as_array_mut()
            .unwrap()
            .extend(issues);
        generated["validation"]["errors"] = count.into();
    }
    generated["revision"] = graph["revision"].clone();
    Ok(generated)
}
pub fn zip_files(files: &Value, manifest: &Value) -> Result<Vec<u8>> {
    let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, content) in files.as_object().ok_or(AppError::bad("生成文件无效"))? {
        z.start_file(name, options)
            .map_err(|e| AppError::bad(e.to_string()))?;
        z.write_all(content.as_str().unwrap_or("").as_bytes())
            .map_err(|e| AppError::bad(e.to_string()))?;
    }
    z.start_file("manifest.json", options)
        .map_err(|e| AppError::bad(e.to_string()))?;
    z.write_all(serde_json::to_string_pretty(manifest)?.as_bytes())
        .map_err(|e| AppError::bad(e.to_string()))?;
    Ok(z.finish()
        .map_err(|e| AppError::bad(e.to_string()))?
        .into_inner())
}
