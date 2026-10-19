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
use sqlx::{Acquire, PgConnection};
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
    board_key: String,
    kind: String,
    rows: Vec<BatchRow>,
}

pub async fn preview(
    State(s): State<AppState>,
    u: User,
    Path((pid, board_key, kind)): Path<(i64, String, String)>,
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
            values: json!({"board_key":board_key,"kind":kind,"rows":request.rows}),
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
    if batch.board_key.trim().is_empty() || batch.rows.is_empty() || batch.rows.len() > MAX_ROWS {
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

fn check_fields(batch: &Batch, operation: &str) -> Result<()> {
    let allowed = point_tables::writable(&batch.kind);
    let required: &[&str] = match batch.kind.as_str() {
        "process" => &["name", "enum_name"],
        _ => &["process_point_id", "name"],
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
            let nullable = &[
                "sig_id",
                "unit",
                "default_value",
                "min_value",
                "max_value",
                "notes",
            ];
            if value.is_null() && nullable.contains(&key.as_str()) {
                continue;
            }
            let valid = match key.as_str() {
                "process_point_id" => value.as_i64().is_some_and(|v| v > 0),
                "sig_id" | "element_count" | "byte_length" | "upp_model" | "address"
                | "wire_length" | "byte_order" => {
                    value.as_i64().is_some_and(|v| i32::try_from(v).is_ok())
                }
                "scale" => value.as_f64().is_some_and(|v| v.is_finite() && v > 0.),
                "enabled" => value.is_boolean(),
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

pub async fn apply(tx: &mut PgConnection, pid: i64, c: &Change) -> Result<Value> {
    let batch = decode(c)?;
    if crate::dsp_points::native_board(tx, pid, &batch.board_key)
        .await?
        .is_none()
    {
        return Err(AppError::bad("此板卡尚未启用点表存储"));
    }
    check_fields(&batch, &c.operation)?;
    let mut records = Vec::new();
    let mut errors = Vec::new();
    for row in batch.rows {
        // Keep successful rows in the outer transaction to detect within-batch duplicates.
        // A failed row is fully rolled back before collecting its errors.
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
                values: json!({"board_key":batch.board_key,"fields":row.values}),
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
    Ok(json!({"board_key":batch.board_key,"kind":batch.kind,"count":records.len(),"rows":records}))
}

/// Rebase a stale draft only when every edited cell still has its original value.
/// Read once for the batch so all comparisons use the same locked project snapshot.
pub async fn can_preview(
    s: &AppState,
    tx: &mut PgConnection,
    pid: i64,
    c: &Change,
) -> Result<bool> {
    let batch = decode(c)?;
    let definition =
        point_tables::board_definition(tx, pid, &batch.board_key, &batch.kind, &s.project_files)
            .await?;
    let current = point_tables::table_rows(tx, pid, &batch.board_key, &batch.kind).await?;
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
            json!({"row":row.row,"record":point_tables::audit_before(graph,entity,row.id.unwrap(),&batch.board_key)})
        })
        .collect();
    Some(json!({"board_key":batch.board_key,"kind":batch.kind,"count":rows.len(),"rows":rows}))
}

/// Attach source row numbers to domain errors (including conflicts with older records).
pub fn annotate(errors: &mut [Value], applied: &Value) {
    for error in errors {
        let row = topology::rows(applied, "rows").iter().find(|r| {
            let id = &r["record"]["id"];
            let matches = match error["entity"].as_str() {
                Some("process_points") => applied["kind"] == "process",
                Some("transmit_points") => applied["kind"] != "process",
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
    let mut result = json!({"board": doc["project_config"]["board_types"].as_array()
        .and_then(|boards| boards.iter().find(|board| board["code"] == batch.board_key))});
    for row in batch.rows {
        if let Some(id) = row.values.get("process_point_id").and_then(Value::as_i64) {
            let key = id.to_string();
            result[format!("process_points/{id}")] = doc["process_points"][&key].clone();
        }
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
        serde_json::from_value(
            json!({"board_key":"DSP","kind":kind,"rows":[{"row":1,"values":values}]}),
        )
        .unwrap()
    }
    #[test]
    fn creation_uses_point_defaults_and_rejects_legacy_fields() {
        assert!(
            check_fields(
                &batch("process", json!({"name":"DSP 点","enum_name":"DSP_POINT"})),
                "create"
            )
            .is_ok()
        );
        assert!(
            check_fields(
                &batch(
                    "forward",
                    json!({"name":"DSP 转发","process_point_id":9,"scale":0.1})
                ),
                "create"
            )
            .is_ok()
        );
        assert!(check_fields(&batch("process", json!({"name":"DSP 点"})), "create").is_err());
        assert!(check_fields(&batch("process", json!({"group_id":1})), "update").is_err());
        assert!(check_fields(&batch("forward", json!({"name":"DSP 转发"})), "create").is_err());
    }
    #[test]
    fn validates_numeric_boolean_and_nullable_fields() {
        for (kind, values) in [
            (
                "process",
                json!({"element_count":1,"byte_length":4,"internal_type":"F32","sig_id":null,"notes":null}),
            ),
            (
                "forward",
                json!({"process_point_id":4,"upp_model":2,"address":42,"wire_length":4,"scale":0.01,"byte_order":2,"enabled":false}),
            ),
        ] {
            assert!(check_fields(&batch(kind, values), "update").is_ok());
        }
        for (kind, values) in [
            ("process", json!({"element_count":"2"})),
            ("process", json!({"byte_length":2.5})),
            ("process", json!({"internal_type":null})),
            ("forward", json!({"process_point_id":0})),
            ("forward", json!({"scale":"0.1"})),
            ("forward", json!({"scale":0})),
            ("forward", json!({"enabled":"false"})),
        ] {
            assert!(check_fields(&batch(kind, values), "update").is_err());
        }
    }
    #[test]
    fn dependencies_follow_json_board_and_referenced_process_point() {
        let change = Change {
            revision: 1,
            entity: "point_batch".into(),
            operation: "create".into(),
            id: None,
            expected: Value::Null,
            values: json!({"board_key":"DSP","kind":"forward","rows":[{"row":1,"values":{"name":"out","process_point_id":7}}]}),
        };
        let base = json!({"project_config":{"board_types":[{"code":"DSP","point_groups":[{"code":"LOCAL"}]}]},"process_points":{"7":{"id":7,"name":"input"},"8":{"id":8,"name":"other"}}});
        let mut current = base.clone();
        current["process_points"]["8"]["name"] = json!("unrelated");
        assert!(guard(&base, &current, &change, 2).is_ok());
        current["process_points"]["7"]["name"] = json!("changed");
        assert!(guard(&base, &current, &change, 2).is_err());
    }
}
