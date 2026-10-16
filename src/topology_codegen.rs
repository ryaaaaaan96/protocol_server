use crate::{
    codegen::{c_string, xml},
    error::{AppError, Result},
    model::c_type,
    topology::{find, num as n, rows, strv as s},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
fn comment(v: &Value) -> String {
    s(v, "name")
        .replace("*/", "* /")
        .replace(['\r', '\n', '\\'], " ")
}
fn array_name(g: &Value, id: i64) -> String {
    let x = find(g, "signal_groups", id).unwrap();
    match s(x, "code") {
        "ARM_LOCAL" => "g_arm_data_table".into(),
        "DSP_PROXY" => "g_dsp_data_table".into(),
        c => format!("g_{c}_data_table"),
    }
}
fn rw(v: &Value) -> &'static str {
    match s(v, "access") {
        "RO" => "R",
        "WO" => "W",
        _ => "RW",
    }
}
fn protocol_xml(fields: &[&Value], dev: i64) -> String {
    let mut x =
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<root><protocol DevCode=\"{dev}\">\n");
    let mut models = BTreeMap::<i64, Vec<&Value>>::new();
    for f in fields {
        models.entry(n(f, "model")).or_default().push(f);
    }
    for (m, fs) in models {
        x.push_str(&format!("<model Name=\"{m}\" No=\"{m}\" Type=\"YC\">\n"));
        for f in fs {
            let typ = match s(f, "effective_type") {
                "U8" => 2,
                "S16" => 3,
                "U16" => 4,
                "S32" => 5,
                "U32" => 6,
                "F32" => 9,
                _ => 12,
            };
            x.push_str(&format!("<point DataName=\"{}\" RegLen=\"{}\" OffsetAddr=\"{}\" OutDataType=\"{typ}\" RwMode=\"{}\" YXMerge=\"0\" ChgUpload=\"0\" />\n",xml(s(f,"name")),n(f,"effective_length"),n(f,"effective_address"),rw(f)));
        }
        x.push_str("</model>\n");
    }
    x.push_str("</protocol></root>\n");
    x
}
pub fn generate(g: &Value) -> Result<Value> {
    let mut report = crate::topology_validation::validate(g);
    let config = if g["project_config"].is_null() {
        None
    } else {
        Some(crate::project_config::Config::parse(
            g["project_config"].clone(),
        )?)
    };
    let targets: Vec<Value> = if let Some(config) = &config {
        config.board_types.iter().map(|t|{
            let model=rows(g,"board_models").iter().find(|m|m["code"]==t.model_code).ok_or(AppError::bad("项目配置引用的板卡模板不存在"))?;
            // Existing instance rows provide the board-local address/context template.
            // Export one configuration per type; multiplicities remain in project.json.
            let existing=rows(g,"boards").iter().find(|b|b["model_id"]==model["id"]);
            Ok(json!({"id":existing.map(|b|&b["id"]),"model_id":model["id"],"code":t.code,"name":t.name}))
        }).collect::<Result<Vec<_>>>()?
    } else {
        rows(g, "boards").to_vec()
    };
    if targets.is_empty() {
        return Err(AppError::bad("请先通过项目 JSON 配置板卡类型"));
    }
    let mut files = BTreeMap::<String, String>::new();
    files.insert("topology.json".into(), serde_json::to_string_pretty(g)?);
    if !g["project_config"].is_null() {
        files.insert(
            "project.json".into(),
            serde_json::to_string_pretty(&g["project_config"])?,
        );
    }
    for contract in rows(g, "protocol_contracts") {
        let fields: Vec<_> = rows(g, "v_protocol_fields")
            .iter()
            .filter(|f| f["contract_id"] == contract["id"])
            .collect();
        files.insert(
            format!("contracts/{}.json", s(contract, "code")),
            serde_json::to_string_pretty(&json!({"contract":contract,"fields":fields}))?,
        );
    }
    if n(&report, "errors") > 0 {
        return Ok(json!({"validation":report,"files":{},"blocked":true}));
    }
    for board in &targets {
        let model = find(g, "board_models", n(board, "model_id")).unwrap();
        let mid = n(model, "id");
        let prefix = format!(
            "{}/{}/",
            if config.is_some() {
                "board_types"
            } else {
                "boards"
            },
            s(board, "code")
        );
        let endpoints: Vec<_> = rows(g, "endpoints")
            .iter()
            .filter(|e| n(e, "model_id") == mid && e["enabled"] == true)
            .collect();
        let resolved_contexts =
            crate::virtual_service::contexts(g, model).map_err(AppError::bad)?;
        let contexts: Vec<_> = resolved_contexts.iter().collect();
        let links: Vec<_> = rows(g, "board_links")
            .iter()
            .filter(|l| l["client_board_id"] == board["id"])
            .collect();
        files.insert(format!("{prefix}connections.json"),serde_json::to_string_pretty(&json!({"board":board,"model":model,"endpoints":endpoints,"contexts":contexts,"links":links}))?);
        for ep in &endpoints {
            let contract = find(g, "protocol_contracts", n(ep, "contract_id")).unwrap();
            if contract["protocol"] == "UPP" {
                let mut fields: Vec<_> = rows(g, "v_protocol_fields")
                    .iter()
                    .filter(|f| f["contract_id"] == contract["id"])
                    .collect();
                fields.sort_by_key(|f| (n(f, "model"), n(f, "ordinal"), n(f, "id")));
                let dev = rows(g, "board_links")
                    .iter()
                    .find(|l| {
                        l["server_board_id"] == board["id"] && l["server_endpoint_id"] == ep["id"]
                    })
                    .map(|l| n(l, "dev_code"))
                    .unwrap_or(0);
                files.insert(
                    format!("{prefix}{}.xml", s(ep, "code")),
                    protocol_xml(&fields, if config.is_some() { 0 } else { dev }),
                );
            }
        }
        if model["firmware_profile"] != "aidc" {
            continue;
        }
        // The target ABI has one protocol table per kind on the virtual device.
        let mut kinds = BTreeSet::new();
        for ep in endpoints.iter().filter(|e| e["role"] == "server") {
            let p = s(
                find(g, "protocol_contracts", n(ep, "contract_id")).unwrap(),
                "protocol",
            );
            if !kinds.insert(p) || !contexts.iter().any(|c| c["kind"] == "virtual") {
                report["issues"].as_array_mut().unwrap().push(json!({"level":"error","entity":"endpoints","id":ep["id"],"name":ep["name"],"code":"firmware_profile","message":"AIDC 生成需要虚拟设备，且每个虚拟设备仅支持一张同类型服务端表；复杂多端口可先导出 contract 配置。"}));
            }
        }
        for ep in endpoints.iter().filter(|e| e["role"] == "client") {
            if !crate::model::identifier(s(ep, "port")) {
                report["issues"].as_array_mut().unwrap().push(json!({"level":"error","entity":"endpoints","id":ep["id"],"name":ep["name"],"code":"port","message":"AIDC 采集端口必须填写固件 C 标识符"}));
            }
        }
        let sigs: Vec<_> = rows(g, "v_signals")
            .iter()
            .filter(|s| n(s, "model_id") == mid && s["process_enabled"] == true)
            .collect();
        let banner = "/* Generated from normalized board configuration. Do not edit. */\n";
        let mut header = format!(
            "{banner}#pragma once\n#include \"data_process.h\"\n#include \"pub_sig_def.h\"\n"
        );
        let mut seen = BTreeMap::new();
        for sig in &sigs {
            if let Some(id) = seen.insert(s(sig, "enum_name"), n(sig, "resolved_sig_id")) {
                if id != n(sig, "resolved_sig_id") {
                    return Err(AppError::bad("同一板卡的枚举名对应多个 sigID"));
                }
                continue;
            }
            header.push_str(&format!(
                "enum {{ {} = {} }}; /* {} */\n",
                s(sig, "enum_name"),
                n(sig, "resolved_sig_id"),
                comment(sig)
            ));
        }
        files.insert(format!("{prefix}signal_id_map.h"), header);
        let mut process = format!(
            "{banner}#include \"data_process.h\"\n#include \"globalfunction.h\"\n#include \"local_equip.h\"\n#include \"dev_cfg.h\"\n#include \"signal_id_map.h\"\n"
        );
        for group in rows(g, "signal_groups")
            .iter()
            .filter(|v| n(v, "model_id") == mid)
        {
            let name = array_name(g, n(group, "id"));
            let mut ss: Vec<_> = sigs
                .iter()
                .copied()
                .filter(|v| v["group_id"] == group["id"])
                .collect();
            ss.sort_by_key(|v| n(v, "resolved_sig_id"));
            process.push_str(&format!("const DM_SIG_CFG_S {name}[] = {{\n"));
            for sig in &ss {
                process.push_str(&format!(" {{.sig_id={},.sig_size={},.sig_flag=({}),.data_type=DATA_TYPE_{},.pf_sig_proc={}}}, /* {} */\n",s(sig,"enum_name"),n(sig,"byte_length"),s(sig,"flags"),c_type(s(sig,"data_type")),s(sig,"callback"),comment(sig)));
            }
            if ss.is_empty() {
                process.push_str(" {0},\n");
            }
            process.push_str(&format!(
                "}};\nUINT16 get_{name}_len(void) {{ return {}; }}\n",
                ss.len()
            ));
        }
        files.insert(format!("{prefix}process.c"), process);
        let mut collect = format!(
            "{banner}#include \"arc_public.h\"\n#include \"data_process.h\"\n#include \"collect_lib.h\"\n#include \"upp_m_ex.h\"\n#include \"upp_public_ex.h\"\n#include \"signal_id_map.h\"\n"
        );
        let mut registrations = BTreeMap::<i64, Vec<(String, String, usize)>>::new();
        let mut device_port = BTreeMap::<i64, (String, i64, i64)>::new();
        let mut decoders = vec![];
        for ep in endpoints.iter().filter(|e| e["role"] == "client") {
            let contract = find(g, "protocol_contracts", n(ep, "contract_id")).unwrap();
            let protocol = s(contract, "protocol");
            let mut fs: Vec<_> = rows(g, "v_protocol_fields")
                .iter()
                .filter(|f| f["contract_id"] == contract["id"])
                .collect();
            fs.sort_by_key(|f| (n(f, "model"), n(f, "ordinal"), n(f, "id")));
            for link in links.iter().filter(|l| l["client_endpoint_id"] == ep["id"]) {
                let ctx = find(g, "device_contexts", n(link, "client_context_id")).unwrap();
                let cid = n(ctx, "id");
                if n(link, "remote_address") > 255 {
                    return Err(AppError::bad("AIDC DEV_TABLE_S 的采集地址最大为 255"));
                }
                if device_port
                    .insert(
                        cid,
                        (
                            s(ep, "port").into(),
                            n(link, "remote_address"),
                            n(link, "dev_code"),
                        ),
                    )
                    .is_some()
                {
                    return Err(AppError::bad("AIDC 同一 dev_id 不能注册多个独立采集端口"));
                }
                let name = format!("g_{}_{}", s(ep, "code"), s(ctx, "code"));
                let bs: Vec<_> = rows(g, "v_bindings")
                    .iter()
                    .filter(|b| b["endpoint_id"] == ep["id"] && b["context_id"] == ctx["id"])
                    .collect();
                let mut used: BTreeSet<i64> = sigs
                    .iter()
                    .filter(|sig| sig["group_id"] == ctx["group_id"])
                    .map(|s| n(s, "resolved_sig_id"))
                    .collect();
                let mut auto = 30000;
                let mut models = BTreeMap::<i64, Vec<(&Value, i64, Option<&Value>)>>::new();
                for f in &fs {
                    let binding = bs.iter().copied().find(|b| b["field_id"] == f["id"]);
                    let id = if let Some(b) = binding {
                        n(b, "resolved_sig_id")
                    } else {
                        while used.contains(&auto) {
                            auto += 1;
                        }
                        if auto > 65535 {
                            return Err(AppError::bad("采集解析 ID 空间已用尽"));
                        }
                        used.insert(auto);
                        let id = auto;
                        auto += 1;
                        id
                    };
                    models
                        .entry(n(f, "model"))
                        .or_default()
                        .push((f, id, binding));
                    decoders.push(json!({"endpoint":ep["code"],"context":ctx["code"],"field_id":f["id"],"decoder_id":id,"internal_signal":binding.map(|b|b["signal_id"].clone())}));
                }
                if protocol == "UPP" {
                    for (model, fields) in &models {
                        collect.push_str(&format!("const UPP_M_MOD_DATA {name}_{model}[] = {{\n"));
                        for (f, id, b) in fields {
                            let typ = c_type(s(f, "effective_type"));
                            let attr = |k: &str| b.map(|b| n(b, k)).unwrap_or(0);
                            collect.push_str(&format!(" {{.mod_data_offset={},.mod_data_len={},.mod_data_type=UPP_DATA_TYPE_{typ},.data_len={},.data_type=UPP_DATA_TYPE_{typ},.sig_id={id},.rw_mode=UPP_MODE_{},.byte_order={},.rqst_cyl={},.set_pri={},.scan_pri={},.dec_p={}}}, /* {} */\n",n(f,"effective_address"),n(f,"effective_length"),n(f,"effective_length"),rw(f),n(f,"byte_order"),attr("poll_interval"),attr("set_priority"),attr("scan_priority"),f["scale"],comment(f)));
                        }
                        collect.push_str("};\n");
                    }
                    collect.push_str(&format!("const UPP_M_MOD {name}_models[] = {{\n"));
                    for (m, fields) in &models {
                        collect.push_str(&format!(
                            " {{.p_data=(UPP_M_MOD_DATA*){name}_{m},.data_num={},.mod_id={m}}},\n",
                            fields.len()
                        ));
                    }
                    if models.is_empty() {
                        collect.push_str(" {0},\n");
                    }
                    collect.push_str(&format!("}};\nconst UPP_M_MOD_REG {name}_table = {{.p_model_ary=(UPP_M_MOD*){name}_models,.model_num={},.cfg_mode=UPP_CFG_MOD_DATAID}};\n",models.len()));
                    registrations.entry(cid).or_default().push((
                        "PRO_UPP_MASTER".into(),
                        format!("&{name}_table"),
                        fs.len(),
                    ));
                    if s(ep, "code") == "DSP_COLLECT" && s(ctx, "code") == "CFG_DEV_DSP1" {
                        collect.push_str(&format!("const UPP_M_MOD_REG g_dsp_upp_collect_table = {{.p_model_ary=(UPP_M_MOD*){name}_models,.model_num={},.cfg_mode=UPP_CFG_MOD_DATAID}};\n",models.len()));
                    }
                } else {
                    collect.push_str(&format!("const MODBUS_RTU_TABLE_S {name}_table[] = {{\n"));
                    for (f, id, b) in models.values().flatten() {
                        let attr = |k: &str| b.map(|b| n(b, k)).unwrap_or(0);
                        collect.push_str(&format!(" {{.sig_id={id},.reg_addr={},.reg_num={},.reg_type={},.rqst_cyl={},.flag={},.priority={},.data_type=DATA_TYPE_{},.byte_order={},.scan_pri={}}},\n",n(f,"effective_address"),n(f,"address_length"),n(f,"register_type"),attr("poll_interval"),if f["access"]=="RO"{0}else{6},attr("set_priority"),c_type(s(f,"effective_type")),n(f,"byte_order"),attr("scan_priority")));
                    }
                    if fs.is_empty() {
                        collect.push_str(" {0},\n");
                    }
                    collect.push_str("};\n");
                    registrations.entry(cid).or_default().push((
                        "PRO_MB_MASTER".into(),
                        format!("{name}_table"),
                        fs.len(),
                    ));
                }
            }
        }
        files.insert(format!("{prefix}collect.c"), collect);
        files.insert(
            format!("{prefix}collect_identity.json"),
            serde_json::to_string_pretty(&decoders)?,
        );
        let mut transmit = format!(
            "{banner}#include \"data_process.h\"\n#include \"transmit_lib.h\"\n#include \"upp_s_perf.h\"\n#undef UPP_S_SWT_IM_EN\n#define UPP_S_SWT_IM_EN 0\n#include \"upp_s_cfg.h\"\n#include \"signal_id_map.h\"\n"
        );
        let vir = contexts
            .iter()
            .find(|c| c["kind"] == "virtual")
            .map(|c| n(c, "id"));
        for ep in endpoints.iter().filter(|e| e["role"] == "server") {
            let contract = find(g, "protocol_contracts", n(ep, "contract_id")).unwrap();
            let name = format!("g_{}_transmit", s(ep, "code"));
            let mut bs: Vec<_> = rows(g, "v_bindings")
                .iter()
                .filter(|b| b["endpoint_id"] == ep["id"])
                .collect();
            bs.sort_by_key(|b| {
                (
                    n(b, "upp_model"),
                    n(b, "register_type"),
                    n(b, "effective_address"),
                )
            });
            if contract["protocol"] == "MODBUS" {
                transmit.push_str(&format!("const MB_TABLE_CELL_T {name}[] = {{\n"));
                for b in &bs {
                    transmit.push_str(&format!(" {{.dev_id={},.sig_id={},.reg_addr={},.reg_num={},.reg_type={},.byte_order={}}}, /* {} */\n",n(b,"dev_id"),n(b,"resolved_sig_id"),n(b,"effective_address"),n(b,"address_length"),n(b,"register_type"),n(b,"byte_order"),s(b,"field_name").replace("*/","* /")));
                }
                if bs.is_empty() {
                    transmit.push_str(" {0},\n");
                }
                transmit.push_str("};\n");
                if let Some(vid) = vir {
                    registrations.entry(vid).or_default().push((
                        "PRO_MB_SLAVE".into(),
                        name.clone(),
                        bs.len(),
                    ));
                }
            } else {
                let mut groups = BTreeMap::<i64, Vec<&Value>>::new();
                for b in &bs {
                    groups.entry(n(b, "upp_model")).or_default().push(b);
                }
                for (m, bs) in &groups {
                    transmit.push_str(&format!("const UPP_S_SIG_CFG {name}_{m}[] = {{\n"));
                    for b in bs {
                        transmit.push_str(&format!(" {{.dev_id={},.sig_id={},.data_len={},.data_type=UPP_DATA_TYPE_{},.rw_mode=UPP_MODE_{},.mod_data_offset={},.mod_data_len={},.mod_data_type=UPP_DATA_TYPE_{},.byte_order={},\n#if UPP_S_SWT_DEC_P_EN\n .dec_p={},\n#endif\n }},\n",n(b,"dev_id"),n(b,"resolved_sig_id"),n(b,"byte_length"),c_type(s(b,"data_type")),rw(b),n(b,"effective_address"),n(b,"effective_length"),c_type(s(b,"effective_type")),n(b,"byte_order"),b["scale"]));
                    }
                    transmit.push_str("};\n");
                }
                transmit.push_str(&format!("const UPP_S_TBL_MODEL_CFG {name}[] = {{\n"));
                for (m, bs) in &groups {
                    transmit.push_str(&format!(
                        " {{.model={m},.sig_num={},.p_sig_cfg=(UPP_S_SIG_CFG*){name}_{m}}},\n",
                        bs.len()
                    ));
                }
                if groups.is_empty() {
                    transmit.push_str(" {0},\n");
                }
                transmit.push_str("};\n");
                if let Some(vid) = vir {
                    registrations.entry(vid).or_default().push((
                        "PRO_UPP_SLAVE".into(),
                        name,
                        groups.len(),
                    ));
                }
            }
        }
        let routes: Vec<_> = rows(g, "passthrough_routes")
            .iter()
            .filter(|r| endpoints.iter().any(|e| e["id"] == r["server_endpoint_id"]))
            .collect();
        let mut route_header = format!("{banner}#pragma once\n#include \"transmit_lib.h\"\n");
        if !routes.is_empty() {
            transmit.push_str("#include \"passthrough_config.h\"\nconst MB_TABLE_SEG_T g_protocol_segments[] = {\n");
            for r in &routes {
                if !crate::model::identifier(s(r, "callback")) {
                    return Err(AppError::bad("透传路由需要目标工程的有效回调函数名"));
                }
                let ctx = find(g, "device_contexts", n(r, "context_id")).unwrap();
                let code = s(ctx, "code");
                route_header.push_str(&format!("#define ROUTE_{code}_BEGIN {}\n#define ROUTE_{code}_END {}\nINT32 {}(UINT16, MB_PKT_DATA_T *, UINT8 *, UINT16 *);\n",n(r,"base_address"),n(r,"end_address"),s(r,"callback")));
                transmit.push_str(&format!(
                    " {{.reg_addr={},.end_addr={},.func={}}},\n",
                    n(r, "base_address"),
                    n(r, "end_address"),
                    s(r, "callback")
                ));
            }
            transmit.push_str("};\n");
            if let Some(vid) = vir {
                registrations.entry(vid).or_default().push((
                    "PRO_ADDR_SLAVE".into(),
                    "g_protocol_segments".into(),
                    routes.len(),
                ));
            }
        }
        files.insert(format!("{prefix}transmit.c"), transmit);
        files.insert(format!("{prefix}passthrough_config.h"), route_header);
        files.insert(
            format!("{prefix}passthrough_fields.json"),
            serde_json::to_string_pretty(
                &rows(g, "v_passthrough_fields")
                    .iter()
                    .filter(|r| n(r, "model_id") == mid)
                    .collect::<Vec<_>>(),
            )?,
        );
        let mut cfg = format!(
            "{banner}#include \"data_process.h\"\n#include \"port.h\"\n#include \"process.c\"\n#include \"collect.c\"\n#include \"transmit.c\"\nconst DEV_TABLE_S CAST_DEV_TABLE_DEF[] = {{\n"
        );
        for ctx in &contexts {
            cfg.push_str(&format!(" {{.dev_id={},", n(ctx, "dev_id")));
            if let Some((port, addr, code)) = device_port.get(&n(ctx, "id")) {
                cfg.push_str(&format!(".port={port},.coll_addr={addr},.dev_code={code},"));
            }
            cfg.push_str(".ptl_tbl_cfg={\n");
            let mut count = 0;
            if !ctx["group_id"].is_null() {
                let sigcount = sigs
                    .iter()
                    .filter(|s| s["group_id"] == ctx["group_id"])
                    .count();
                cfg.push_str(&format!(
                    " {{.proto_type=PRO_DATA_PROCESS,.sig_num={sigcount},.pst_table=(VOID*){}}},\n",
                    array_name(g, n(ctx, "group_id"))
                ));
                count += 1;
            }
            if let Some(regs) = registrations.get(&n(ctx, "id")) {
                for (typ, ptr, len) in regs {
                    cfg.push_str(&format!(
                        " {{.proto_type={typ},.sig_num={len},.pst_table=(VOID*){ptr}}},\n"
                    ));
                    count += 1;
                }
            }
            if count > 7 {
                return Err(AppError::bad("设备点表注册数量超过 AIDC ABI 的 7 项限制"));
            }
            if count == 0 {
                cfg.push_str(" {0},\n");
            }
            cfg.push_str(" }},\n");
        }
        if contexts.is_empty() {
            cfg.push_str(" {0},\n");
        }
        cfg.push_str(&format!("}};\nconst DEV_TABLE_S *cfg_get_dev_table(void) {{ return CAST_DEV_TABLE_DEF; }}\nUINT16 cfg_dev_num(void) {{ return {}; }}\n",contexts.len()));
        files.insert(format!("{prefix}dev_cfg.c"), cfg);
        let mut range = format!(
            "{banner}#include \"signal_range.h\"\n#include \"globalfunction.h\"\n#include \"local_equip.h\"\n#include \"pub_sig_def.h\"\n#include \"signal_id_map.h\"\ntypedef struct {{UINT16 dev_id,sig_id,size; UINT8 boot,manual; DM_SIG_DATA_S values;}} RANGE_ROW;\n"
        );
        let mut rr: Vec<_> = contexts
            .iter()
            .flat_map(|ctx| {
                sigs.iter()
                    .filter(move |sig| sig["group_id"] == ctx["group_id"])
                    .map(move |sig| (*ctx, *sig))
            })
            .collect();
        rr.sort_by_key(|(c, s)| (n(c, "dev_id"), n(s, "resolved_sig_id")));
        for (ctx, sig) in &rr {
            if s(sig, "data_type") == "STRING" && !s(sig, "default_value").is_empty() {
                range.push_str(&format!(
                    "static const UINT8 range_{}_{}[{}]={};\n",
                    n(ctx, "dev_id"),
                    n(sig, "resolved_sig_id"),
                    n(sig, "byte_length"),
                    c_string(s(sig, "default_value"))
                ));
            }
        }
        range.push_str("static const RANGE_ROW ranges[]={\n");
        for (ctx, sig) in &rr {
            let typ = s(sig, "data_type");
            let member = match typ {
                "U8" => "u8",
                "U16" => "u16",
                "S16" => "s16",
                "U32" => "u32",
                "S32" => "s32",
                "F32" => "f32",
                _ => "pst",
            };
            range.push_str(&format!(
                " {{.dev_id={},.sig_id={},.size={},.boot={},.manual={},.values={{",
                n(ctx, "dev_id"),
                n(sig, "resolved_sig_id"),
                n(sig, "byte_length"),
                if sig["boot_restore"] == true { 1 } else { 0 },
                if sig["manual_restore"] == true { 1 } else { 0 }
            ));
            for (src, dst) in [
                ("default_value", "def_value"),
                ("min_value", "min_value"),
                ("max_value", "max_value"),
            ] {
                let value = s(sig, src);
                if !value.is_empty() {
                    if typ == "STRING" {
                        if src == "default_value" {
                            range.push_str(&format!(
                                ".{dst}.pst=(VOID*)range_{}_{},",
                                n(ctx, "dev_id"),
                                n(sig, "resolved_sig_id")
                            ));
                        }
                    } else {
                        range.push_str(&format!(".{dst}.{member}={value},"));
                    }
                }
            }
            if ["default_value", "min_value", "max_value"]
                .iter()
                .all(|k| s(sig, k).is_empty())
                || typ == "STRING" && s(sig, "default_value").is_empty()
            {
                range.push_str(".def_value.u32=0,");
            }
            range.push_str("}},\n");
        }
        if rr.is_empty() {
            range.push_str(" {0},\n");
        }
        range.push_str(&format!("}};\n#define RANGE_COUNT {}\n", rr.len()));
        range.push_str(r#"
VOID signal_range_init(VOID) {}
INT32 signal_range_get(UINT16 dev, UINT16 sig, DM_SIG_DATA_S *value, BOOLEAN *recover) {
 if (!value || !recover) return MPP_RET_ERR;
 INT32 lo=0,hi=(INT32)RANGE_COUNT-1; UINT32 key=((UINT32)dev<<16)|sig;
 *recover=FALSE; value->def_value.u32=0;value->min_value.u32=0;value->max_value.u32=0;
 while(lo<=hi){INT32 m=lo+(hi-lo)/2;const RANGE_ROW *r=&ranges[m];UINT32 k=((UINT32)r->dev_id<<16)|r->sig_id;
 if(k==key){*value=r->values;*recover=r->boot;return MPP_RET_OK;}if(k<key)lo=m+1;else hi=m-1;}
 return MPP_RET_OK;
}
INT32 signal_range_restore_default(VOID) {
 for (UINT32 i=0;i<RANGE_COUNT;i++){const RANGE_ROW *r=&ranges[i];if(r->manual){
  UINT8 *p=(UINT8*)&r->values.def_value;
  switch (((UINT32)r->dev_id<<16)|r->sig_id) {
"#);
        for (ctx, sig) in &rr {
            if s(sig, "data_type") == "STRING" && !s(sig, "default_value").is_empty() {
                range.push_str(&format!(
                    "case {}: p=(UINT8*)r->values.def_value.pst;break;\n",
                    (n(ctx, "dev_id") << 16) | n(sig, "resolved_sig_id")
                ));
            }
        }
        range.push_str("default:break;\n}\n set_dp_para_value(r->dev_id,r->sig_id,r->size,p);\n }}\n return MPP_RET_OK;\n}\n");
        files.insert(format!("{prefix}signal_range.c"), range);
        files.insert(format!("{prefix}signal_range.h"),"#pragma once\n#include \"data_process.h\"\nVOID signal_range_init(VOID);\nINT32 signal_range_get(UINT16,UINT16,DM_SIG_DATA_S*,BOOLEAN*);\nINT32 signal_range_restore_default(VOID);\n".into());
        files.insert(format!("{prefix}integration.txt"),"dev_cfg.c includes process.c, collect.c and transmit.c; compile dev_cfg.c once, and compile signal_range.c separately. Register cfg_get_dev_table, cfg_dev_num and signal_range_get using the platform callbacks. Address-segment callback bodies remain application code: include passthrough_config.h in those implementations and consume the generated bounds/layout; changing a route does not rewrite an existing hardcoded callback. Port drivers and the northern service initialization remain application responsibilities.\n".into());
    }
    let count = rows(&report, "issues")
        .iter()
        .filter(|i| i["level"] == "error")
        .count();
    report["errors"] = json!(count);
    Ok(
        json!({"validation":report,"files":if count==0{json!(files)}else{json!({})},"blocked":count>0}),
    )
}
