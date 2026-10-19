use crate::{
    model::{flag_expression, identifier},
    topology::{find, num, rows, strv},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn add(
    out: &mut Vec<Value>,
    level: &str,
    entity: &str,
    v: &Value,
    code: &str,
    message: impl Into<String>,
    related: i64,
) {
    out.push(json!({"key":format!("{entity}:{}:{code}:{related}",v["id"]),"level":level,"entity":entity,"id":v["id"],"code":code,"message":message.into(),"name":v["name"],"related_id":related}));
}
fn shape(out: &mut Vec<Value>, entity: &str, v: &Value, typ: &str, len: i64) {
    let expected = match typ {
        "U8" => 1,
        "U16" | "S16" => 2,
        "U32" | "S32" | "F32" => 4,
        "STRING" => len,
        _ => 0,
    };
    if expected != len || len < 1 {
        add(
            out,
            "error",
            entity,
            v,
            "type_length",
            format!("{typ} 类型与 {len} 字节长度不一致"),
            0,
        );
    }
}
fn range(out: &mut Vec<Value>, entity: &str, v: &Value, typ: &str, len: i64) {
    let n = |k: &str| strv(v, k).parse::<f64>().ok();
    if typ == "STRING" {
        if ["min_value", "max_value"]
            .iter()
            .any(|key| !strv(v, key).trim().is_empty())
        {
            add(
                out,
                "error",
                entity,
                v,
                "string_bounds",
                "STRING 字符串类型不支持数值上下限",
                0,
            );
        }
        if strv(v, "default_value").len() > len as usize {
            add(
                out,
                "error",
                entity,
                v,
                "string_length",
                "默认字符串超过数据长度",
                0,
            );
        }
        return;
    }
    let limits = match typ {
        "U8" => Some((0., 255.)),
        "U16" => Some((0., 65535.)),
        "S16" => Some((-32768., 32767.)),
        "U32" => Some((0., 4294967295.)),
        "S32" => Some((-2147483648., 2147483647.)),
        "F32" => Some((-(f32::MAX as f64), f32::MAX as f64)),
        _ => None,
    };
    for k in ["default_value", "min_value", "max_value"] {
        let text = strv(v, k);
        if text.is_empty() {
            continue;
        }
        if let Some(value) = n(k) {
            if !value.is_finite()
                || limits.is_some_and(|(lo, hi)| value < lo || value > hi)
                || (typ != "F32" && value.fract() != 0.)
            {
                add(
                    out,
                    "error",
                    entity,
                    v,
                    &format!("numeric_{k}"),
                    format!("{k} 无法由 {typ} 表示"),
                    0,
                );
            }
        } else if !identifier(text) {
            add(
                out,
                "error",
                entity,
                v,
                &format!("expression_{k}"),
                format!("{k} 必须是数值或 C 宏标识符"),
                0,
            );
        }
    }
    if n("min_value")
        .zip(n("max_value"))
        .is_some_and(|(a, b)| a > b)
    {
        add(out, "error", entity, v, "range_order", "下限大于上限", 0);
    }
    if n("default_value").is_some_and(|d| {
        n("min_value").is_some_and(|a| d < a) || n("max_value").is_some_and(|b| d > b)
    }) {
        add(
            out,
            "warning",
            entity,
            v,
            "default_range",
            "默认值超出上下限，请核实源定义",
            0,
        );
    }
}
pub fn validate(g: &Value) -> Value {
    let mut out = Vec::new();
    for model in rows(g, "board_models") {
        if let Err(message) = crate::virtual_service::contexts(g, model) {
            add(
                &mut out,
                "error",
                "board_models",
                model,
                "virtual_service",
                message,
                0,
            );
        }
    }
    for d in rows(g, "data_items") {
        shape(
            &mut out,
            "data_items",
            d,
            strv(d, "data_type"),
            num(d, "byte_length"),
        );
        range(
            &mut out,
            "data_items",
            d,
            strv(d, "data_type"),
            num(d, "byte_length"),
        );
    }
    let mut identities = BTreeMap::new();
    let mut enums = BTreeMap::new();
    for s in rows(g, "v_signals") {
        shape(
            &mut out,
            "signals",
            s,
            strv(s, "data_type"),
            num(s, "byte_length"),
        );
        if s["process_enabled"] == true {
            if let Some((id, other)) = enums.insert(
                (num(s, "model_id"), strv(s, "enum_name")),
                (num(s, "resolved_sig_id"), num(s, "id")),
            ) {
                if id != num(s, "resolved_sig_id") {
                    add(
                        &mut out,
                        "error",
                        "signals",
                        s,
                        "enum_conflict",
                        "同一板卡的 C 枚举名对应不同 sigID",
                        other,
                    );
                }
            }
        }
        if !flag_expression(strv(s, "flags")) || !identifier(strv(s, "callback")) {
            add(
                &mut out,
                "error",
                "signals",
                s,
                "c_expression",
                "处理标志或回调标识符不合法",
                0,
            );
        }
        if let Some(id) = s["resolved_sig_id"].as_i64() {
            if let Some(other) = identities.insert((num(s, "group_id"), id), num(s, "id")) {
                add(
                    &mut out,
                    "error",
                    "signals",
                    s,
                    "sig_duplicate",
                    "同一信号组内 sigID 冲突",
                    other,
                );
            }
        } else if s["process_enabled"] == true {
            add(
                &mut out,
                "error",
                "signals",
                s,
                "sig_missing",
                "参与处理表的信号缺少有效 sigID",
                0,
            );
        }
        if s["process_enabled"] == true && num(s, "byte_length") > 255 {
            add(
                &mut out,
                "error",
                "signals",
                s,
                "abi_size",
                "AIDC 处理表的 sig_size 最大为 255 字节",
                0,
            );
        }
        range(
            &mut out,
            "signals",
            s,
            strv(s, "data_type"),
            num(s, "byte_length"),
        );
        if (s["manual_restore"] == true || s["boot_restore"] == true)
            && strv(s, "default_value").is_empty()
        {
            add(
                &mut out,
                "error",
                "signals",
                s,
                "restore_default",
                "启用默认值恢复时必须提供默认值",
                0,
            );
        }
    }
    for c in rows(g, "device_contexts") {
        if let Some(group) = find(g, "signal_groups", num(c, "group_id")) {
            if group["model_id"] != c["model_id"] {
                add(
                    &mut out,
                    "error",
                    "device_contexts",
                    c,
                    "owner",
                    "设备上下文和信号组不属于同一板卡模板",
                    0,
                );
            }
        }
    }
    for f in rows(g, "v_protocol_fields") {
        let len = num(f, "effective_length");
        shape(
            &mut out,
            "protocol_fields",
            f,
            strv(f, "effective_type"),
            len,
        );
        let start = num(f, "effective_address");
        if start < 0 || start + num(f, "address_length") > 65536 {
            add(
                &mut out,
                "error",
                "protocol_fields",
                f,
                "address_overflow",
                "协议地址或长度超出 16 位空间",
                0,
            );
        }
        if f["protocol"] == "MODBUS" && len % 2 != 0 {
            add(
                &mut out,
                "error",
                "protocol_fields",
                f,
                "alignment",
                "Modbus 字段需要明确偶数字节的线缆布局",
                0,
            );
        }
        if f["protocol"] == "UPP" && num(f, "model") == 0 {
            add(
                &mut out,
                "error",
                "protocol_fields",
                f,
                "model",
                "UPP 字段缺少模型号",
                0,
            );
        }
        for other in rows(g, "v_protocol_fields").iter().filter(|o| {
            num(o, "id") < num(f, "id")
                && o["contract_id"] == f["contract_id"]
                && o["model"] == f["model"]
                && (f["protocol"] == "UPP" || o["register_type"] == f["register_type"])
        }) {
            if start < num(other, "effective_address") + num(other, "address_length")
                && num(other, "effective_address") < start + num(f, "address_length")
            {
                add(
                    &mut out,
                    "error",
                    "protocol_fields",
                    f,
                    "overlap",
                    format!("与字段「{}」地址重叠", strv(other, "name")),
                    num(other, "id"),
                );
            }
        }
    }
    for b in rows(g, "signal_bindings") {
        let (Some(e), Some(c), Some(f), Some(s)) = (
            find(g, "endpoints", num(b, "endpoint_id")),
            find(g, "device_contexts", num(b, "context_id")),
            find(g, "v_protocol_fields", num(b, "field_id")),
            find(g, "v_signals", num(b, "signal_id")),
        ) else {
            continue;
        };
        if e["model_id"] != c["model_id"]
            || e["model_id"] != s["model_id"]
            || s["group_id"] != c["group_id"]
            || e["contract_id"] != f["contract_id"]
        {
            add(
                &mut out,
                "error",
                "signal_bindings",
                b,
                "scope",
                "绑定必须使用同板卡模板的设备上下文、所属信号和端点协议字段",
                0,
            );
        }
        if e["role"] == "server" {
            if let Some(other) = rows(g, "signal_bindings").iter().find(|o| {
                num(o, "id") < num(b, "id")
                    && o["endpoint_id"] == b["endpoint_id"]
                    && o["field_id"] == b["field_id"]
            }) {
                add(
                    &mut out,
                    "error",
                    "signal_bindings",
                    b,
                    "ambiguous_field",
                    "同一服务端协议字段不能绑定到多个设备数据",
                    num(other, "id"),
                );
            }
        }
        if s["data_type"] != f["effective_type"] || s["byte_length"] != f["effective_length"] {
            add(
                &mut out,
                "error",
                "signal_bindings",
                b,
                "shape",
                "内部信号和协议字段的类型或长度不同；需要同步定义或显式转换适配",
                0,
            );
        }
        if s["process_enabled"] != true && e["enabled"] == true {
            if find(g, "board_models", num(e, "model_id"))
                .is_some_and(|m| m["firmware_profile"] == "aidc")
            {
                add(
                    &mut out,
                    "error",
                    "signal_bindings",
                    b,
                    "process",
                    "普通采集/转发绑定必须指向参与处理表的信号；纯透传请使用透传路由",
                    0,
                );
            }
        }
    }
    for e in rows(g, "endpoints").iter().filter(|e| e["enabled"] == true) {
        if strv(e, "port").is_empty() || e["transport"] == "UNSPECIFIED" {
            add(
                &mut out,
                "warning",
                "endpoints",
                e,
                "port",
                "通信端口尚未配置，协议关系已保留",
                0,
            );
        }
    }
    for l in rows(g, "board_links") {
        let (Some(cb), Some(sb), Some(ce), Some(se), Some(ctx)) = (
            find(g, "boards", num(l, "client_board_id")),
            find(g, "boards", num(l, "server_board_id")),
            find(g, "endpoints", num(l, "client_endpoint_id")),
            find(g, "endpoints", num(l, "server_endpoint_id")),
            find(g, "device_contexts", num(l, "client_context_id")),
        ) else {
            continue;
        };
        if cb["model_id"] != ce["model_id"]
            || sb["model_id"] != se["model_id"]
            || ctx["model_id"] != cb["model_id"]
            || ce["contract_id"] != se["contract_id"]
            || ce["role"] != "client"
            || se["role"] != "server"
            || ce["transport"] != se["transport"]
        {
            add(
                &mut out,
                "error",
                "board_links",
                l,
                "endpoints",
                "连接两端必须属于对应板卡、使用同一协议契约及传输方式，并分别为采集端和服务端",
                0,
            );
        }
        for other in rows(g, "board_links")
            .iter()
            .filter(|o| num(o, "id") < num(l, "id"))
        {
            if other["client_board_id"] == l["client_board_id"]
                && other["client_endpoint_id"] == l["client_endpoint_id"]
                && other["remote_address"] == l["remote_address"]
                && other["dev_code"] == l["dev_code"]
            {
                add(
                    &mut out,
                    "error",
                    "board_links",
                    l,
                    "peer_address",
                    "同一采集端的通信地址和设备编码重复",
                    num(other, "id"),
                );
            }
        }
    }
    for r in rows(g, "passthrough_routes") {
        let (Some(se), Some(ce), Some(ctx)) = (
            find(g, "endpoints", num(r, "server_endpoint_id")),
            find(g, "endpoints", num(r, "client_endpoint_id")),
            find(g, "device_contexts", num(r, "context_id")),
        ) else {
            continue;
        };
        let a = find(g, "protocol_contracts", num(se, "contract_id"));
        let b = find(g, "protocol_contracts", num(ce, "contract_id"));
        if se["role"] != "server"
            || ce["role"] != "client"
            || a.is_none_or(|x| x["protocol"] != "MODBUS")
            || b.is_none_or(|x| x["protocol"] != "UPP")
            || se["model_id"] != ce["model_id"]
            || ctx["model_id"] != se["model_id"]
        {
            add(
                &mut out,
                "error",
                "passthrough_routes",
                r,
                "route_type",
                "透传路由必须连接同一板卡内的 Modbus 服务端与 UPP 采集端及设备上下文",
                0,
            );
        }
        for f in rows(g, "v_passthrough_fields")
            .iter()
            .filter(|f| f["route_id"] == r["id"])
        {
            if num(f, "effective_length") % 2 != 0
                || num(f, "register_address") + num(f, "register_length") - 1
                    > num(r, "end_address")
            {
                add(
                    &mut out,
                    "error",
                    "passthrough_routes",
                    r,
                    "window",
                    "透传字段长度非偶数或超出分配窗口",
                    num(f, "field_id"),
                );
            }
        }
        for other in rows(g, "passthrough_routes").iter().filter(|o| {
            num(o, "id") < num(r, "id") && o["server_endpoint_id"] == r["server_endpoint_id"]
        }) {
            if num(r, "base_address") <= num(other, "end_address")
                && num(other, "base_address") <= num(r, "end_address")
            {
                add(
                    &mut out,
                    "error",
                    "passthrough_routes",
                    r,
                    "overlap",
                    "同一服务端的透传地址窗口重叠",
                    num(other, "id"),
                );
            }
        }
        for f in rows(g, "v_protocol_fields")
            .iter()
            .filter(|f| f["contract_id"] == se["contract_id"])
        {
            if num(f, "effective_address") <= num(r, "end_address")
                && num(f, "effective_address") + num(f, "address_length") > num(r, "base_address")
            {
                add(
                    &mut out,
                    "error",
                    "passthrough_routes",
                    r,
                    "field_overlap",
                    "透传窗口与普通转发字段地址重叠",
                    num(f, "id"),
                );
            }
        }
    }
    out.extend(crate::project_config::relationship_issues(g));
    out.extend(crate::dsp_points::validate(g));
    let errors = out.iter().filter(|x| x["level"] == "error").count();
    json!({"errors":errors,"warnings":out.len()-errors,"issues":out,"point_count":rows(g,"data_items").len()})
}
