//! Three-way comparison using json-patch. SQL writes still go through domain validation.
use crate::{
    AppState,
    error::{AppError, Result},
    point_order, point_tables,
    topology::{self, Change},
};
use serde_json::{Value, json};
use sqlx::PgConnection;

/// Stable identity keys prevent an unrelated row insertion from shifting array paths.
pub fn document(graph: &Value) -> Value {
    let mut result = json!({"project_config":graph["project_config"]});
    for &table in topology::TABLES {
        let mut records = serde_json::Map::new();
        for row in topology::rows(graph, table) {
            let key = row["id"].to_string();
            let mut row = row.clone();
            let fields = row.as_object_mut().unwrap();
            for field in ["created_at", "updated_at", "raw_json"] {
                fields.remove(field);
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
    tx: &mut PgConnection,
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
        let board_key = c.values["board_key"]
            .as_str()
            .ok_or(AppError::bad("缺少板卡标识"))?;
        let kind = match c.entity.as_str() {
            "point_order" => c.values["kind"].as_str().unwrap_or(""),
            "process_points" => "process",
            "collect_points" => "collect",
            _ => "forward",
        };
        point_tables::entity(kind)?;
        let definition =
            point_tables::board_definition(tx, pid, board_key, kind, &s.project_files).await?;
        let mut rows = point_tables::table_rows(tx, pid, board_key, kind).await?;
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

fn board_config<'a>(document: &'a Value, c: &Change) -> Option<&'a Value> {
    let key = c.values["board_key"].as_str()?;
    document["project_config"]["board_types"]
        .as_array()?
        .iter()
        .find(|board| board["code"] == key && board["point_storage"] == "native")
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
        let table = match c.values["kind"].as_str() {
            Some("process") => "process_points",
            Some("forward") => "transmit_points",
            Some("collect") => "collect_points",
            _ => return Err(conflict(c, revision, "未启用的点表排序")),
        };
        if board_config(base, c).is_none() || board_config(base, c) != board_config(current, c) {
            return Err(conflict(
                c,
                revision,
                "板卡点表存储配置已变化，无法自动合并排序",
            ));
        }
        let guarded: &[&str] = match table {
            "process_points" => &["display_order", "project_id", "board_key", "group_key"],
            "transmit_points" | "collect_points" => &[
                "display_order",
                "project_id",
                "board_key",
                "endpoint_key",
                "upp_model",
                "process_point_id",
            ],
            _ => unreachable!(),
        };
        for id in c.values["ids"].as_array().into_iter().flatten() {
            let key = id.to_string();
            let old = &base[table][&key];
            let new = &current[table][&key];
            if old.is_null()
                || new.is_null()
                || guarded.iter().any(|field| old[field] != new[field])
            {
                return Err(conflict(
                    c,
                    revision,
                    "同组顺序或分组归属已被修改，无法自动合并排序",
                ));
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
            calculation_rule: Value::Null,
            revision: 1,
            entity: "process_points".into(),
            operation: "update".into(),
            id: Some(1),
            values: json!({"name":"new"}),
            expected: Value::Null,
        }
    }
    #[test]
    fn identities_survive_insertion() {
        let a = document(&json!({"process_points":[{"id":2,"name":"two"}]}));
        let b = document(&json!({"process_points":[{"id":1,"name":"one"},{"id":2,"name":"two"}]}));
        assert_eq!(paths(&json_patch::diff(&a, &b)), vec!["/process_points/1"]);
    }
    #[test]
    fn disjoint_fields_merge_but_same_field_and_deletion_conflict() {
        let base = json!({"process_points":{"1":{"name":"old","flags":"0"},"11":{"name":"other"}}});
        let mut edited = base.clone();
        edited["process_points"]["1"]["name"] = json!("new");
        let patch = json_patch::diff(&base, &edited);
        let mut current = base.clone();
        current["process_points"]["1"]["flags"] = json!("1");
        current["process_points"]["11"]["name"] = json!("renamed");
        let merged = rebase(&base, &patch, &current, &change(), 2).unwrap();
        assert_eq!(
            merged["process_points"]["1"],
            json!({"name":"new","flags":"1"})
        );
        assert_eq!(merged["process_points"]["11"]["name"], "renamed");
        current["process_points"]["1"]["name"] = json!("competing");
        assert!(rebase(&base, &patch, &current, &change(), 2).is_err());
        current["process_points"]
            .as_object_mut()
            .unwrap()
            .remove("1");
        assert!(rebase(&base, &patch, &current, &change(), 2).is_err());
    }

    fn native_order(kind: &str) -> (Value, Change, json_patch::Patch) {
        let graph = json!({
            "project_config":{"board_types":[{"code":"DSP","point_storage":"native"}]},
            "process_points":[
                {"id":1,"project_id":1,"board_key":"DSP","group_key":"LOCAL","name":"one","display_order":1},
                {"id":2,"project_id":1,"board_key":"DSP","group_key":"LOCAL","name":"two","display_order":2}],
            "transmit_points":[
                {"id":1,"project_id":1,"board_key":"DSP","endpoint_key":"UPP_SERVICE","upp_model":99,"process_point_id":1,"name":"first output","display_order":1},
                {"id":2,"project_id":1,"board_key":"DSP","endpoint_key":"UPP_SERVICE","upp_model":99,"process_point_id":2,"name":"second output","display_order":2}]
        });
        let c = Change {
            calculation_rule: Value::Null,
            revision: 8,
            entity: "point_order".into(),
            operation: "reorder".into(),
            id: None,
            values: json!({"board_key":"DSP","kind":kind,"ids":[2,1]}),
            expected: json!([1, 2]),
        };
        let base = document(&graph);
        let mut edited = base.clone();
        let table = if kind == "process" {
            "process_points"
        } else {
            "transmit_points"
        };
        edited[table]["1"]["display_order"] = json!(2);
        edited[table]["2"]["display_order"] = json!(1);
        let patch = json_patch::diff(&base, &edited);
        (base, c, patch)
    }

    #[test]
    fn native_reorder_commits_at_same_revision_and_merges_unrelated_edits() {
        for kind in ["process", "forward"] {
            let (base, c, patch) = native_order(kind);
            let table = if kind == "process" {
                "process_points"
            } else {
                "transmit_points"
            };
            let merged = rebase(&base, &patch, &base, &c, 8).unwrap();
            assert_eq!(merged[table]["1"]["display_order"], 2);
            assert_eq!(merged[table]["2"]["display_order"], 1);
            let mut current = base.clone();
            current[table]["1"]["name"] = json!("renamed while ordering");
            let merged = rebase(&base, &patch, &current, &c, 9).unwrap();
            assert_eq!(merged[table]["1"]["name"], "renamed while ordering");
            assert_eq!(merged[table]["1"]["display_order"], 2);
        }
    }

    #[test]
    fn native_reorder_rejects_moved_deleted_and_reconfigured_records() {
        for (kind, field, value) in [
            ("process", "group_key", json!("OTHER")),
            ("forward", "endpoint_key", json!("OTHER_INTERFACE")),
            ("forward", "upp_model", json!(100)),
            ("forward", "process_point_id", json!(3)),
            ("forward", "board_key", json!("OTHER_BOARD")),
        ] {
            let (base, c, patch) = native_order(kind);
            let table = if kind == "process" {
                "process_points"
            } else {
                "transmit_points"
            };
            let mut current = base.clone();
            current[table]["1"][field] = value;
            assert!(
                rebase(&base, &patch, &current, &c, 9).is_err(),
                "{kind}/{field}"
            );
            current = base.clone();
            current[table].as_object_mut().unwrap().remove("1");
            assert!(rebase(&base, &patch, &current, &c, 9).is_err());
            current = base.clone();
            current["project_config"]["board_types"][0]
                .as_object_mut()
                .unwrap()
                .remove("point_storage");
            assert!(rebase(&base, &patch, &current, &c, 9).is_err());
        }
    }
}
