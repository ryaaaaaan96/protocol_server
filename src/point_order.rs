//! Table-specific ordering. Display positions never change protocol identities.
use crate::{
    AppState,
    auth::User,
    error::{AppError, Result},
    point_tables,
    project_files::ProjectFiles,
    topology::{self, Change},
};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::collections::{BTreeMap, BTreeSet};

pub fn validate_rule(kind: &str, rule: &Value) -> Result<()> {
    let object = rule
        .as_object()
        .ok_or(AppError::bad("ordering 必须为对象"))?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "mode" | "group_by"))
    {
        return Err(AppError::bad("ordering 只支持 mode 和 group_by"));
    }
    let mode = rule["mode"].as_str().unwrap_or("");
    if !["disabled", "display", "protocol"].contains(&mode)
        || (mode == "protocol" && kind != "forward")
    {
        return Err(AppError::bad(
            "排序模式须为 disabled/display；仅转发点表支持 protocol",
        ));
    }
    let group = rule["group_by"]
        .as_array()
        .ok_or(AppError::bad("ordering.group_by 必须为数组"))?;
    let allowed = if kind == "process" {
        vec!["group_id"]
    } else {
        vec!["endpoint_id", "context_id", "upp_model", "bank"]
    };
    let mut seen = BTreeSet::new();
    for key in group {
        let key = key
            .as_str()
            .ok_or(AppError::bad("排序分组必须为字段标识"))?;
        if !allowed.contains(&key) || !seen.insert(key) {
            return Err(AppError::bad("排序分组字段不支持或重复"));
        }
    }
    if mode == "protocol" && rule["group_by"] != json!(["endpoint_id", "upp_model", "bank"]) {
        return Err(AppError::bad(
            "protocol 必须按 endpoint_id、upp_model、bank 分组",
        ));
    }
    Ok(())
}

pub fn group_key(row: &Value, rule: &Value) -> Vec<i64> {
    rule["group_by"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|key| row[key.as_str().unwrap()].as_i64().unwrap_or(0))
        .collect()
}
pub fn sort_rows(rows: &mut [Value], rule: &Value) {
    if rule["mode"] == "disabled" {
        return;
    }
    let column = if rule["mode"] == "protocol" {
        "field_ordinal"
    } else {
        "display_order"
    };
    rows.sort_by_key(|r| {
        (
            group_key(r, rule),
            r[column].as_i64().unwrap_or(i64::MAX),
            topology::num(r, "id"),
        )
    });
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reorder {
    revision: i32,
    ids: Vec<i64>,
    #[serde(default)]
    expected: Value,
}
pub async fn preview(
    State(s): State<AppState>,
    u: User,
    Path((pid, mid, kind)): Path<(i64, i64, String)>,
    Json(input): Json<Reorder>,
) -> Result<Json<Value>> {
    point_tables::entity(&kind)?;
    topology::preview(
        State(s),
        u,
        Path(pid),
        Json(Change {
            revision: input.revision,
            expected: input.expected,
            entity: "point_order".into(),
            operation: "reorder".into(),
            id: Some(mid),
            values: json!({"model_id":mid,"kind":kind,"ids":input.ids}),
        }),
    )
    .await
}

pub async fn apply(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    c: &Change,
    files: &ProjectFiles,
) -> Result<Value> {
    if c.operation != "reorder" {
        return Err(AppError::bad("排序操作无效"));
    }
    let mid = c.values["model_id"]
        .as_i64()
        .ok_or(AppError::bad("缺少板卡类型"))?;
    let kind = c.values["kind"]
        .as_str()
        .ok_or(AppError::bad("缺少点表类型"))?;
    point_tables::entity(kind)?;
    let definition = point_tables::board_definition(tx, pid, mid, kind, files).await?;
    let rule = &definition["ordering"];
    if rule["mode"] == "disabled" {
        return Err(AppError::bad("此点表禁止手动排序"));
    }
    let ids: Vec<i64> = serde_json::from_value(c.values["ids"].clone())
        .map_err(|_| AppError::bad("ids 必须为记录 ID 数组"))?;
    let unique: BTreeSet<i64> = ids.iter().copied().collect();
    if ids.len() < 2 || ids.len() != unique.len() {
        return Err(AppError::bad("排序至少需要两条记录，且 ID 不能重复"));
    }
    let mut rows = point_tables::table_rows(tx, pid, mid, kind).await?;
    sort_rows(&mut rows, rule);
    let first = rows
        .iter()
        .find(|r| r["id"] == ids[0])
        .ok_or(AppError::bad("排序记录不属于当前板卡点表"))?;
    let group: Vec<&Value> = rows
        .iter()
        .filter(|r| group_key(r, rule) == group_key(first, rule))
        .collect();
    let expected: BTreeSet<i64> = group.iter().map(|r| topology::num(r, "id")).collect();
    if expected != unique {
        return Err(AppError::bad(
            "须提交同一分组的完整记录，不能跨组、遗漏或引用其他板卡记录",
        ));
    }
    let before: Vec<i64> = group.iter().map(|r| topology::num(r, "id")).collect();
    if before == ids {
        return Err(AppError::bad("顺序未改变"));
    }
    if rule["mode"] == "display" {
        let table = if kind == "process" {
            "signals"
        } else {
            "signal_bindings"
        };
        sqlx::query(&format!("UPDATE {table} t SET display_order=ordered.position FROM unnest($2::bigint[]) WITH ORDINALITY AS ordered(id,position) WHERE t.project_id=$1 AND t.id=ordered.id"))
            .bind(pid).bind(&ids).execute(&mut **tx).await?;
    } else {
        let by_id: BTreeMap<i64, &Value> =
            group.iter().map(|r| (topology::num(r, "id"), *r)).collect();
        let field_ids: Vec<i64> = ids
            .iter()
            .map(|id| topology::num(by_id[id], "field_id"))
            .collect();
        let fields:Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(f) FROM protocol_fields f WHERE project_id=$1 AND contract_id=$2 AND model=$3 AND CASE WHEN $4='UPP' THEN 0 ELSE register_type END=$5 ORDER BY ordinal,id")
            .bind(pid).bind(topology::num(first,"contract_id")).bind(topology::num(first,"upp_model"))
            .bind(first["protocol"].as_str().unwrap_or("")).bind(topology::num(first,"bank")).fetch_all(&mut **tx).await?;
        let required: BTreeSet<i64> = fields.iter().map(|f| topology::num(f, "id")).collect();
        if field_ids.len() != required.len()
            || field_ids.iter().copied().collect::<BTreeSet<_>>() != required
        {
            return Err(AppError::bad(
                "协议布局排序要求每个协议字段恰好绑定一次；当前存在未绑定字段或重复映射，请先整理协议字段",
            ));
        }
        check_anchors(&fields, &field_ids)?;
        sqlx::query("UPDATE protocol_fields f SET ordinal=(ordered.position-1)::int FROM unnest($2::bigint[]) WITH ORDINALITY AS ordered(id,position) WHERE f.project_id=$1 AND f.id=ordered.id")
            .bind(pid).bind(&field_ids).execute(&mut **tx).await?;
    }
    Ok(json!({"id":mid,"kind":kind,"mode":rule["mode"],"before_ids":before,"ids":ids}))
}

fn check_anchors(fields: &[Value], ids: &[i64]) -> Result<()> {
    let mut anchor = 0;
    let mut segments = BTreeMap::new();
    let manual: BTreeSet<i64> = fields
        .iter()
        .filter(|f| f["address_mode"] == "manual")
        .map(|f| topology::num(f, "id"))
        .collect();
    for field in fields {
        let id = topology::num(field, "id");
        if manual.contains(&id) {
            anchor = id;
        }
        segments.insert(id, anchor);
    }
    anchor = 0;
    for id in ids {
        if manual.contains(id) {
            anchor = *id;
        }
        if segments.get(id) != Some(&anchor) {
            return Err(AppError::bad(
                "不能跨越手动地址锚点排序；请在同一地址段内调整",
            ));
        }
    }
    // Manual anchors themselves must retain their original order.
    if ids
        .iter()
        .filter(|id| manual.contains(id))
        .copied()
        .collect::<Vec<_>>()
        != fields
            .iter()
            .filter(|f| f["address_mode"] == "manual")
            .map(|f| topology::num(f, "id"))
            .collect::<Vec<_>>()
    {
        return Err(AppError::bad("不能调整手动地址锚点的顺序"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rules_and_anchor_segments() {
        assert!(validate_rule("process", &json!({"mode":"protocol","group_by":[]})).is_err());
        assert!(
            validate_rule(
                "forward",
                &json!({"mode":"protocol","group_by":["endpoint_id","upp_model","bank"]})
            )
            .is_ok()
        );
        assert!(
            validate_rule(
                "process",
                &json!({"mode":"display","group_by":["group_id","group_id"]})
            )
            .is_err()
        );
        let fields = vec![
            json!({"id":1,"address_mode":"manual"}),
            json!({"id":2}),
            json!({"id":3}),
            json!({"id":4,"address_mode":"manual"}),
            json!({"id":5}),
        ];
        assert!(check_anchors(&fields, &[1, 3, 2, 4, 5]).is_ok());
        assert!(check_anchors(&fields, &[1, 2, 4, 3, 5]).is_err());
        assert!(check_anchors(&fields, &[4, 5, 1, 2, 3]).is_err());
    }
}
