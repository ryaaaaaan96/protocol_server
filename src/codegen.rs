use crate::error::{AppError, Result};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
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
pub(crate) fn c_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_ascii_control() => out.push_str(&format!("\\{:03o}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
pub async fn generate(tx: &mut Transaction<'_, Postgres>, pid: i64) -> Result<Value> {
    let graph = crate::topology::snapshot(tx, pid, true).await?;
    crate::topology_codegen::generate(&graph)
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
