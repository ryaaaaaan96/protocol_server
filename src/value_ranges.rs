//! STRING values have a default and a byte length, but never numeric bounds.
use crate::{
    error::{AppError, Result},
    topology::Change,
};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};

fn reject_bounds(values: &Value) -> Result<()> {
    let errors: Vec<_> = ["min_value", "max_value"]
        .into_iter()
        .filter(|key| {
            values.get(*key).is_some_and(|v| {
                !v.is_null() && !v.as_str().is_some_and(|s| s.trim().is_empty())
            })
        })
        .map(|key| json!({"field":key,"code":"string_bounds","message":"STRING 字符串类型不支持数值上下限；请清空上下限"}))
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        let mut error = AppError::bad("STRING 字符串类型不支持数值上下限");
        error.2 = Some(json!({"errors":errors}));
        Err(error)
    }
}

/// This runs for both generic entity writes and the composite point-table API.
pub async fn prepare(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    c: &Change,
    values: &mut Value,
) -> Result<()> {
    if !matches!(c.entity.as_str(), "data_items" | "signal_ranges") {
        return Ok(());
    }
    let old: Value = if c.operation == "update" {
        sqlx::query_scalar(&format!(
            "SELECT to_jsonb(t) FROM {} t WHERE project_id=$1 AND id=$2",
            c.entity
        ))
        .bind(pid)
        .bind(c.id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(AppError::not_found())?
    } else {
        json!({})
    };
    let is_string = if c.entity == "data_items" {
        values.get("data_type").unwrap_or(&old["data_type"]) == "STRING"
    } else {
        let sid = values.get("signal_id").unwrap_or(&old["signal_id"]);
        let typ: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(s.internal_type,d.data_type) FROM signals s JOIN data_items d ON d.id=s.data_item_id AND d.project_id=s.project_id WHERE s.project_id=$1 AND s.id=$2",
        )
        .bind(pid)
        .bind(sid.as_i64())
        .fetch_optional(&mut **tx)
        .await?;
        typ.as_deref() == Some("STRING")
    };
    if is_string {
        reject_bounds(values)?;
        if c.entity == "data_items" && c.operation == "update" {
            // A numeric internal_type may still use this shared definition. Keep
            // its previously inherited bounds as signal overrides before clearing
            // the STRING definition, without replacing any explicit override.
            sqlx::query(
                "INSERT INTO signal_ranges(project_id,signal_id,min_value,max_value) SELECT $1,s.id,NULLIF($3,''),NULLIF($4,'') FROM signals s LEFT JOIN signal_ranges r ON r.signal_id=s.id WHERE s.project_id=$1 AND s.data_item_id=$2 AND s.internal_type IS NOT NULL AND s.internal_type<>'STRING' AND ((r.min_value IS NULL AND $3<>'') OR (r.max_value IS NULL AND $4<>'')) ON CONFLICT(signal_id) DO UPDATE SET min_value=COALESCE(signal_ranges.min_value,excluded.min_value),max_value=COALESCE(signal_ranges.max_value,excluded.max_value)"
            ).bind(pid).bind(c.id).bind(old["min_value"].as_str().unwrap_or("")).bind(old["max_value"].as_str().unwrap_or("")).execute(&mut **tx).await?;
        }
        let empty = if c.entity == "data_items" {
            json!("")
        } else {
            Value::Null
        };
        values["min_value"] = empty.clone();
        values["max_value"] = empty;
    }
    Ok(())
}

/// Type/reference changes clear obsolete signal overrides in the same preview
/// transaction. Numeric overrides on a shared STRING definition remain intact.
pub async fn after_write(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    entity: &str,
    row: &Value,
) -> Result<()> {
    if !matches!(entity, "data_items" | "signals") {
        return Ok(());
    }
    let column = if entity == "signals" { "s.id" } else { "d.id" };
    sqlx::query(&format!(
        "UPDATE signal_ranges r SET min_value=NULL,max_value=NULL FROM signals s JOIN data_items d ON d.id=s.data_item_id AND d.project_id=s.project_id WHERE r.project_id=$1 AND s.project_id=$1 AND r.signal_id=s.id AND {column}=$2 AND COALESCE(s.internal_type,d.data_type)='STRING' AND (r.min_value IS NOT NULL OR r.max_value IS NOT NULL)"
    ))
    .bind(pid)
    .bind(row["id"].as_i64())
    .execute(&mut **tx)
    .await?;
    Ok(())
}
