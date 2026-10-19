//! Atomic point batches using the same point rules and change previews as the UI.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<i64>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    expected: Value,
    values: serde_json::Map<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchRequest {
    revision: i32,
    #[serde(default = "create_operation")]
    operation: String,
    rows: Vec<BatchRow>,
}
fn create_operation() -> String {
    "create".into()
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
            operation: request.operation,
            id: None,
            expected: Value::Null,
            values: json!({"model_id":mid,"kind":kind,"rows":request.rows}),
        }),
    )
    .await
}

fn decode(c: &Change) -> Result<Batch> {
    if !matches!(c.operation.as_str(), "create" | "update") || c.id.is_some() {
        return Err(AppError::bad("点表批量操作只支持新增或修改"));
    }
    let batch: Batch = serde_json::from_value(c.values.clone())?;
    point_tables::entity(&batch.kind)?;
    if batch.model_id <= 0 || batch.rows.is_empty() || batch.rows.len() > MAX_ROWS {
        return Err(AppError::bad("请选择板卡，每批操作 1～200 行"));
    }
    let mut seen = BTreeSet::new();
    if batch.rows.iter().any(|r| r.row == 0 || !seen.insert(r.row)) {
        return Err(AppError::bad("来源行号必须为不重复的正整数"));
    }
    let mut ids = BTreeSet::new();
    for row in &batch.rows {
        if c.operation == "update" {
            if row.id.is_none_or(|id| id <= 0 || !ids.insert(id)) {
                return Err(failure(vec![
                    json!({"row":row.row,"field":"id","message":"修改行必须指定不重复的有效记录 ID"}),
                ]));
            }
            if row.values.is_empty() {
                return Err(failure(vec![
                    json!({"row":row.row,"message":"修改行至少需要一个字段"}),
                ]));
            }
            if !row.expected.is_null() && !row.expected.is_object() {
                return Err(failure(vec![
                    json!({"row":row.row,"message":"expected 必须为原始编辑字段对象"}),
                ]));
            }
        } else if row.id.is_some() || !row.expected.is_null() {
            return Err(failure(vec![
                json!({"row":row.row,"message":"新增行不能包含已有记录 ID 或 expected"}),
            ]));
        }
    }
    Ok(batch)
}

fn failure(errors: Vec<Value>) -> AppError {
    let mut error = AppError::bad("批量点表校验失败，整批未保存");
    error.2 = Some(json!({"errors":errors}));
    error
}

fn check_fields(batch: &Batch, operation: &str, native: bool) -> Result<()> {
    let allowed = point_tables::writable(&batch.kind);
    // Native rows use the same defaults as a single point edit. They must not
    // require the unrelated legacy data-item/group/endpoint foreign keys.
    let required: &[&str] = match (native, batch.kind.as_str()) {
        (true, "process") => &["name", "enum_name"],
        (true, "forward") => &["process_point_id", "name"],
        (_, "process") => &["group_id", "data_item_id", "name", "enum_name"],
        _ => &["endpoint_id", "context_id", "signal_id", "field_id"],
    };
    let mut errors = Vec::new();
    for row in &batch.rows {
        let mut add = |key: &str, message: &str| {
            errors.push(json!({"row":row.row,"field":key,"message":message}))
        };
        for key in required {
            if operation == "update" && !row.values.contains_key(*key) {
                continue;
            }
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
            let nullable = if native {
                &[
                    "sig_id",
                    "unit",
                    "default_value",
                    "min_value",
                    "max_value",
                    "notes",
                ][..]
            } else {
                &[
                    "sig_id",
                    "sig_symbol",
                    "internal_type",
                    "default_value",
                    "min_value",
                    "max_value",
                ][..]
            };
            if value.is_null() && nullable.contains(&key.as_str()) {
                continue;
            }
            let valid = match key.as_str() {
                "group_id" | "data_item_id" | "endpoint_id" | "context_id" | "signal_id"
                | "field_id" => value.as_i64().is_some_and(|v| v > 0),
                "sig_id" | "poll_interval" | "set_priority" | "scan_priority" => {
                    value.as_i64().is_some_and(|v| i32::try_from(v).is_ok())
                }
                "process_point_id" if native => value.as_i64().is_some_and(|v| v > 0),
                "element_count" | "byte_length" | "upp_model" | "address" | "wire_length"
                | "byte_order"
                    if native =>
                {
                    value.as_i64().is_some_and(|v| i32::try_from(v).is_ok())
                }
                "scale" if native => value.as_f64().is_some_and(|v| v.is_finite() && v > 0.),
                "enabled" if native => value.is_boolean(),
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
    let native = crate::dsp_points::native_board(tx, pid, batch.model_id)
        .await?
        .is_some();
    check_fields(&batch, &c.operation, native)?;
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
                operation: c.operation.clone(),
                id: row.id,
                expected: row.expected,
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
                if let Some(details) = error.2.as_ref().and_then(|v| v["errors"].as_array()) {
                    errors.extend(details.iter().cloned().map(|mut detail| {
                        detail["row"] = json!(row.row);
                        detail
                    }));
                } else {
                    errors.push(json!({"row":row.row,"message":error.1}));
                }
            }
        }
    }
    if !errors.is_empty() {
        return Err(failure(errors));
    }
    Ok(json!({"id":batch.model_id,"kind":batch.kind,"count":records.len(),"rows":records}))
}

/// Rebase a stale draft only when every edited cell still has its original value.
/// Read once for the batch so all comparisons use the same locked project snapshot.
pub async fn can_preview(
    s: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    c: &Change,
) -> Result<bool> {
    let batch = decode(c)?;
    let definition =
        point_tables::board_definition(tx, pid, batch.model_id, &batch.kind, &s.project_files)
            .await?;
    let current = point_tables::table_rows(tx, pid, batch.model_id, &batch.kind).await?;
    Ok(batch.rows.iter().all(|change| {
        current
            .iter()
            .find(|row| row["id"].as_i64() == change.id)
            .is_some_and(|row| {
                change.values.keys().all(|key| {
                    let value = row["edit_values"]
                        .get(key)
                        .unwrap_or(&definition["fields"][key]["default"]);
                    change.expected.get(key).is_some_and(|old| old == value)
                })
            })
    }))
}

pub fn audit_before(graph: &Value, c: &Change) -> Option<Value> {
    if c.operation != "update" {
        return None;
    }
    let batch = decode(c).ok()?;
    let entity = point_tables::entity(&batch.kind).ok()?;
    let rows: Vec<_> = batch
        .rows
        .iter()
        .map(|row| {
            json!({"row":row.row,"record":point_tables::audit_before(graph,entity,row.id.unwrap(),batch.model_id)})
        })
        .collect();
    Some(json!({"id":batch.model_id,"kind":batch.kind,"count":rows.len(),"rows":rows}))
}

/// Attach source row numbers to domain errors (including conflicts with older records).
pub fn annotate(errors: &mut [Value], applied: &Value) {
    for error in errors {
        let row = topology::rows(applied, "rows").iter().find(|r| {
            let id = &r["record"]["id"];
            let matches = match error["entity"].as_str() {
                Some("signals" | "process_points") => applied["kind"] == "process",
                Some("signal_bindings" | "transmit_points") => applied["kind"] != "process",
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
        if let Some(id) = v["process_point_id"].as_i64() {
            refs.insert(("process_points", id.to_string()));
        }
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
    result["project_config"] = doc["project_config"].clone();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(kind: &str, values: Value) -> Batch {
        serde_json::from_value(json!({
            "model_id": 1, "kind": kind, "rows": [{"row": 1, "values": values}]
        }))
        .unwrap()
    }

    #[test]
    fn native_creation_uses_point_defaults_without_legacy_foreign_keys() {
        let process = batch(
            "process",
            json!({"name":"DSP 点","enum_name":"DSP_POINT","internal_type":"U16",
                "element_count":2,"byte_length":4,"group_key":"LOCAL"}),
        );
        assert!(check_fields(&process, "create", true).is_ok());
        assert!(check_fields(&process, "create", false).is_err());
        let defaults = batch("process", json!({"name":"DSP 点","enum_name":"DSP_POINT"}));
        assert!(check_fields(&defaults, "create", true).is_ok());
        assert!(check_fields(&batch("process", json!({"name":"DSP 点"})), "create", true).is_err());
        let forward = batch(
            "forward",
            json!({"name":"DSP 转发","process_point_id":9,"upp_model":103,"address":2000,
                "wire_type":"S32","wire_length":4,"scale":0.1,"byte_order":1,
                "conversion":"fixed_point","enabled":true}),
        );
        assert!(check_fields(&forward, "create", true).is_ok());
        assert!(check_fields(&forward, "create", false).is_err());
        assert!(
            check_fields(
                &batch("forward", json!({"name":"DSP 转发"})),
                "create",
                true
            )
            .is_err()
        );
    }

    #[test]
    fn native_updates_validate_numeric_boolean_and_nullable_fields() {
        for (kind, valid) in [
            (
                "process",
                json!({"element_count":1,"byte_length":4,"internal_type":"F32","sig_id":null,"notes":null}),
            ),
            (
                "forward",
                json!({"process_point_id":4,"upp_model":2,"address":42,"wire_length":4,"scale":0.01,"byte_order":2,"enabled":false}),
            ),
        ] {
            assert!(check_fields(&batch(kind, valid), "update", true).is_ok());
        }
        for (kind, invalid) in [
            ("process", json!({"element_count":"2"})),
            ("process", json!({"byte_length":2.5})),
            ("process", json!({"internal_type":null})),
            ("forward", json!({"process_point_id":0})),
            ("forward", json!({"scale":"0.1"})),
            ("forward", json!({"scale":0})),
            ("forward", json!({"enabled":"false"})),
        ] {
            assert!(check_fields(&batch(kind, invalid), "update", true).is_err());
        }
        assert!(
            check_fields(
                &batch("process", json!({"internal_type":null})),
                "update",
                false
            )
            .is_ok()
        );
    }
}
