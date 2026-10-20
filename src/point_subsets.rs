//! JSON-declared collection subsets of another board's transmit endpoint.
use crate::{
    error::{AppError, Result},
    topology::{find, num, rows, strv},
};
use serde_json::{Value, json};
use sqlx::PgConnection;

// Receiver byte order, polling and scheduling belong to the collection endpoint.
const FIELDS: &[&str] = &[
    "upp_model",
    "address",
    "wire_type",
    "wire_length",
    "scale",
    "access",
];

fn same_layout(a: &Value, b: &Value) -> bool {
    FIELDS.iter().all(|key| {
        if *key == "scale" {
            a[*key].as_f64() == b[*key].as_f64()
        } else {
            a[*key] == b[*key]
        }
    })
}

fn relation<'a>(graph: &'a Value, collection: &Value) -> Option<&'a Value> {
    graph["project_config"]["board_types"]
        .as_array()?
        .iter()
        .find(|board| board["code"] == collection["board_key"])?["point_endpoints"]
        .as_array()?
        .iter()
        .find(|endpoint| endpoint["code"] == collection["endpoint_key"])?
        .get("subset_of")
        .filter(|value| value.is_object())
}

fn sources<'a>(graph: &'a Value, relation: &'a Value) -> impl Iterator<Item = &'a Value> {
    rows(graph, "transmit_points").iter().filter(move |source| {
        source["board_key"] == relation["board_key"]
            && source["endpoint_key"] == relation["endpoint_key"]
    })
}

pub fn validate(graph: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    for collection in rows(graph, "collect_points") {
        let Some(relation) = relation(graph, collection) else {
            continue;
        };
        let count = sources(graph, relation)
            .filter(|source| same_layout(source, collection))
            .count();
        if count != 1 {
            issues.push(json!({"key":format!("collect_points:{}:source_subset",num(collection,"id")),
                "level":"error","entity":"collect_points","id":collection["id"],"code":"source_subset",
                "message":format!("采集参数必须唯一对应 {} / {} 的一条转发记录；模型、地址、类型、字节数、精度和读写权限须一致",strv(relation,"board_key"),strv(relation,"endpoint_key"))}));
        }
    }
    issues
}

/// Match against the pre-change layout, then follow the source's stable record ID.
/// No extra stored identifier or migration is needed, and endpoint overlap checks
/// already require unique source layouts. Never choose an ambiguous source.
fn updates(before: &Value, after: &Value) -> Result<Vec<(i64, Value)>> {
    let mut updates = Vec::new();
    for collection in rows(after, "collect_points") {
        let Some(current_relation) = relation(after, collection) else {
            continue;
        };
        let Some(previous) = find(before, "collect_points", num(collection, "id")) else {
            continue;
        };
        if relation(before, previous) != Some(current_relation)
            || !same_layout(previous, collection)
        {
            continue;
        }
        let matches: Vec<_> = sources(before, current_relation)
            .filter(|source| same_layout(source, previous))
            .collect();
        if matches.len() != 1 {
            continue;
        }
        let Some(source) =
            sources(after, current_relation).find(|source| source["id"] == matches[0]["id"])
        else {
            let mut error = AppError::bad("转发记录仍被采集子集使用，请先移除对应采集记录");
            error.2 = Some(
                json!({"errors":[{"entity":"collect_points","id":collection["id"],"code":"source_subset","message":format!("采集记录 {} 仍引用源转发 {}，不能删除源记录或改变其端点",collection["id"],matches[0]["id"])}]}),
            );
            return Err(error);
        };
        if !same_layout(source, collection) {
            updates.push((
                num(collection, "id"),
                json!(
                    FIELDS
                        .iter()
                        .map(|field| ((*field).to_owned(), source[*field].clone()))
                        .collect::<serde_json::Map<_, _>>()
                ),
            ));
        }
    }
    Ok(updates)
}

pub async fn synchronize(tx: &mut PgConnection, pid: i64, before: &Value) -> Result<()> {
    if !before["project_config"]["board_types"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|board| {
            board["point_endpoints"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|endpoint| endpoint["subset_of"].is_object())
        })
    {
        return Ok(());
    }
    let after = crate::topology::snapshot(tx, pid, false).await?;
    for (id, fields) in updates(before, &after)? {
        sqlx::query("UPDATE points.collect_points SET (upp_model,address,wire_type,wire_length,scale,access)=(SELECT x.upp_model,x.address,x.wire_type,x.wire_length,x.scale,x.access FROM jsonb_populate_record(NULL::points.collect_points,$3) x) WHERE project_id=$1 AND id=$2")
            .bind(pid).bind(id).bind(fields).execute(&mut *tx).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn graph() -> Value {
        let layout = json!({"upp_model":1,"address":6,"wire_type":"U16","wire_length":2,"scale":1.0,"access":"RO"});
        let mut source = layout.clone();
        source["id"] = json!(10);
        source["board_key"] = json!("SOURCE_X");
        source["endpoint_key"] = json!("OUT");
        let mut receiver = layout;
        receiver["id"] = json!(20);
        receiver["board_key"] = json!("RECEIVER_Y");
        receiver["endpoint_key"] = json!("IN");
        receiver["poll_interval"] = json!(7);
        receiver["byte_order"] = json!(3);
        json!({"project_config":{"board_types":[{"code":"RECEIVER_Y","point_endpoints":[{"code":"IN","subset_of":{"board_key":"SOURCE_X","endpoint_key":"OUT"}}]}]},"transmit_points":[source],"collect_points":[receiver]})
    }
    #[test]
    fn subset_allows_unselected_sources_and_independent_receiver_settings() {
        let mut g = graph();
        let mut unselected = g["transmit_points"][0].clone();
        unselected["id"] = json!(11);
        unselected["address"] = json!(100);
        g["transmit_points"]
            .as_array_mut()
            .unwrap()
            .push(unselected);
        assert!(validate(&g).is_empty());
        assert!(updates(&g, &g).unwrap().is_empty());
        g["collect_points"][0]["wire_length"] = json!(4);
        assert_eq!(validate(&g).len(), 1);
    }
    #[test]
    fn follows_source_id_after_layout_changes_without_touching_receiver_settings() {
        let before = graph();
        let mut after = before.clone();
        after["transmit_points"][0]["address"] = json!(12);
        after["transmit_points"][0]["scale"] = json!(0.1);
        after["collect_points"][0]["poll_interval"] = json!(9);
        let planned = updates(&before, &after).unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].0, 20);
        assert_eq!(planned[0].1["address"], 12);
        for (key, value) in planned[0].1.as_object().unwrap() {
            after["collect_points"][0][key] = value.clone();
        }
        assert!(validate(&after).is_empty());
        assert_eq!(after["collect_points"][0]["poll_interval"], 9);
        assert_eq!(after["collect_points"][0]["byte_order"], 3);
    }
    #[test]
    fn source_address_swaps_follow_ids_and_removing_a_receiver_is_allowed() {
        let mut before = graph();
        let mut other = before["transmit_points"][0].clone();
        other["id"] = json!(11);
        other["address"] = json!(8);
        before["transmit_points"]
            .as_array_mut()
            .unwrap()
            .push(other);
        let mut after = before.clone();
        after["transmit_points"][0]["address"] = json!(8);
        after["transmit_points"][1]["address"] = json!(6);
        let planned = updates(&before, &after).unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].1["address"], 8);
        after["collect_points"] = json!([]);
        assert!(validate(&after).is_empty());
        assert!(updates(&before, &after).unwrap().is_empty());
    }
    #[test]
    fn rejects_deleted_ambiguous_or_wrong_endpoint_sources_and_never_rewrites_on_config_import() {
        let before = graph();
        let mut after = before.clone();
        after["transmit_points"] = json!([]);
        assert_eq!(validate(&after).len(), 1);
        assert!(updates(&before, &after).is_err());
        // Address reuse by another row must never silently rebind a receiver.
        after = before.clone();
        after["transmit_points"][0]["id"] = json!(11);
        assert!(validate(&after).is_empty());
        assert!(updates(&before, &after).is_err());
        let mut duplicate = before["transmit_points"][0].clone();
        duplicate["id"] = json!(11);
        after = before.clone();
        after["transmit_points"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert_eq!(validate(&after).len(), 1);
        assert!(updates(&after, &after).unwrap().is_empty());
        after = before.clone();
        after["transmit_points"][0]["endpoint_key"] = json!("OTHER");
        assert_eq!(validate(&after).len(), 1);
        let mut unlinked = before.clone();
        unlinked["project_config"] = json!({});
        after = before.clone();
        after["transmit_points"][0]["address"] = json!(20);
        assert!(updates(&unlinked, &after).unwrap().is_empty());
    }
}
