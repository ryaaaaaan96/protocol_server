//! AIDC forwarding uses a virtual service, not a second copy of process points.
use crate::topology::{num, rows};
use serde_json::{Value, json};

/// Resolve saved contexts plus the derived VIR registration. Never writes to storage.
pub fn contexts(g: &Value, model: &Value) -> Result<Vec<Value>, String> {
    let mut contexts: Vec<_> = rows(g, "device_contexts")
        .iter()
        .filter(|c| c["model_id"] == model["id"])
        .cloned()
        .collect();
    let needed = model["firmware_profile"] == "aidc"
        && rows(g, "endpoints")
            .iter()
            .any(|e| e["model_id"] == model["id"] && e["role"] == "server" && e["enabled"] == true);
    if !needed {
        return Ok(contexts);
    }
    let count = contexts.iter().filter(|c| c["kind"] == "virtual").count();
    if count > 1 {
        return Err("AIDC 对外服务只能使用一个 VIR 设备，请保留一个虚拟服务上下文".into());
    }
    if count == 1 {
        return Ok(contexts);
    }
    if contexts
        .iter()
        .any(|c| c["dev_id"] == 1 || c["code"] == "CFG_DEV_VIR")
    {
        return Err("自动 VIR 的 dev_id=1 或 CFG_DEV_VIR 已被其他设备占用，请调整冲突设备或显式配置虚拟服务".into());
    }
    contexts.push(json!({
        // Negative IDs are local generation keys; saved BIGSERIAL IDs are positive.
        "id": -num(model, "id"), "model_id": model["id"], "group_id": null,
        "name": "VIR · 虚拟转发服务", "code": "CFG_DEV_VIR", "dev_id": 1,
        "kind": "virtual", "generated": true
    }));
    Ok(contexts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> Value {
        json!({"id": 7, "firmware_profile": "aidc"})
    }
    fn graph() -> Value {
        json!({"device_contexts": [], "endpoints": [{"model_id": 7, "role": "server", "enabled": true}]})
    }

    #[test]
    fn derives_service_only_for_enabled_aidc_servers() {
        let mut g = graph();
        let original = g.clone();
        let resolved = contexts(&g, &model()).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0]["dev_id"], 1);
        assert!(resolved[0]["group_id"].is_null());
        assert_eq!(g, original);
        g["endpoints"][0]["enabled"] = json!(false);
        assert!(contexts(&g, &model()).unwrap().is_empty());
        g = graph();
        g["endpoints"][0]["role"] = json!("client");
        assert!(contexts(&g, &model()).unwrap().is_empty());
        assert!(
            contexts(&graph(), &json!({"id":7,"firmware_profile":"contract"}))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn preserves_explicit_service_and_rejects_ambiguity() {
        let mut g = graph();
        let saved = json!({"id":42,"model_id":7,"dev_id":9,"code":"CUSTOM_VIR","kind":"virtual"});
        g["device_contexts"] = json!([saved.clone()]);
        assert_eq!(contexts(&g, &model()).unwrap(), vec![saved.clone()]);
        g["device_contexts"].as_array_mut().unwrap().push(saved);
        assert!(contexts(&g, &model()).is_err());
    }

    #[test]
    fn rejects_collisions_without_changing_saved_contexts() {
        for (dev_id, code) in [(1, "LOCAL"), (247, "CFG_DEV_VIR")] {
            let mut g = graph();
            g["device_contexts"] =
                json!([{"id":2,"model_id":7,"dev_id":dev_id,"code":code,"kind":"local"}]);
            assert!(contexts(&g, &model()).is_err());
            g["device_contexts"][0]["model_id"] = json!(8);
            assert_eq!(contexts(&g, &model()).unwrap().len(), 1);
        }
    }
}
