use crate::error::Result;
use serde_json::{Value, json};

pub fn generate(graph: &Value) -> Result<Value> {
    let report = crate::topology_validation::validate(graph);
    let blocked = report["errors"].as_u64().unwrap_or(1) > 0;
    let mut files = if blocked {
        Default::default()
    } else {
        crate::native_points::generate(&crate::table_runtime::effective(graph)?)?
    };
    if !blocked {
        for (board, data) in graph["derived_collections"]
            .as_object()
            .into_iter()
            .flatten()
        {
            let definition = crate::topology::rows(&graph["project_config"], "board_types")
                .iter()
                .find(|item| item["code"] == board.as_str())
                .unwrap_or(&Value::Null);
            files.insert(format!("board_types/{board}/collect.json"),serde_json::to_string_pretty(&json!({"version":1,"board_key":board,"derived":true,"groups":definition["point_groups"],"endpoints":definition["point_endpoints"],"mapping":data["mapping"],"points":data["rows"]}))?);
        }
        files.insert(
            "project.json".into(),
            serde_json::to_string_pretty(&graph["project_config"])?,
        );
        files.insert("topology.json".into(), serde_json::to_string_pretty(graph)?);
    }
    Ok(json!({"blocked":blocked,"validation":report,"files":files}))
}
