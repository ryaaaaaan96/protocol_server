use crate::error::Result;
use serde_json::{Value, json};

pub fn generate(graph: &Value) -> Result<Value> {
    let report = crate::topology_validation::validate(graph);
    let blocked = report["errors"].as_u64().unwrap_or(1) > 0;
    let mut files = if blocked {
        Default::default()
    } else {
        crate::native_points::generate(graph)
    };
    if !blocked {
        files.insert(
            "project.json".into(),
            serde_json::to_string_pretty(&graph["project_config"])?,
        );
        files.insert("topology.json".into(), serde_json::to_string_pretty(graph)?);
    }
    Ok(json!({"blocked":blocked,"validation":report,"files":files}))
}
