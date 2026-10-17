//! Atomic, append-only batches using the same point rules and change previews as the UI.
use crate::{
    AppState,
    auth::User,
    change_merge,
    error::{AppError, Result},
    point_tables,
    topology::{self, Change},
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Acquire, Postgres, Transaction};
use std::collections::BTreeSet;

const MAX_ROWS: usize = 200;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct BatchRow {
    row: u32,
    values: serde_json::Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchRequest {
    revision: i32,
    rows: Vec<BatchRow>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    model_id: i64,
    kind: String,
    rows: Vec<BatchRow>,
}

pub async fn preview(
    State(s): State<AppState>,
    u: User,
    Path((pid, mid, kind)): Path<(i64, i64, String)>,
    Json(request): Json<BatchRequest>,
) -> Result<Json<Value>> {
    point_tables::entity(&kind)?;
    topology::preview(
        State(s),
        u,
        Path(pid),
        Json(Change {
            revision: request.revision,
            entity: "point_batch".into(),
            operation: "create".into(),
            id: None,
            expected: Value::Null,
            values: json!({"model_id":mid,"kind":kind,"rows":request.rows}),
        }),
    )
    .await
}

fn decode(c: &Change) -> Result<Batch> {
    if c.operation != "create" || c.id.is_some() {
        return Err(AppError::bad("批量添加只支持新增"));
    }
    let batch: Batch = serde_json::from_value(c.values.clone())?;
    point_tables::entity(&batch.kind)?;
    if batch.model_id <= 0 || batch.rows.is_empty() || batch.rows.len() > MAX_ROWS {
        return Err(AppError::bad("请选择板卡，每批添加 1～200 行"));
    }
    let mut seen = BTreeSet::new();
    if batch.rows.iter().any(|r| r.row == 0 || !seen.insert(r.row)) {
        return Err(AppError::bad("来源行号必须为不重复的正整数"));
    }
    Ok(batch)
}

fn failure(errors: Vec<Value>) -> AppError {
    let mut error = AppError::bad("批量添加校验失败，整批未保存");
    error.2 = Some(json!({"errors":errors}));
    error
}

fn check_fields(batch: &Batch) -> Result<()> {
    let allowed = point_tables::writable(&batch.kind);
    let required: &[&str] = if batch.kind == "process" {
        &["group_id", "data_item_id", "name", "enum_name"]
    } else {
        &["endpoint_id", "context_id", "signal_id", "field_id"]
    };
    let mut errors = Vec::new();
    for row in &batch.rows {
        let mut add = |key: &str, message: &str| {
            errors.push(json!({"row":row.row,"field":key,"message":message}))
        };
        for key in required {
            if row
                .values
                .get(*key)
                .is_none_or(|v| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()))
            {
                add(key, "缺少必填字段");
            }
        }
        for (key, value) in &row.values {
            if !allowed.contains(key.as_str()) {
                add(key, "字段不属于当前点表或只读");
                continue;
            }
            if value.is_null()
                && [
                    "sig_id",
                    "sig_symbol",
                    "internal_type",
                    "default_value",
                    "min_value",
                    "max_value",
                ]
                .contains(&key.as_str())
            {
                continue;
            }
            let valid = match key.as_str() {
                "group_id" | "data_item_id" | "endpoint_id" | "context_id" | "signal_id"
                | "field_id" => value.as_i64().is_some_and(|v| v > 0),
                "sig_id" | "poll_interval" | "set_priority" | "scan_priority" => {
                    value.as_i64().is_some_and(|v| i32::try_from(v).is_ok())
                }
                "process_enabled" | "boot_restore" | "manual_restore" => value.is_boolean(),
                _ => value.as_str().is_some_and(|s| s.len() <= 4096),
            };
            if !valid {
                add(key, "字段类型或长度不正确");
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(failure(errors))
    }
}

pub async fn apply(tx: &mut Transaction<'_, Postgres>, pid: i64, c: &Change) -> Result<Value> {
    let batch = decode(c)?;
    check_fields(&batch)?;
    let mut records = Vec::new();
    let mut errors = Vec::new();
    for row in batch.rows {
        // Keep successful rows in the outer transaction to detect within-batch duplicates.
        // Every row savepoint also undoes a signal if its range insert fails.
        let mut proposed = tx.begin().await?;
        let result = point_tables::apply(
            &mut proposed,
            pid,
            &Change {
                revision: c.revision,
                entity: point_tables::entity(&batch.kind)?.into(),
                operation: "create".into(),
                id: None,
                expected: Value::Null,
                values: json!({"model_id":batch.model_id,"fields":row.values}),
            },
        )
        .await;
        match result {
            Ok(record) => {
                proposed.commit().await?;
                records.push(json!({"row":row.row,"record":record}));
            }
            Err(error) => {
                proposed.rollback().await?;
                if error.0.is_server_error() {
                    return Err(error);
                }
                errors.push(json!({"row":row.row,"message":error.1}));
            }
        }
    }
    if !errors.is_empty() {
        return Err(failure(errors));
    }
    Ok(json!({"id":batch.model_id,"kind":batch.kind,"count":records.len(),"rows":records}))
}

/// Attach source row numbers to domain errors (including conflicts with older records).
pub fn annotate(errors: &mut [Value], applied: &Value) {
    for error in errors {
        let row = topology::rows(applied, "rows").iter().find(|r| {
            let id = &r["record"]["id"];
            let matches = match error["entity"].as_str() {
                Some("signals") => applied["kind"] == "process",
                Some("signal_bindings") => applied["kind"] != "process",
                _ => false,
            };
            matches && (error["id"] == *id || error["related_id"] == *id)
        });
        if let Some(row) = row {
            error["row"] = row["row"].clone();
        }
    }
}

/// New IDs differ between preview rollback and commit. Guard their existing dependencies
/// instead of trying to apply an insertion patch containing the preview's sequence IDs.
fn dependencies(doc: &Value, c: &Change) -> Result<Value> {
    let batch = decode(c)?;
    let mut refs = BTreeSet::new();
    refs.insert(("board_models", batch.model_id.to_string()));
    let mut groups = BTreeSet::new();
    let mut contracts = BTreeSet::new();
    for row in batch.rows {
        let v = Value::Object(row.values);
        if batch.kind == "process" {
            groups.insert(v["group_id"].to_string());
            refs.insert(("data_items", v["data_item_id"].to_string()));
            if let Some(symbol) = v["sig_symbol"].as_str() {
                refs.insert(("platform_signals", symbol.to_owned()));
            }
        } else {
            for (table, key) in [
                ("endpoints", "endpoint_id"),
                ("device_contexts", "context_id"),
                ("signals", "signal_id"),
                ("v_signals", "signal_id"),
                ("protocol_fields", "field_id"),
            ] {
                refs.insert((table, v[key].to_string()));
            }
            let endpoint = &doc["endpoints"][v["endpoint_id"].to_string()];
            contracts.insert(endpoint["contract_id"].to_string());
            let signal = &doc["signals"][v["signal_id"].to_string()];
            groups.insert(signal["group_id"].to_string());
            refs.insert(("data_items", signal["data_item_id"].to_string()));
        }
    }
    for id in &groups {
        refs.insert(("signal_groups", id.clone()));
    }
    for id in &contracts {
        refs.insert(("protocol_contracts", id.clone()));
    }
    // Context additions/removals change which devices receive the added processing data;
    // protocol layout changes can change addresses of a new binding.
    for (table, key, ids) in [
        ("device_contexts", "group_id", &groups),
        ("v_protocol_fields", "contract_id", &contracts),
    ] {
        for (id, row) in doc[table].as_object().into_iter().flatten() {
            if ids.contains(&row[key].to_string()) {
                refs.insert((table, id.clone()));
            }
        }
    }
    let mut result = json!({});
    for (table, id) in refs {
        result[format!("{table}/{id}")] = doc[table][&id].clone();
    }
    Ok(result)
}

pub fn guard(base: &Value, current: &Value, c: &Change, revision: i32) -> Result<()> {
    if base.is_null() || dependencies(base, c)? != dependencies(current, c)? {
        return Err(change_merge::conflict(
            c,
            revision,
            "批量添加引用的数据或协议已变化，请重新预览",
        ));
    }
    Ok(())
}
