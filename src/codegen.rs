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
pub async fn generate(tx: &mut PgConnection, pid: i64) -> Result<Value> {
    let graph = crate::topology::snapshot(tx, pid, true).await?;
    let mut generated = crate::topology_codegen::generate(&graph)?;
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
