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
use sqlx::PgConnection;
use std::collections::BTreeSet;

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
        vec!["group_key", "group_id"]
    } else {
        vec![
            "endpoint_key",
            "upp_model",
            "endpoint_id",
            "context_id",
            "bank",
        ]
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

pub fn group_key(row: &Value, rule: &Value) -> Vec<String> {
    rule["group_by"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|key| row[key.as_str().unwrap()].to_string())
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
    rows.sort_by(|a, b| {
        let group_order = rule["group_by"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|key| {
                let key = key.as_str().unwrap();
                match (a[key].as_i64(), b[key].as_i64()) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    _ => a[key].to_string().cmp(&b[key].to_string()),
                }
            })
            .find(|order| !order.is_eq())
            .unwrap_or(std::cmp::Ordering::Equal);
        group_order
            .then_with(|| {
                a[column]
                    .as_i64()
                    .unwrap_or(i64::MAX)
                    .cmp(&b[column].as_i64().unwrap_or(i64::MAX))
            })
            .then_with(|| topology::num(a, "id").cmp(&topology::num(b, "id")))
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
    Path((pid, board_key, kind)): Path<(i64, String, String)>,
    Json(input): Json<Reorder>,
) -> Result<Json<Value>> {
    point_tables::entity(&kind)?;
    topology::preview(
        State(s),
        u,
        Path(pid),
        Json(Change {
            calculation_rule: Value::Null,
            revision: input.revision,
            expected: input.expected,
            entity: "point_order".into(),
            operation: "reorder".into(),
            id: None,
            values: json!({"board_key":board_key,"kind":kind,"ids":input.ids}),
        }),
    )
    .await
}

pub async fn apply(
    tx: &mut PgConnection,
    pid: i64,
    c: &Change,
    files: &ProjectFiles,
) -> Result<Value> {
    if c.operation != "reorder" {
        return Err(AppError::bad("排序操作无效"));
    }
    let board_key = c.values["board_key"]
        .as_str()
        .ok_or(AppError::bad("缺少板卡类型"))?;
    let kind = c.values["kind"]
        .as_str()
        .ok_or(AppError::bad("缺少点表类型"))?;
    point_tables::entity(kind)?;
    let definition = point_tables::board_definition(tx, pid, board_key, kind, files).await?;
    let rule = &definition["ordering"];
    if rule["mode"] != "display" {
        return Err(AppError::bad("点表仅支持显示顺序调整，通信偏移须显式编辑"));
    }
    let ids: Vec<i64> = serde_json::from_value(c.values["ids"].clone())
        .map_err(|_| AppError::bad("ids 必须为记录 ID 数组"))?;
    let unique: BTreeSet<i64> = ids.iter().copied().collect();
    if ids.len() < 2 || ids.len() != unique.len() {
        return Err(AppError::bad("排序至少需要两条记录，且 ID 不能重复"));
    }
    let mut rows = point_tables::table_rows(tx, pid, board_key, kind).await?;
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
    let table = point_tables::entity(kind)?;
    sqlx::query(&format!("UPDATE points.{table} t SET display_order=ordered.position FROM unnest($3::bigint[]) WITH ORDINALITY AS ordered(id,position) WHERE t.project_id=$1 AND t.board_key=$2 AND t.id=ordered.id"))
        .bind(pid).bind(board_key).bind(&ids).execute(&mut *tx).await?;
    Ok(json!({"board_key":board_key,"kind":kind,"mode":rule["mode"],"before_ids":before,"ids":ids}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_groups_use_json_keys_and_order_only_within_groups() {
        let rule = json!({"mode":"display","group_by":["group_key"]});
        assert!(validate_rule("process", &rule).is_ok());
        assert!(
            validate_rule(
                "process",
                &json!({"mode":"display","group_by":["group_key","group_key"]})
            )
            .is_err()
        );
        assert!(validate_rule("process", &json!({"mode":"protocol","group_by":[]})).is_err());
        let mut rows = vec![
            json!({"id":1,"group_key":"OTHER","display_order":1}),
            json!({"id":2,"group_key":"LOCAL","display_order":2}),
            json!({"id":3,"group_key":"LOCAL","display_order":1}),
        ];
        sort_rows(&mut rows, &rule);
        assert_eq!(
            rows.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
            vec![json!(3), json!(2), json!(1)]
        );
        assert_ne!(group_key(&rows[0], &rule), group_key(&rows[2], &rule));
    }

    #[test]
    fn upp_models_sort_numerically_without_changing_group_identity() {
        let rule = json!({"mode":"display","group_by":["endpoint_key","upp_model"]});
        let mut rows: Vec<_> = [103, 2, 100, 1, 99, 102].into_iter().map(|model|
            json!({"id":model,"endpoint_key":"UPP","upp_model":model,"display_order":1})
        ).collect();
        let original = group_key(&rows[0], &rule);
        sort_rows(&mut rows, &rule);
        assert_eq!(
            rows.iter()
                .map(|row| row["upp_model"].clone())
                .collect::<Vec<_>>(),
            vec![
                json!(1),
                json!(2),
                json!(99),
                json!(100),
                json!(102),
                json!(103)
            ]
        );
        assert_eq!(group_key(rows.last().unwrap(), &rule), original);
    }
}
