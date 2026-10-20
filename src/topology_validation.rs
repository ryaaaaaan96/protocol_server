use serde_json::{Value, json};

pub fn validate(graph: &Value) -> Value {
    let (effective, mut issues) = match crate::table_runtime::effective(graph)
        .and_then(|effective| Ok((effective, crate::table_runtime::issues(graph)?)))
    {
        Ok(result) => result,
        Err(error) => (
            graph.clone(),
            vec![
                json!({"key":"table_behavior:invalid","level":"error","entity":"table_behavior","code":"script_runtime","message":error.1}),
            ],
        ),
    };
    issues.extend(crate::native_points::validate(&effective));
    issues.extend(crate::derived_collection::issues(graph));
    issues.extend(crate::point_subsets::validate(graph));
    if let Err(error) = crate::project_config::Config::parse(graph["project_config"].clone()) {
        issues.push(json!({"key":"project_config:invalid","level":"error","entity":"project_config","code":"invalid","message":error.1}));
    }
    let errors = issues
        .iter()
        .filter(|issue| issue["level"] == "error")
        .count();
    json!({"errors":errors,"warnings":issues.len()-errors,"issues":issues,"point_count":crate::topology::rows(graph,"process_points").len()})
}
