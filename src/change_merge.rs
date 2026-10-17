//! Three-way comparison using json-patch. SQL writes still go through domain validation.
use crate::{
    AppState,
    error::{AppError, Result},
    point_order, point_tables,
    topology::{self, Change},
};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};

/// Stable identity keys prevent an unrelated row insertion from shifting array paths.
pub fn document(graph: &Value) -> Value {
    let mut result = json!({"project_config":graph["project_config"]});
    for &table in topology::TABLES.iter().chain(topology::VIEWS) {
        if table == "source_records" {
            continue;
        }
        let mut records = serde_json::Map::new();
        for row in topology::rows(graph, table) {
            let key = match table {
                "signal_ranges" => row["signal_id"].to_string(),
                "platform_signals" => row["symbol"].as_str().unwrap_or("").to_owned(),
                "v_passthrough_fields" => format!("{}:{}", row["route_id"], row["field_id"]),
                _ => row["id"].to_string(),
            };
            let mut row = row.clone();
            let fields = row.as_object_mut().unwrap();
            for field in ["created_at", "updated_at", "raw_json"] {
                fields.remove(field);
            }
            // An upserted range gets a different sequence ID after preview rollback.
            if table == "signal_ranges" {
                fields.remove("id");
            }
            records.insert(key, row);
        }
        result[table] = Value::Object(records);
    }
    result
}

pub fn eligible(c: &Change) -> bool {
    matches!(c.operation.as_str(), "update" | "reorder") && c.entity != "project_config"
}

pub fn conflict(c: &Change, current: i32, reason: &str) -> AppError {
    let mut error = AppError::revision_conflict(c.revision, current);
    error.1 = format!(
        "{reason}；本次修改未保存，请基于最新数据重新修改（版本 {} → {current}）",
        c.revision
    );
    error
}

/// At the first preview, compare only the user's changed fields with their original values.
/// The resulting preview always uses current server data and requires confirmation.
pub async fn can_preview(
    s: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    c: &Change,
    graph: &Value,
) -> Result<bool> {
    if c.entity == "point_batch" && c.operation == "update" {
        return crate::point_batch::can_preview(s, tx, pid, c).await;
    }
    if !eligible(c) || c.expected.is_null() {
        return Ok(false);
    }
    if c.entity == "point_order" || point_tables::is_point_entity(&c.entity) {
        let mid = topology::num(&c.values, "model_id");
        let kind = match c.entity.as_str() {
            "point_order" => c.values["kind"].as_str().unwrap_or(""),
            "process_points" => "process",
            "collect_points" => "collect",
            _ => "forward",
        };
        point_tables::entity(kind)?;
        let definition =
            point_tables::board_definition(tx, pid, mid, kind, &s.project_files).await?;
        let mut rows = point_tables::table_rows(tx, pid, mid, kind).await?;
        if c.entity == "point_order" {
            point_order::sort_rows(&mut rows, &definition["ordering"]);
            let Some(first) = rows.iter().find(|r| r["id"] == c.values["ids"][0]) else {
                return Ok(false);
            };
            let ids: Vec<_> = rows
                .iter()
                .filter(|r| {
                    point_order::group_key(r, &definition["ordering"])
                        == point_order::group_key(first, &definition["ordering"])
                })
                .map(|r| r["id"].clone())
                .collect();
            return Ok(c.expected == json!(ids));
        }
        let Some(row) = rows.iter().find(|r| r["id"].as_i64() == c.id) else {
            return Ok(false);
        };
        let Some(fields) = c.values["fields"].as_object() else {
            return Ok(false);
        };
        return Ok(fields.keys().all(|key| {
            let current = row["edit_values"]
                .get(key)
                .unwrap_or(&definition["fields"][key]["default"]);
            c.expected
                .get(key)
                .is_some_and(|original| original == current)
        }));
    }
    let Some(row) = topology::find(graph, &c.entity, c.id.unwrap_or(0)) else {
        return Ok(false);
    };
    Ok(c.values.as_object().is_some_and(|fields| {
        fields.keys().all(|key| {
            c.expected
                .get(key)
                .is_some_and(|original| original == &row[key])
        })
    }))
}

fn paths(patch: &json_patch::Patch) -> Vec<String> {
    patch.0.iter().map(|op| op.path().to_string()).collect()
}
fn overlap(a: &str, b: &str) -> bool {
    a == b
        || a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/'))
        || b.strip_prefix(a).is_some_and(|rest| rest.starts_with('/'))
}

/// Produce the only acceptable combined state. Domain replay must match it exactly.
pub fn rebase(
    base: &Value,
    patch: &json_patch::Patch,
    current: &Value,
    c: &Change,
    revision: i32,
) -> Result<Value> {
    let incoming = paths(patch);
    let concurrent = paths(&json_patch::diff(base, current));
    let conflicts: Vec<_> = incoming
        .iter()
        .filter(|a| concurrent.iter().any(|b| overlap(a, b)))
        .cloned()
        .collect();
    if !conflicts.is_empty() {
        let mut error = conflict(
            c,
            revision,
            "相同字段或关联配置已被其他成员修改，无法自动合并",
        );
        error.2.as_mut().unwrap()["conflicts"] = json!(conflicts);
        return Err(error);
    }
    if c.entity == "point_order" {
        let table = if c.values["kind"] == "process" {
            "signals"
        } else {
            "signal_bindings"
        };
        for id in c.values["ids"].as_array().into_iter().flatten() {
            let key = id.to_string();
            let old = &base[table][&key];
            let new = &current[table][&key];
            if new.is_null()
                || [
                    "display_order",
                    "group_id",
                    "endpoint_id",
                    "context_id",
                    "field_id",
                ]
                .iter()
                .any(|f| old[f] != new[f])
            {
                return Err(conflict(
                    c,
                    revision,
                    "同组顺序或分组归属已被修改，无法自动合并排序",
                ));
            }
            if table == "signal_bindings" {
                let field = old["field_id"].to_string();
                if base["protocol_fields"][&field]["ordinal"]
                    != current["protocol_fields"][&field]["ordinal"]
                {
                    return Err(conflict(
                        c,
                        revision,
                        "同组协议顺序已被修改，无法自动合并排序",
                    ));
                }
            }
        }
    }
    let mut merged = current.clone();
    json_patch::patch(&mut merged, patch)
        .map_err(|_| conflict(c, revision, "关联记录已变化，无法自动合并"))?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn change() -> Change {
        Change {
            revision: 1,
            entity: "signals".into(),
            operation: "update".into(),
            id: Some(1),
            values: json!({"name":"new"}),
            expected: Value::Null,
        }
    }
    #[test]
    fn identities_survive_insertion_and_symbol_tables_have_distinct_keys() {
        let a = document(
            &json!({"signals":[{"id":2,"name":"two"}],"platform_signals":[{"symbol":"A","signal_id":1},{"symbol":"B","signal_id":2}]}),
        );
        let b = document(
            &json!({"signals":[{"id":1,"name":"one"},{"id":2,"name":"two"}],"platform_signals":[{"symbol":"B","signal_id":2},{"symbol":"A","signal_id":1}]}),
        );
        assert_eq!(paths(&json_patch::diff(&a, &b)), vec!["/signals/1"]);
        assert_eq!(a["platform_signals"].as_object().unwrap().len(), 2);
    }
    #[test]
    fn disjoint_fields_merge_but_same_field_and_deletion_conflict() {
        let base = json!({"signals":{"1":{"name":"old","flags":"0"},"11":{"name":"other"}}});
        let mut edited = base.clone();
        edited["signals"]["1"]["name"] = json!("new");
        let patch = json_patch::diff(&base, &edited);
        let mut current = base.clone();
        current["signals"]["1"]["flags"] = json!("1");
        current["signals"]["11"]["name"] = json!("renamed");
        let merged = rebase(&base, &patch, &current, &change(), 2).unwrap();
        assert_eq!(merged["signals"]["1"], json!({"name":"new","flags":"1"}));
        assert_eq!(merged["signals"]["11"]["name"], "renamed");
        current["signals"]["1"]["name"] = json!("competing");
        assert!(rebase(&base, &patch, &current, &change(), 2).is_err());
        current["signals"].as_object_mut().unwrap().remove("1");
        assert!(rebase(&base, &patch, &current, &change(), 2).is_err());
    }
}
