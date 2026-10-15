use crate::{
    error::Result,
    importer::ImportData,
    model::{Point, identifier, snake},
    topology::{self, Change, num, strv},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::{BTreeMap, BTreeSet};

async fn insert(tx: &mut Transaction<'_, Postgres>, pid: i64, t: &str, v: Value) -> Result<i64> {
    Ok(num(
        &topology::apply(
            tx,
            pid,
            &Change {
                revision: 0,
                entity: t.into(),
                operation: "create".into(),
                id: None,
                values: v,
            },
        )
        .await?,
        "id",
    ))
}
fn source_type(p: &Point) -> String {
    let v = &p.raw_json["source_definition"]["values"];
    if p.scope == "DSP" && p.data_type != "STRING" && strv(v, "C") == "Sys_F32" {
        "F32".into()
    } else {
        p.data_type.clone()
    }
}
async fn item(tx: &mut Transaction<'_, Postgres>, pid: i64, p: &Point) -> Result<i64> {
    let source_type = source_type(p);
    let id=insert(tx,pid,"data_items",json!({"name":p.name,"data_type":source_type,"byte_length":p.byte_length,"unit":p.unit,"default_value":p.default_value,"min_value":p.min_value,"max_value":p.max_value,"notes":p.notes})).await?;
    sqlx::query("UPDATE data_items SET source_sheet=$3,source_row=$4,raw_json=$5 WHERE project_id=$1 AND id=$2").bind(pid).bind(id).bind(&p.source_sheet).bind(p.source_row).bind(&p.raw_json).execute(&mut **tx).await?;
    Ok(id)
}
pub async fn import(
    tx: &mut Transaction<'_, Postgres>,
    pid: i64,
    data: &ImportData,
) -> Result<Value> {
    // Replacement is explicitly authorized by the import confirmation and is atomic.
    for t in [
        "signal_bindings",
        "board_links",
        "passthrough_routes",
        "signal_ranges",
        "signals",
        "device_contexts",
        "endpoints",
        "protocol_fields",
        "protocol_contracts",
        "signal_groups",
        "boards",
        "board_models",
        "data_items",
        "source_records",
        "change_previews",
        "platform_signals",
    ] {
        sqlx::query(&format!("DELETE FROM {t} WHERE project_id=$1"))
            .bind(pid)
            .execute(&mut **tx)
            .await?;
    }
    for (symbol, id) in &data.mappings {
        insert(
            tx,
            pid,
            "platform_signals",
            json!({"symbol":symbol,"signal_id":id}),
        )
        .await?;
    }
    let upm=insert(tx,pid,"board_models",json!({"code":"UPM_ARM","name":"UPM 控制板 / ARM","firmware_profile":"aidc","description":"本地信号、DSP 采集代理及 Modbus 转发；来自工作簿和 AIDC 设备配置"})).await?;
    let dsp=insert(tx,pid,"board_models",json!({"code":"DSP","name":"DSP 模块","firmware_profile":"contract","description":"共享 UPP 协议和源变量。工作簿未给出完整 DSP 固件 sigID，不从 ARM sigID 推断。"})).await?;
    let board = insert(
        tx,
        pid,
        "boards",
        json!({"model_id":upm,"code":"UPM_1","name":"UPM 控制板 1"}),
    )
    .await?;
    let local_group = insert(
        tx,
        pid,
        "signal_groups",
        json!({"model_id":upm,"code":"ARM_LOCAL","name":"ARM 本地信号"}),
    )
    .await?;
    let proxy_group = insert(
        tx,
        pid,
        "signal_groups",
        json!({"model_id":upm,"code":"DSP_PROXY","name":"ARM 内 DSP 数据代理（共享定义）"}),
    )
    .await?;
    let dsp_group = insert(
        tx,
        pid,
        "signal_groups",
        json!({"model_id":dsp,"code":"DSP_LOCAL","name":"DSP 源变量"}),
    )
    .await?;
    let local_ctx=insert(tx,pid,"device_contexts",json!({"model_id":upm,"group_id":local_group,"name":"ARM 本地","code":"CFG_DEV_LOCAL","dev_id":247,"kind":"local"})).await?;
    insert(tx,pid,"device_contexts",json!({"model_id":upm,"name":"虚拟转发服务","code":"CFG_DEV_VIR","dev_id":1,"kind":"virtual"})).await?;
    let dsp_ctx=insert(tx,pid,"device_contexts",json!({"model_id":dsp,"group_id":dsp_group,"name":"DSP 本地","code":"DSP_LOCAL","dev_id":247,"kind":"local"})).await?;
    let mb = insert(
        tx,
        pid,
        "protocol_contracts",
        json!({"code":"UPM_MODBUS","name":"UPM 北向 Modbus","protocol":"MODBUS"}),
    )
    .await?;
    let upp = insert(
        tx,
        pid,
        "protocol_contracts",
        json!({"code":"DSP_UPP","name":"DSP ↔ UPM UPP","protocol":"UPP"}),
    )
    .await?;
    let mb_ep=insert(tx,pid,"endpoints",json!({"model_id":upm,"contract_id":mb,"code":"NORTH_MODBUS","name":"北向 Modbus 服务","role":"server","transport":"RS485","port":"UART_PORT1"})).await?;
    let upm_ep=insert(tx,pid,"endpoints",json!({"model_id":upm,"contract_id":upp,"code":"DSP_COLLECT","name":"DSP UPP 采集","role":"client","transport":"CAN","port":"CAN_PORT1"})).await?;
    let dsp_ep=insert(tx,pid,"endpoints",json!({"model_id":dsp,"contract_id":upp,"code":"UPP_SERVICE","name":"UPP 对外接口","role":"server","transport":"CAN","port":""})).await?;
    let mut contexts = vec![];
    for (index, d) in data
        .devices
        .iter()
        .filter(|d| d["scope"] == "DSP")
        .enumerate()
    {
        let n = strv(d, "code")
            .strip_prefix("CFG_DEV_DSP")
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(index as i64 + 1);
        let child = insert(
            tx,
            pid,
            "boards",
            json!({"model_id":dsp,"code":format!("DSP_{n}"),"name":d["name"]}),
        )
        .await?;
        let ctx=insert(tx,pid,"device_contexts",json!({"model_id":upm,"group_id":proxy_group,"name":d["name"],"code":d["code"],"dev_id":10+n,"kind":"proxy"})).await?;
        contexts.push(ctx);
        // AIDC DSP addresses are configured separately from DP dev_id.
        insert(tx,pid,"board_links",json!({"name":format!("UPM → DSP{n}"),"client_board_id":board,"client_endpoint_id":upm_ep,"client_context_id":ctx,"server_board_id":child,"server_endpoint_id":dsp_ep,"remote_address":n,"dev_code":n})).await?;
        insert(tx,pid,"passthrough_routes",json!({"name":format!("DSP{n} 同步透传"),"server_endpoint_id":mb_ep,"client_endpoint_id":upm_ep,"context_id":ctx,"base_address":d["base_address"],"end_address":d["end_address"],"register_type":3,"writable":true,"callback":format!("upp_passthrough_dsp{n}_callback")})).await?;
    }
    let mut shared = BTreeMap::<String, i64>::new();
    let mut aliases = BTreeMap::<(String, i32), (i64, i64)>::new();
    let mut definitions = BTreeMap::new();
    let mut used_enums = BTreeSet::new();
    let mut collected = vec![];
    for p in &data.points {
        let resolved = p
            .signal_id
            .parse::<i32>()
            .ok()
            .filter(|n| *n > 0)
            .or_else(|| data.mappings.get(&p.signal_id).copied());
        if let Some(id) = resolved {
            let definition = json!([
                p.data_type,
                p.byte_length,
                p.default_value,
                p.min_value,
                p.max_value,
                p.flags,
                p.callback
            ]);
            if let Some(old) = definitions.insert((p.scope.clone(), id), definition.clone()) {
                if old != definition {
                    return Err(crate::error::AppError::bad(format!(
                        "{} 的 sigID {id} 有冲突的内部定义；请先统一别名的类型、范围和处理参数",
                        p.name
                    )));
                }
            }
        }
        let group = if p.scope == "LOCAL" {
            local_group
        } else {
            proxy_group
        };
        let existing = resolved.and_then(|id| aliases.get(&(p.scope.clone(), id)).copied());
        let (data_id, signal) = if let Some((data_id, signal)) = existing {
            (data_id, Some(signal))
        } else {
            let data_id = item(tx, pid, p).await?;
            let signal = if let Some(sig) = resolved {
                let en = if identifier(&p.enum_name)
                    && used_enums.insert((group, p.enum_name.clone()))
                {
                    p.enum_name.clone()
                } else {
                    format!("SIGNAL_{data_id}")
                };
                let s=insert(tx,pid,"signals",json!({"group_id":group,"data_item_id":data_id,"name":p.name,"enum_name":en,"sig_id":if data.mappings.contains_key(&p.signal_id){None}else{Some(sig)},"sig_symbol":if data.mappings.contains_key(&p.signal_id){Some(p.signal_id.clone())}else{None},"flags":p.flags,"callback":p.callback,"internal_type":if source_type(p)!=p.data_type {Some(&p.data_type)}else{None}})).await?;
                insert(tx,pid,"signal_ranges",json!({"signal_id":s,"boot_restore":false,"manual_restore":!p.default_value.is_empty()})).await?;
                aliases.insert((p.scope.clone(), sig), (data_id, s));
                Some(s)
            } else {
                None
            };
            (data_id, signal)
        };
        if p.scope == "DSP" {
            shared.insert(p.enum_name.clone(), data_id);
            let field=insert(tx,pid,"protocol_fields",json!({"contract_id":upp,"data_item_id":data_id,"name":p.name,"ordinal":p.ordinal,"access":if p.access.is_empty(){"RO"}else{&p.access},"model":p.upp_model.unwrap_or(0),"address_mode":if p.upp_offset.is_some(){"manual"}else{"auto"},"address":p.upp_offset,"scale":p.scale,"byte_order":0,"wire_type":if source_type(p)!=p.data_type {Some(&p.data_type)}else{None}})).await?;
            collected.push((field, signal, p));
        } else if p.address_mode != "none" {
            let field=insert(tx,pid,"protocol_fields",json!({"contract_id":mb,"data_item_id":data_id,"name":p.name,"ordinal":p.ordinal,"access":if p.access.is_empty(){"RO"}else{&p.access},"address_mode":if p.modbus_address.is_some(){"manual"}else{"auto"},"address":p.modbus_address,"register_type":if p.access=="RO"{4}else{3},"scale":p.scale})).await?;
            if let Some(signal) = signal {
                insert(tx,pid,"signal_bindings",json!({"endpoint_id":mb_ep,"context_id":local_ctx,"field_id":field,"signal_id":signal})).await?;
            }
        }
    }
    for (field, signal, p) in collected {
        if let Some(signal) = signal {
            for &ctx in &contexts {
                insert(tx,pid,"signal_bindings",json!({"endpoint_id":upm_ep,"context_id":ctx,"field_id":field,"signal_id":signal,"poll_interval":p.poll_interval,"set_priority":p.set_priority,"scan_priority":p.scan_priority})).await?;
            }
        }
    }
    // Preserve actual source rows separately from derived projection sheets.
    for r in &data.source_rows {
        let sheet = strv(r, "sheet");
        let active = [
            "DSP内部数据",
            "UPM-DSP手动配置数据",
            "UPM单板测点",
            "UPM-DSP采集数据",
            "UPM板内Modbus地址分配",
        ]
        .contains(&sheet);
        sqlx::query("INSERT INTO source_records(project_id,sheet,row_number,cells,classification) VALUES($1,$2,$3,$4,$5)").bind(pid).bind(sheet).bind(num(r,"row_number") as i32).bind(&r["cells"]).bind(if active{"linked"}else{"pending"}).execute(&mut **tx).await?;
        if sheet != "DSP内部数据" {
            continue;
        }
        let v = &r["cells"]["values"];
        let name = strv(v, "A");
        let en = snake(strv(v, "B"));
        if name.is_empty() || en.is_empty() {
            continue;
        }
        let data_id = if let Some(id) = shared.get(&en) {
            *id
        } else {
            let typ = strv(v, "C").trim_start_matches("Sys_").to_uppercase();
            let len = {
                strv(v, "F")
                    .parse::<i32>()
                    .ok()
                    .zip(strv(v, "G").parse::<i32>().ok())
                    .and_then(|(a, b)| a.checked_mul(b))
            };
            let Some(len) = len.filter(|n| *n > 0 && *n <= 65535) else {
                continue;
            };
            if !["U8", "U16", "S16", "U32", "S32", "F32"].contains(&typ.as_str()) {
                continue;
            }
            let p = Point {
                name: name.into(),
                data_type: if strv(v, "G").parse::<i32>().unwrap_or(1) > 1 {
                    "STRING".into()
                } else {
                    typ
                },
                byte_length: len,
                unit: strv(v, "L").into(),
                default_value: strv(v, "I").into(),
                min_value: strv(v, "K").into(),
                max_value: strv(v, "J").into(),
                source_sheet: sheet.into(),
                source_row: Some(num(r, "row_number") as i32),
                raw_json: r["cells"].clone(),
                ..Default::default()
            };
            item(tx, pid, &p).await?
        };
        if !used_enums.insert((dsp_group, en.clone())) {
            continue;
        }
        // EnumTab is not assumed to be a numeric sigID. Preserve it in source_records.
        insert(tx,pid,"signals",json!({"group_id":dsp_group,"data_item_id":data_id,"name":name,"enum_name":en,"process_enabled":false})).await?;
    }
    let _ = dsp_ctx;
    sqlx::query("UPDATE projects SET schema_version=2 WHERE id=$1")
        .bind(pid)
        .execute(&mut **tx)
        .await?;
    let config: Option<Value> =
        sqlx::query_scalar("SELECT topology_config FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut **tx)
            .await?;
    if let Some(config) = config {
        crate::project_config::apply(tx, pid, &config).await?;
    }
    let g = topology::snapshot(tx, pid, true).await?;
    Ok(crate::topology_validation::validate(&g))
}

pub async fn migrate_legacy(pool: &PgPool) -> anyhow::Result<()> {
    let pids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM projects WHERE schema_version=1 ORDER BY id")
            .fetch_all(pool)
            .await?;
    for pid in pids {
        let mut tx = pool.begin().await?;
        let version: i32 =
            sqlx::query_scalar("SELECT schema_version FROM projects WHERE id=$1 FOR UPDATE")
                .bind(pid)
                .fetch_one(&mut *tx)
                .await?;
        if version != 1 {
            tx.commit().await?;
            continue;
        }
        let data = async {
            let points: Vec<Value> = crate::db::all_json(
                &mut tx,
                "SELECT to_jsonb(p) FROM points p WHERE project_id=$1 ORDER BY scope,ordinal,id",
                pid,
            )
            .await?;
            let mappings = crate::db::all_json(
                &mut tx,
                "SELECT to_jsonb(m) FROM platform_signals m WHERE project_id=$1",
                pid,
            )
            .await?;
            let devices = crate::db::all_json(
                &mut tx,
                "SELECT to_jsonb(d) FROM devices d WHERE project_id=$1 ORDER BY code",
                pid,
            )
            .await?;
            let mut source_rows = if let Ok(bytes) = std::fs::read("UPM项目测点数据表.xlsx")
            {
                crate::importer::parse(bytes)
                    .ok()
                    .map(|x| x.source_rows)
                    .unwrap_or_default()
            } else {
                vec![]
            };
            let mut points: Vec<Point> = points
                .into_iter()
                .map(serde_json::from_value)
                .collect::<std::result::Result<_, _>>()?;
            // Only enrich recognized source rows; never replace saved project values with workbook values.
            let from_upm = points.iter().any(|p| p.source_sheet == "UPM-DSP采集数据");
            if !from_upm {
                source_rows.clear();
            }
            for p in &mut points {
                if p.source_sheet != "UPM-DSP采集数据" {
                    continue;
                }
                if let Some(row) = source_rows.iter().find(|r| {
                    r["sheet"] == "DSP内部数据"
                        && snake(strv(&r["cells"]["values"], "B")) == p.enum_name
                }) {
                    if p.data_type == "S32" && strv(&row["cells"]["values"], "C") == "Sys_F32" {
                        p.raw_json["source_definition"] = row["cells"].clone();
                    }
                }
            }
            let data = ImportData {
                points,
                mappings: mappings
                    .iter()
                    .map(|m| (strv(m, "symbol").to_owned(), num(m, "signal_id") as i32))
                    .collect(),
                devices,
                warnings: vec![],
                sheets: vec![],
                source_rows,
            };
            if !data.points.is_empty() {
                import(&mut tx, pid, &data).await?;
            } else {
                sqlx::query("UPDATE projects SET schema_version=2 WHERE id=$1")
                    .bind(pid)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("DELETE FROM import_previews WHERE project_id=$1")
                .bind(pid)
                .execute(&mut *tx)
                .await?;
            crate::db::touch(&mut tx, pid).await?;
            Ok::<_, crate::error::AppError>(())
        }
        .await;
        data.map_err(|e| anyhow::anyhow!("Project {pid} migration: {}", e.1))?;
        tx.commit().await?;
        tracing::info!(
            project = pid,
            "Legacy points migrated to board topology; flat source archive retained"
        );
    }
    Ok(())
}
