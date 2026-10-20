//! Native DSP point storage. Organization is read from the applied JSON config.
use crate::{
    dsp_workbook::DspImport,
    error::{AppError, Result},
    model::{flag_expression, identifier},
    topology::{Change, num, rows, strv},
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};

pub const PROCESS_COLUMNS: &str = "group_key,name,enum_name,sig_id,internal_type,element_count,byte_length,unit,default_value,min_value,max_value,boot_restore,manual_restore,process_enabled,flags,callback,notes,display_order,source_sheet,source_row,metadata";
pub const TRANSMIT_COLUMNS: &str = "process_point_id,endpoint_key,name,upp_model,address,wire_type,wire_length,scale,access,byte_order,conversion,enabled,display_order,source_sheet,source_row";
const PROCESS_EDIT: &str = "group_key,name,enum_name,sig_id,internal_type,element_count,byte_length,unit,default_value,min_value,max_value,boot_restore,manual_restore,process_enabled,flags,callback,notes";
const TRANSMIT_EDIT: &str = "process_point_id,endpoint_key,name,upp_model,address,wire_type,wire_length,scale,access,byte_order,conversion,enabled";

fn board_definition<'a>(g: &'a Value, key: &str) -> Option<&'a Value> {
    g["project_config"]["board_types"]
        .as_array()?
        .iter()
        .find(|b| b["code"] == key && b["point_storage"] == "native")
}

pub async fn native_board(
    tx: &mut PgConnection,
    pid: i64,
    board_key: &str,
) -> Result<Option<Value>> {
    let config: Option<Value> =
        sqlx::query_scalar("SELECT topology_config FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    Ok(config.and_then(|config| {
        config["board_types"]
            .as_array()?
            .iter()
            .find(|board| board["code"] == board_key && board["point_storage"] == "native")
            .cloned()
    }))
}

fn groups(board: &Value) -> Vec<Value> {
    board["point_groups"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn table(kind: &str) -> Result<&'static str> {
    match kind {
        "process" => Ok("points.process_points"),
        "forward" | "transmit" => Ok("points.transmit_points"),
        _ => Err(AppError::bad("此板卡尚未启用采集点表")),
    }
}

fn defaults(kind: &str) -> Value {
    if kind == "process" {
        json!({"group_key":"LOCAL","name":"","enum_name":"","sig_id":null,
            "internal_type":"U16","element_count":1,"byte_length":2,"unit":"",
            "default_value":"","min_value":"","max_value":"","boot_restore":false,
            "manual_restore":false,"process_enabled":true,"flags":"0","callback":"NULL",
            "notes":"","display_order":0,"source_sheet":"","source_row":null,"metadata":{}})
    } else {
        json!({"process_point_id":null,"endpoint_key":"UPP_SERVICE","name":"","upp_model":0,
            "address":6,"wire_type":"U16","wire_length":2,"scale":1,"access":"RO","byte_order":0,
            "conversion":"identity","enabled":true,"display_order":0,"source_sheet":"","source_row":null})
    }
}

fn columns(kind: &str) -> &'static str {
    if kind == "process" {
        PROCESS_COLUMNS
    } else {
        TRANSMIT_COLUMNS
    }
}

fn derive_length(point: &mut Value, supplied: Option<&Value>) -> Result<()> {
    let typ = strv(point, "internal_type");
    let Some(element_size) = size(typ) else {
        return Ok(());
    };
    let count = point["element_count"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or(AppError::bad("数组元素数必须为正整数"))?;
    let length = element_size
        .checked_mul(count)
        .filter(|n| *n <= 65535)
        .ok_or(AppError::bad("内部数据总字节数超出 1～65535 范围"))?;
    if supplied.is_some_and(|v| v.as_i64() != Some(length)) {
        return Err(AppError::bad(
            "固定类型字节数由内部类型和元素个数计算，不能单独修改",
        ));
    }
    point["byte_length"] = json!(length);
    Ok(())
}

async fn insert(
    tx: &mut PgConnection,
    pid: i64,
    board_key: &str,
    kind: &str,
    values: &Value,
) -> Result<Value> {
    let table = table(kind)?;
    let cols = columns(kind);
    let selected = cols
        .split(',')
        .map(|k| format!("x.{k}"))
        .collect::<Vec<_>>()
        .join(",");
    Ok(sqlx::query_scalar(&format!(
        "INSERT INTO {table} AS inserted(project_id,board_key,{cols}) SELECT $1,$2,{selected} FROM jsonb_populate_record(NULL::{table},$3) x RETURNING to_jsonb(inserted)"
    )).bind(pid).bind(board_key).bind(values).fetch_one(&mut *tx).await?)
}

pub async fn apply(
    tx: &mut PgConnection,
    pid: i64,
    board_key: &str,
    kind: &str,
    c: &Change,
) -> Result<Value> {
    let table = table(kind)?;
    let board = native_board(tx, pid, board_key)
        .await?
        .ok_or(AppError::not_found())?;
    let board_key = strv(&board, "code");
    let fields = c.values["fields"]
        .as_object()
        .ok_or(AppError::bad("点表字段必须为对象"))?;
    if !["create", "update", "delete"].contains(&c.operation.as_str()) {
        return Err(AppError::bad("点表操作无效"));
    }
    let mut allowed: BTreeSet<_> = if kind == "process" {
        PROCESS_EDIT
    } else {
        TRANSMIT_EDIT
    }
    .split(',')
    .collect();
    let dsp = crate::dsp_sheet::is_dsp(&board);
    let worksheet = kind == "process" && dsp;
    if worksheet {
        allowed.extend(crate::dsp_sheet::EDIT_FIELDS.split(','));
    }
    for key in fields.keys() {
        if !allowed.contains(key.as_str()) {
            return Err(AppError::bad(format!("{key} 是只读字段或不属于当前点表")));
        }
    }
    let old = if c.operation == "create" {
        defaults(kind)
    } else {
        sqlx::query_scalar::<_, Value>(&format!(
            "SELECT to_jsonb(t) FROM {table} t WHERE project_id=$1 AND board_key=$2 AND id=$3"
        ))
        .bind(pid)
        .bind(board_key)
        .bind(c.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::not_found())?
    };
    if c.operation == "delete" {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE project_id=$1 AND board_key=$2 AND id=$3"
        ))
        .bind(pid)
        .bind(board_key)
        .bind(c.id)
        .execute(&mut *tx)
        .await?;
        return Ok(old);
    }
    if fields.is_empty() {
        return Err(AppError::bad("未提供修改字段"));
    }
    let mut updates = if worksheet {
        crate::dsp_sheet::normalize(fields, &old)?
    } else {
        fields.clone()
    };
    let old_category = crate::dsp_sheet::category(&old).to_owned();
    let mut merged = old;
    if kind == "process" {
        for key in ["unit", "default_value", "min_value", "max_value", "notes"] {
            if updates.get(key).is_some_and(Value::is_null) {
                updates.insert(key.into(), json!(""));
            }
        }
    }
    merged.as_object_mut().unwrap().extend(updates.clone());
    if kind == "process" {
        derive_length(&mut merged, fields.get("byte_length"))?;
        updates.insert("byte_length".into(), merged["byte_length"].clone());
        if !groups(&board)
            .iter()
            .any(|g| g["code"] == merged["group_key"])
        {
            return Err(AppError::bad("点表分组不在已应用的板卡 JSON 配置中"));
        }
    } else {
        if !board["point_endpoints"]
            .as_array()
            .is_some_and(|endpoints| {
                endpoints.iter().any(|endpoint| {
                    endpoint["code"] == merged["endpoint_key"] && endpoint["protocol"] == "UPP"
                })
            })
        {
            return Err(AppError::bad("转发端点不在已应用 JSON 的 UPP 端点配置中"));
        }
        let point: Value = sqlx::query_scalar("SELECT to_jsonb(p) FROM points.process_points p WHERE project_id=$1 AND board_key=$2 AND id=$3")
            .bind(pid).bind(board_key).bind(merged["process_point_id"].as_i64()).fetch_optional(&mut *tx).await?
            .ok_or(AppError::bad("转发必须关联当前板卡的内部数据点"))?;
        if dsp {
            if fields
                .get("enabled")
                .is_some_and(|value| value != &json!(true))
            {
                return Err(AppError::bad(
                    "DSP 转发表中的记录全部参与转发，不再支持停用；不需要转发时请删除映射",
                ));
            }
            // Retain compatible storage columns without independent DSP meaning.
            // In particular, old clients cannot override the current source name.
            for (key, value) in [("name", point["name"].clone()), ("enabled", json!(true))] {
                updates.insert(key.into(), value.clone());
                merged[key] = value;
            }
            let model = require_upp_model(&point)?;
            if fields
                .get("upp_model")
                .is_some_and(|value| value.as_i64() != Some(model))
            {
                return Err(AppError::bad(format!(
                    "UPP 模型号由内部数据分类「{}」固定推导为 {model}，不能手动修改",
                    crate::dsp_sheet::category(&point)
                )));
            }
            updates.insert("upp_model".into(), json!(model));
            merged["upp_model"] = json!(model);
            if c.operation == "create" {
                let suggested = crate::dsp_sheet::wire_defaults(
                    &point,
                    fields.get("wire_type").and_then(Value::as_str),
                );
                for key in ["wire_type", "wire_length", "scale", "conversion"] {
                    if !fields.contains_key(key) {
                        merged[key] = suggested[key].clone();
                    }
                }
            }
        }
    }
    if c.operation == "create" {
        return insert(tx, pid, board_key, kind, &merged).await;
    }
    if worksheet && old_category != crate::dsp_sheet::category(&merged) {
        let linked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM points.transmit_points WHERE project_id=$1 AND board_key=$2 AND process_point_id=$3)")
            .bind(pid).bind(board_key).bind(c.id).fetch_one(&mut *tx).await?;
        if linked {
            let model = require_upp_model(&merged)?;
            // Keep offsets and all manually configured wire parameters unchanged.
            // Normal preview, authorization, validation and history see this update.
            sqlx::query("UPDATE points.transmit_points SET upp_model=$4 WHERE project_id=$1 AND board_key=$2 AND process_point_id=$3 AND upp_model<>$4")
                .bind(pid).bind(board_key).bind(c.id).bind(model).execute(&mut *tx).await?;
        }
    }
    let cols: Vec<_> = updates.keys().map(String::as_str).collect();
    let selected = cols
        .iter()
        .map(|k| format!("x.{k}"))
        .collect::<Vec<_>>()
        .join(",");
    let assigned = cols.join(",");
    Ok(sqlx::query_scalar(&format!(
        "UPDATE {table} t SET ({assigned})=(SELECT {selected} FROM jsonb_populate_record(NULL::{table},$4) x) WHERE project_id=$1 AND board_key=$2 AND id=$3 RETURNING to_jsonb(t)"
    )).bind(pid).bind(board_key).bind(c.id).bind(Value::Object(updates)).fetch_one(&mut *tx).await?)
}

fn require_upp_model(point: &Value) -> Result<i64> {
    crate::dsp_sheet::upp_model(point).ok_or(AppError::bad(
        "DSP 转发需要内部点具有有效的数据分类，请先设置数据分类",
    ))
}

pub async fn table_rows(
    tx: &mut PgConnection,
    pid: i64,
    board_key: &str,
    kind: &str,
) -> Result<Vec<Value>> {
    let board = native_board(tx, pid, board_key)
        .await?
        .ok_or(AppError::not_found())?;
    let board_key = strv(&board, "code");
    table(kind)?;
    let mut result: Vec<Value> = if kind == "process" {
        sqlx::query_scalar(r#"SELECT to_jsonb(p) || jsonb_build_object(
            'edit_values',to_jsonb(p),'data_type',p.internal_type,
            'resolved_sig_id',p.sig_id,
            'forward_count',(SELECT count(*) FROM points.transmit_points t WHERE t.project_id=p.project_id AND t.process_point_id=p.id))
            FROM points.process_points p WHERE p.project_id=$1 AND p.board_key=$2 ORDER BY p.display_order,p.id"#)
            .bind(pid).bind(board_key).fetch_all(&mut *tx).await?
    } else {
        sqlx::query_scalar(r#"SELECT to_jsonb(t) || jsonb_build_object(
            'edit_values',to_jsonb(t),'signal_name',p.name,'source_point',to_jsonb(p),
            'enum_name',p.enum_name,'resolved_sig_id',p.sig_id,'data_type',p.internal_type,
            'byte_length',p.byte_length,'element_count',p.element_count,'unit',p.unit,
            'group_key',p.group_key,'default_value',p.default_value,'min_value',p.min_value,'max_value',p.max_value,
            'field_name',t.name,'effective_address',t.address,'effective_type',t.wire_type,
            'effective_length',t.wire_length,'address_length',t.wire_length,
            'endpoint_name',t.endpoint_key,'protocol','UPP')
            FROM points.transmit_points t JOIN points.process_points p ON p.project_id=t.project_id AND p.board_key=t.board_key AND p.id=t.process_point_id
            WHERE t.project_id=$1 AND t.board_key=$2 ORDER BY t.display_order,t.id"#)
            .bind(pid).bind(board_key).fetch_all(&mut *tx).await?
    };
    let groups = groups(&board);
    for row in &mut result {
        if kind == "process" && crate::dsp_sheet::is_dsp(&board) {
            crate::dsp_sheet::project(row);
        }
        if kind != "process" {
            if let Some(point) = row.as_object_mut().unwrap().remove("source_point") {
                if crate::dsp_sheet::is_dsp(&board) {
                    crate::dsp_sheet::project_forward(row, &point);
                }
            }
            if let Some(endpoint) = board["point_endpoints"].as_array().and_then(|endpoints| {
                endpoints
                    .iter()
                    .find(|endpoint| endpoint["code"] == row["endpoint_key"])
            }) {
                row["endpoint_name"] = endpoint["name"].clone();
                row["protocol"] = endpoint["protocol"].clone();
            }
        }
        row["group_name"] = groups
            .iter()
            .find(|g| g["code"] == row["group_key"])
            .map(|g| g["name"].clone())
            .unwrap_or_else(|| row["group_key"].clone());
    }
    Ok(result)
}

pub async fn import(tx: &mut PgConnection, pid: i64, data: &DspImport) -> Result<()> {
    let config: Option<Value> =
        sqlx::query_scalar("SELECT topology_config FROM meta.project_state WHERE id=$1")
            .bind(pid)
            .fetch_one(&mut *tx)
            .await?;
    let Some(board) = config
        .as_ref()
        .and_then(|v| v["board_types"].as_array())
        .and_then(|bs| {
            bs.iter()
                .find(|b| b["point_storage"] == "native" && b["code"] == "DSP")
        })
    else {
        return Err(AppError::bad("DSP 工作簿导入需要已应用的 DSP 原生板卡配置"));
    };
    if data.process.is_empty() {
        return Err(AppError::bad("DSP 工作簿没有可导入的内部数据"));
    }
    // Import previews may have been created by an older server version.
    // Recheck fixed model rules before replacing any current rows.
    for mapping in &data.transmit {
        let point = data
            .process
            .iter()
            .find(|point| point["enum_name"] == mapping["process_enum"])
            .ok_or(AppError::bad("DSP 转发记录找不到对应内部点"))?;
        if mapping["upp_model"].as_i64() != Some(require_upp_model(point)?) {
            return Err(AppError::bad(format!(
                "转发字段 {} 的 UPP 模型号与内部数据分类不一致",
                strv(mapping, "name")
            )));
        }
    }
    let board_key = strv(board, "code");
    sqlx::query("DELETE FROM points.transmit_points WHERE project_id=$1 AND board_key=$2")
        .bind(pid)
        .bind(board_key)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM points.process_points WHERE project_id=$1 AND board_key=$2")
        .bind(pid)
        .bind(board_key)
        .execute(&mut *tx)
        .await?;
    let mut ids = BTreeMap::new();
    for point in &data.process {
        let mut values = defaults("process");
        for key in PROCESS_COLUMNS.split(',') {
            if let Some(value) = point.get(key) {
                values[key] = value.clone();
            }
        }
        if !groups(board)
            .iter()
            .any(|g| g["code"] == values["group_key"])
        {
            return Err(AppError::bad("工作簿内部数据的分组不在已应用配置中"));
        }
        let created = insert(tx, pid, board_key, "process", &values).await?;
        if ids
            .insert(
                strv(&created, "enum_name").to_owned(),
                (num(&created, "id"), created["name"].clone()),
            )
            .is_some()
        {
            return Err(AppError::bad("DSP 内部数据枚举重复，无法唯一匹配转发来源"));
        }
    }
    for point in &data.transmit {
        let mut values = defaults("forward");
        for key in TRANSMIT_COLUMNS.split(',') {
            if let Some(value) = point.get(key) {
                values[key] = value.clone();
            }
        }
        let (id, name) = ids.get(strv(point, "process_enum")).ok_or_else(|| {
            AppError::bad(format!(
                "转发字段 {} 找不到对应的 DSP 内部枚举",
                strv(point, "name")
            ))
        })?;
        values["process_point_id"] = json!(id);
        values["name"] = name.clone();
        values["enabled"] = json!(true);
        insert(tx, pid, board_key, "forward", &values).await?;
    }
    Ok(())
}

fn issue(out: &mut Vec<Value>, entity: &str, row: &Value, code: &str, message: &str, related: i64) {
    out.push(json!({"key":format!("{entity}:{}:{code}:{related}",row["id"]),"level":"error",
        "entity":entity,"id":row["id"],"name":row["name"],"code":code,"message":message,"related_id":related}));
}

fn size(typ: &str) -> Option<i64> {
    match typ {
        "U8" | "STRING" => Some(1),
        "U16" | "S16" => Some(2),
        "U32" | "S32" | "F32" => Some(4),
        _ => None,
    }
}

fn numeric_range(out: &mut Vec<Value>, row: &Value) {
    let typ = strv(row, "internal_type");
    let entity = "process_points";
    if typ == "STRING" {
        if !strv(row, "min_value").is_empty() || !strv(row, "max_value").is_empty() {
            issue(
                out,
                entity,
                row,
                "string_bounds",
                "STRING 不支持数值上下限",
                0,
            );
        }
        if strv(row, "default_value").len() as i64 > num(row, "byte_length") {
            issue(
                out,
                entity,
                row,
                "string_length",
                "默认字符串超过内部数据长度",
                0,
            );
        }
        return;
    }
    let limits = match typ {
        "U8" => (0., 255.),
        "U16" => (0., 65535.),
        "S16" => (-32768., 32767.),
        "U32" => (0., 4294967295.),
        "S32" => (-2147483648., 2147483647.),
        "F32" => (-(f32::MAX as f64), f32::MAX as f64),
        _ => return,
    };
    for key in ["default_value", "min_value", "max_value"] {
        let value = strv(row, key).trim();
        if value.is_empty() {
            continue;
        }
        match value.parse::<f64>() {
            Ok(n)
                if n.is_finite()
                    && n >= limits.0
                    && n <= limits.1
                    && (typ == "F32" || n.fract() == 0.) => {}
            Err(_) if identifier(value) => {
                let source_key = match key {
                    "default_value" => "I",
                    "min_value" => "K",
                    _ => "J",
                };
                issue(
                    out,
                    entity,
                    row,
                    &format!("symbol_{key}"),
                    "符号值尚未解析，无法确认其数值范围；请确认固件定义或填写具体数值",
                    0,
                );
                if row["metadata"]["source_cells"]["values"][source_key]
                    .as_str()
                    .is_some_and(|s| s.trim() == value)
                {
                    out.last_mut().unwrap()["level"] = json!("warning");
                }
            }
            _ => issue(
                out,
                entity,
                row,
                &format!("numeric_{key}"),
                &format!("{key} 无法由 {typ} 表示"),
                0,
            ),
        }
    }
    let number = |k| strv(row, k).parse::<f64>().ok();
    if number("min_value")
        .zip(number("max_value"))
        .is_some_and(|(lo, hi)| lo > hi)
    {
        issue(out, entity, row, "range_order", "下限大于上限", 0);
    }
    if number("default_value").is_some_and(|n| {
        number("min_value").is_some_and(|lo| n < lo) || number("max_value").is_some_and(|hi| n > hi)
    }) {
        issue(
            out,
            entity,
            row,
            "default_range",
            "默认值超出上下限，请核实源定义",
            0,
        );
        let original = &row["metadata"]["source_cells"]["values"];
        if [
            ("default_value", "I"),
            ("min_value", "K"),
            ("max_value", "J"),
        ]
        .iter()
        .all(|(key, column)| {
            original[column]
                .as_str()
                .is_some_and(|v| v.trim() == strv(row, key).trim())
        }) {
            out.last_mut().unwrap()["level"] = json!("warning");
        }
    }
}

pub fn validate(g: &Value) -> Vec<Value> {
    let mut out = vec![];
    for point in rows(g, "process_points") {
        let entity = "process_points";
        if let Some(board) = board_definition(g, strv(point, "board_key")) {
            if !groups(board)
                .iter()
                .any(|group| group["code"] == point["group_key"])
            {
                issue(
                    &mut out,
                    entity,
                    point,
                    "group",
                    "内部点的分组不在已应用 JSON 配置中",
                    0,
                );
            }
        } else {
            issue(
                &mut out,
                entity,
                point,
                "board",
                "内部点没有对应的原生板卡配置",
                0,
            );
        }
        let typ = strv(point, "internal_type");
        let count = num(point, "element_count");
        let length = num(point, "byte_length");
        if count < 1
            || count > 65535
            || length < 1
            || length > 65535
            || size(typ).and_then(|n| n.checked_mul(count)) != Some(length)
        {
            issue(
                &mut out,
                entity,
                point,
                "shape",
                "内部类型、元素个数与总字节数不一致",
                0,
            );
        }
        if !identifier(strv(point, "enum_name")) {
            issue(
                &mut out,
                entity,
                point,
                "enum",
                "枚举名必须是有效的 C 标识符",
                0,
            );
        }
        if !flag_expression(strv(point, "flags")) || !identifier(strv(point, "callback")) {
            issue(
                &mut out,
                entity,
                point,
                "handler",
                "处理标志或回调函数不是有效的 C 表达式/标识符",
                0,
            );
        }
        // The workbook has no confirmed DSP numeric sigIDs. Native definitions
        // and protocol JSON remain useful without inventing a firmware ABI.
        numeric_range(&mut out, point);
    }
    for t in rows(g, "transmit_points") {
        let entity = "transmit_points";
        let dsp = board_definition(g, strv(t, "board_key")).is_some_and(crate::dsp_sheet::is_dsp);
        if !board_definition(g, strv(t, "board_key"))
            .and_then(|board| board["point_endpoints"].as_array())
            .is_some_and(|endpoints| {
                endpoints.iter().any(|endpoint| {
                    endpoint["code"] == t["endpoint_key"] && endpoint["protocol"] == "UPP"
                })
            })
        {
            issue(
                &mut out,
                entity,
                t,
                "endpoint",
                "转发端点不在已应用 JSON 的 UPP 端点配置中",
                0,
            );
        }
        let Some(p) = rows(g, "process_points").iter().find(|p| {
            p["id"] == t["process_point_id"]
                && p["project_id"] == t["project_id"]
                && p["board_key"] == t["board_key"]
        }) else {
            issue(
                &mut out,
                entity,
                t,
                "reference",
                "转发字段未关联同一项目、板卡的内部点",
                0,
            );
            continue;
        };
        if dsp {
            let model = crate::dsp_sheet::upp_model(p);
            if model.is_none() || model != t["upp_model"].as_i64() {
                issue(
                    &mut out,
                    entity,
                    t,
                    "upp_model_category",
                    "DSP UPP 模型号必须由所关联内部点的有效数据分类固定推导",
                    num(p, "id"),
                );
            }
            let suggested = crate::dsp_sheet::wire_defaults(p, None);
            if t["wire_type"] != suggested["wire_type"] {
                issue(
                    &mut out,
                    entity,
                    t,
                    "wire_type_suggestion",
                    &format!(
                        "通信类型 {} 与 DateType / ArrayCnt 建议的 {} 不同；当前采用手动配置，请确认通信双方一致",
                        strv(t, "wire_type"),
                        strv(&suggested, "wire_type")
                    ),
                    num(p, "id"),
                );
                let warning = out.last_mut().unwrap();
                warning["level"] = json!("warning");
                warning["field"] = json!("wire_type");
                warning["recommended_wire_type"] = suggested["wire_type"].clone();
                warning["actual_wire_type"] = t["wire_type"].clone();
            }
        }
        let wire = strv(t, "wire_type");
        let length = num(t, "wire_length");
        if length < 1 || length > 65535 || (wire != "STRING" && size(wire) != Some(length)) {
            issue(
                &mut out,
                entity,
                t,
                "wire_shape",
                "通信类型与字节长度不一致",
                0,
            );
        }
        let scale = t["scale"].as_f64().unwrap_or(0.);
        if !scale.is_finite() || scale <= 0. {
            issue(&mut out, entity, t, "scale", "协议系数必须是有限正数", 0);
        }
        let matching = match strv(t, "conversion") {
            "identity" => {
                p["internal_type"] == t["wire_type"]
                    && p["byte_length"] == t["wire_length"]
                    && (num(p, "element_count") == 1 || wire == "STRING")
                    && scale == 1.
            }
            "fixed_point" => {
                p["internal_type"] == "F32"
                    && num(p, "element_count") == 1
                    && wire == "S32"
                    && length == 4
                    && num(p, "byte_length") == 4
            }
            "array_bytes" => {
                (num(p, "element_count") > 1 || p["internal_type"] == "STRING")
                    && wire == "STRING"
                    && p["byte_length"] == t["wire_length"]
                    && scale == 1.
            }
            _ => false,
        };
        if !matching {
            issue(
                &mut out,
                entity,
                t,
                "conversion",
                "内部点与通信字段不满足所选转换规则",
                num(p, "id"),
            );
        }
        let address = num(t, "address");
        if address < 0 || address.checked_add(length).is_none_or(|end| end > 65536) {
            issue(
                &mut out,
                entity,
                t,
                "address",
                "UPP 字段超出 16 位地址范围",
                0,
            );
        }
        if dsp || t["enabled"] == true {
            for other in rows(g, "transmit_points").iter().filter(|o| {
                num(o, "id") < num(t, "id")
                    && (dsp || o["enabled"] == true)
                    && o["project_id"] == t["project_id"]
                    && o["board_key"] == t["board_key"]
                    && o["endpoint_key"] == t["endpoint_key"]
                    && o["upp_model"] == t["upp_model"]
            }) {
                if address < num(other, "address") + num(other, "wire_length")
                    && num(other, "address") < address + length
                {
                    issue(
                        &mut out,
                        entity,
                        t,
                        "overlap",
                        "同一 UPP 端点和模型的字段地址重叠",
                        num(other, "id"),
                    );
                }
            }
        }
    }
    out
}

pub async fn history(
    tx: &mut PgConnection,
    pid: i64,
    user_id: i64,
    batch_label: &str,
    before: &Value,
    after: &Value,
) -> Result<()> {
    let mut changes = vec![];
    for (table, kind) in [
        ("process_points", "process"),
        ("transmit_points", "transmit"),
    ] {
        let b: BTreeMap<_, _> = rows(before, table)
            .iter()
            .map(|r| (num(r, "id"), r))
            .collect();
        let a: BTreeMap<_, _> = rows(after, table)
            .iter()
            .map(|r| (num(r, "id"), r))
            .collect();
        for id in b.keys().chain(a.keys()).copied().collect::<BTreeSet<_>>() {
            let old = b.get(&id).copied();
            let new = a.get(&id).copied();
            if old == new {
                continue;
            }
            let row = new.or(old).unwrap();
            let group = if kind == "process" {
                row["group_key"].clone()
            } else {
                rows(after, "process_points")
                    .iter()
                    .chain(rows(before, "process_points"))
                    .find(|p| p["id"] == row["process_point_id"])
                    .map(|p| p["group_key"].clone())
                    .unwrap_or(Value::Null)
            };
            changes.push(json!({"entity_type":kind,"record_id":id,"board_key":row["board_key"],"group_key":group,
                "action":if old.is_none(){"insert"}else if new.is_none(){"delete"}else{"update"},
                "before_data":old,"after_data":new}));
        }
    }
    if changes.is_empty() {
        return Ok(());
    }
    let count = changes.len() as u64;
    let result = sqlx::query(r#"WITH batch AS (SELECT gen_random_uuid() AS id), actor AS (SELECT current_setting('app.actor_name',true) AS display_name)
        INSERT INTO history.events(kind,project_id,batch_id,batch_label,entity,entity_type,record_id,board_key,group_key,action,before_data,after_data,actor_id,actor_name,project_revision,config_snapshot)
        SELECT 'point',$1,batch.id,$3,c.entity_type,c.entity_type,c.record_id,c.board_key,c.group_key,c.action,
            NULLIF(c.before_data,'null'::jsonb),NULLIF(c.after_data,'null'::jsonb),$2,actor.display_name,p.revision,
            jsonb_build_object('before',$5::jsonb,'after',p.topology_config)
        FROM jsonb_to_recordset($4) AS c(entity_type text,record_id bigint,board_key text,group_key text,action text,before_data jsonb,after_data jsonb)
        CROSS JOIN batch CROSS JOIN actor JOIN meta.project_state p ON p.id=$1"#)
        .bind(pid).bind(user_id).bind(batch_label).bind(json!(changes)).bind(&before["project_config"]).execute(&mut *tx).await?;
    if result.rows_affected() != count {
        return Err(AppError::bad("操作者或项目状态无效，无法完整保存点表历史"));
    }
    Ok(())
}

pub fn generate(g: &Value) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let Some(boards) = g["project_config"]["board_types"].as_array() else {
        return files;
    };
    for board in boards.iter().filter(|b| b["point_storage"] == "native") {
        let code = strv(board, "code");
        let mut process: Vec<_> = rows(g, "process_points")
            .iter()
            .filter(|p| p["board_key"] == code)
            .cloned()
            .collect();
        process.sort_by_key(|p| {
            (
                strv(p, "group_key").to_owned(),
                num(p, "display_order"),
                num(p, "id"),
            )
        });
        let mut transmit: Vec<_> = rows(g, "transmit_points")
            .iter()
            .filter(|p| p["board_key"] == code)
            .cloned()
            .collect();
        if crate::dsp_sheet::is_dsp(board) {
            for mapping in &mut transmit {
                mapping["enabled"] = json!(true);
                if let Some(point) = process.iter().find(|point| {
                    point["id"] == mapping["process_point_id"]
                        && point["project_id"] == mapping["project_id"]
                }) {
                    mapping["name"] = point["name"].clone();
                }
            }
        }
        transmit.sort_by_key(|t| {
            (
                strv(t, "endpoint_key").to_owned(),
                num(t, "upp_model"),
                num(t, "address"),
                num(t, "id"),
            )
        });
        files.insert(
            format!("board_types/{code}/process.json"),
            serde_json::to_string_pretty(
                &json!({"version":1,"board_key":code,"groups":groups(board),"points":process}),
            )
            .unwrap(),
        );
        files.insert(format!("board_types/{code}/transmit.json"),serde_json::to_string_pretty(&json!({"version":1,"board_key":code,"protocol":"UPP","conversion_rules":{"identity":"wire = internal","fixed_point":"wire = round(internal / scale); internal = wire * scale","array_bytes":"preserve the declared element representation and total byte length"},"points":transmit})).unwrap());
        let mut endpoints: BTreeMap<String, BTreeMap<i64, Vec<&Value>>> = board["point_endpoints"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|endpoint| endpoint["protocol"] == "UPP")
            .map(|endpoint| (strv(endpoint, "code").to_owned(), BTreeMap::new()))
            .collect();
        for point in &transmit {
            if point["enabled"] == true {
                endpoints
                    .entry(strv(point, "endpoint_key").to_owned())
                    .or_default()
                    .entry(num(point, "upp_model"))
                    .or_default()
                    .push(point);
            }
        }
        for (endpoint, models) in endpoints {
            let mut xml = String::from(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<root><protocol DevCode=\"0\">\n",
            );
            for (model, points) in models {
                xml.push_str(&format!(
                    "<model Name=\"{model}\" No=\"{model}\" Type=\"YC\">\n"
                ));
                for point in points {
                    let typ = match strv(point, "wire_type") {
                        "U8" => 2,
                        "S16" => 3,
                        "U16" => 4,
                        "S32" => 5,
                        "U32" => 6,
                        "F32" => 9,
                        _ => 12,
                    };
                    let rw = match strv(point, "access") {
                        "RO" => "R",
                        "WO" => "W",
                        _ => "RW",
                    };
                    xml.push_str(&format!("<point DataName=\"{}\" RegLen=\"{}\" OffsetAddr=\"{}\" OutDataType=\"{typ}\" RwMode=\"{rw}\" YXMerge=\"0\" ChgUpload=\"0\" />\n",crate::codegen::xml(strv(point,"name")),num(point,"wire_length"),num(point,"address")));
                }
                xml.push_str("</model>\n");
            }
            xml.push_str("</protocol></root>\n");
            files.insert(format!("board_types/{code}/{endpoint}.xml"), xml);
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph() -> Value {
        let mut point = defaults("process");
        point.as_object_mut().unwrap().extend(
            json!({"id":1,"project_id":7,"board_key":"DSP","name":"母线电压",
                "enum_name":"DC_BUS_VOLTAGE","internal_type":"F32","byte_length":4,
                "metadata":{"category":"任务级观测量","display_digits":2}})
            .as_object()
            .unwrap()
            .clone(),
        );
        let mut transmit = defaults("forward");
        transmit.as_object_mut().unwrap().extend(
            json!({"id":1,"project_id":7,"board_key":"DSP","name":"母线电压输出",
                "process_point_id":1,"upp_model":99,"wire_type":"S32","wire_length":4,
                "scale":0.01,"conversion":"fixed_point"})
            .as_object()
            .unwrap()
            .clone(),
        );
        json!({"project_config":{"board_types":[{"code":"DSP","point_storage":"native",
            "point_groups":[{"code":"LOCAL","name":"本地数据"}],
            "point_endpoints":[{"code":"UPP_SERVICE","name":"DSP UPP服务","protocol":"UPP"}]}]},"process_points":[point],"transmit_points":[transmit]})
    }

    #[test]
    fn native_contract_accepts_explicit_conversion_and_many_outputs() {
        let mut g = graph();
        let mut second = g["transmit_points"][0].clone();
        second["id"] = json!(2);
        second["address"] = json!(20);
        second["enabled"] = json!(false);
        g["transmit_points"].as_array_mut().unwrap().push(second);
        assert!(validate(&g).is_empty());
        g["process_points"][0]["name"] = json!("新的内部名称");
        assert!(validate(&g).is_empty());
        let files = generate(&g);
        assert_eq!(
            files["board_types/DSP/UPP_SERVICE.xml"]
                .matches("<point ")
                .count(),
            2
        );
        assert!(files["board_types/DSP/transmit.json"].contains("fixed_point"));
        assert!(files["board_types/DSP/process.json"].contains("新的内部名称"));
        assert_eq!(
            files["board_types/DSP/UPP_SERVICE.xml"]
                .matches("DataName=\"新的内部名称\"")
                .count(),
            2
        );
        let exported: Value =
            serde_json::from_str(&files["board_types/DSP/transmit.json"]).unwrap();
        assert!(
            exported["points"]
                .as_array()
                .unwrap()
                .iter()
                .all(|point| { point["name"] == "新的内部名称" && point["enabled"] == true })
        );
        assert_eq!(g["transmit_points"][1]["enabled"], false);
        assert_eq!(g["transmit_points"][1]["name"], "母线电压输出");
    }

    #[test]
    fn forwarding_requires_an_applied_upp_endpoint() {
        let mut g = graph();
        assert!(validate(&g).is_empty());
        g["transmit_points"][0]["endpoint_key"] = json!("MISSING");
        assert!(validate(&g).iter().any(|issue| issue["code"] == "endpoint"));
        g["transmit_points"][0]["endpoint_key"] = json!("UPP_SERVICE");
        g["project_config"]["board_types"][0]["point_endpoints"][0]["protocol"] = json!("MODBUS");
        assert!(validate(&g).iter().any(|issue| issue["code"] == "endpoint"));
    }

    #[test]
    fn native_contract_rejects_ambiguous_or_foreign_mappings() {
        let original = graph();
        let mut foreign = original.clone();
        foreign["transmit_points"][0]["project_id"] = json!(8);
        assert!(validate(&foreign).iter().any(|i| i["code"] == "reference"));
        let mut shape = original.clone();
        shape["transmit_points"][0]["conversion"] = json!("identity");
        assert!(validate(&shape).iter().any(|i| i["code"] == "conversion"));
        let mut overlap = original.clone();
        let mut second = overlap["transmit_points"][0].clone();
        second["id"] = json!(2);
        second["address"] = json!(8);
        overlap["transmit_points"]
            .as_array_mut()
            .unwrap()
            .push(second);
        assert!(validate(&overlap).iter().any(|i| i["code"] == "overlap"));
        overlap["transmit_points"][1]["enabled"] = json!(false);
        assert!(validate(&overlap).iter().any(|i| i["code"] == "overlap"));
    }

    #[test]
    fn dsp_models_follow_categories_and_manual_wire_overrides_only_warn_when_valid() {
        let mut g = graph();
        g["transmit_points"][0]["wire_type"] = json!("F32");
        g["transmit_points"][0]["conversion"] = json!("identity");
        g["transmit_points"][0]["scale"] = json!(1);
        let issues = validate(&g);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["level"], "warning");
        assert_eq!(issues[0]["code"], "wire_type_suggestion");
        assert_eq!(issues[0]["recommended_wire_type"], "S32");
        assert_eq!(issues[0]["field"], "wire_type");
        g["transmit_points"][0]["wire_type"] = json!("U32");
        assert!(
            validate(&g)
                .iter()
                .any(|issue| issue["code"] == "conversion" && issue["level"] == "error")
        );
        g["transmit_points"][0]["upp_model"] = json!(100);
        assert!(
            validate(&g)
                .iter()
                .any(|issue| issue["code"] == "upp_model_category")
        );
        g["process_points"][0]["metadata"]["category"] = json!("");
        assert!(require_upp_model(&g["process_points"][0]).is_err());
        g["transmit_points"] = json!([]);
        assert!(
            validate(&g).is_empty(),
            "unmapped points may leave category unset"
        );
    }

    #[test]
    fn other_board_wire_configuration_is_independent_of_dsp_categories() {
        let mut g = graph();
        g["project_config"]["board_types"][0]["code"] = json!("UPM");
        g["process_points"][0]["board_key"] = json!("UPM");
        g["transmit_points"][0]["board_key"] = json!("UPM");
        g["process_points"][0]["metadata"] = json!({});
        g["transmit_points"][0]["upp_model"] = json!(42);
        g["transmit_points"][0]["wire_type"] = json!("F32");
        g["transmit_points"][0]["conversion"] = json!("identity");
        g["transmit_points"][0]["scale"] = json!(1);
        assert!(validate(&g).is_empty());
    }

    #[test]
    fn other_boards_retain_independent_names_and_enabled_mappings() {
        let mut g = graph();
        g["project_config"]["board_types"][0]["code"] = json!("UPM");
        g["process_points"][0]["board_key"] = json!("UPM");
        g["transmit_points"][0]["board_key"] = json!("UPM");
        let mut disabled = g["transmit_points"][0].clone();
        disabled["id"] = json!(2);
        disabled["enabled"] = json!(false);
        g["transmit_points"].as_array_mut().unwrap().push(disabled);
        assert!(validate(&g).is_empty());
        let files = generate(&g);
        assert_eq!(
            files["board_types/UPM/UPP_SERVICE.xml"]
                .matches("<point ")
                .count(),
            1
        );
        assert!(files["board_types/UPM/UPP_SERVICE.xml"].contains("DataName=\"母线电压输出\""));
        let exported: Value =
            serde_json::from_str(&files["board_types/UPM/transmit.json"]).unwrap();
        assert_eq!(exported["points"][1]["enabled"], false);
        assert_eq!(exported["points"][1]["name"], "母线电压输出");
    }

    #[test]
    fn native_definitions_accept_unknown_ids_and_require_applied_groups() {
        let mut g = graph();
        assert!(board_definition(&g, "DSP").is_some());
        assert!(board_definition(&g, "UPM").is_none());
        g["process_points"][0]["process_enabled"] = json!(true);
        assert!(validate(&g).is_empty());
        g["process_points"][0]["sig_id"] = json!(100);
        g["process_points"][0]["group_key"] = json!("MISSING");
        assert!(validate(&g).iter().any(|i| i["code"] == "group"));
        assert!(validate(&json!({})).is_empty());
    }

    #[test]
    fn internal_length_follows_type_and_array_count() {
        let mut point = defaults("process");
        point["internal_type"] = json!("F32");
        point["element_count"] = json!(3);
        derive_length(&mut point, None).unwrap();
        assert_eq!(point["byte_length"], 12);
        assert!(derive_length(&mut point, Some(&json!(4))).is_err());
        point["element_count"] = json!(65535);
        assert!(derive_length(&mut point, None).is_err());
        point["internal_type"] = json!("STRING");
        point["element_count"] = json!(16);
        point["byte_length"] = json!(16);
        derive_length(&mut point, None).unwrap();
        assert_eq!(point["byte_length"], 16);
    }

    #[test]
    fn string_capacity_is_measured_in_utf8_bytes() {
        let mut g = graph();
        g["transmit_points"] = json!([]);
        let point = &mut g["process_points"][0];
        point["internal_type"] = json!("STRING");
        point["element_count"] = json!(6);
        point["default_value"] = json!("电压");
        derive_length(point, None).unwrap();
        assert_eq!(point["byte_length"], 6);
        assert!(validate(&g).is_empty());
        let point = &mut g["process_points"][0];
        point["element_count"] = json!(5);
        derive_length(point, None).unwrap();
        assert!(validate(&g).iter().any(|i| i["code"] == "string_length"));
    }

    #[test]
    fn only_unchanged_source_ranges_keep_legacy_warnings() {
        let mut g = graph();
        let point = &mut g["process_points"][0];
        point["default_value"] = json!("0");
        point["min_value"] = json!("1");
        point["max_value"] = json!("10");
        point["metadata"] = json!({"source_cells":{"values":{"I":"0","K":"1","J":"10"}}});
        assert!(
            validate(&g)
                .iter()
                .any(|i| i["code"] == "default_range" && i["level"] == "warning")
        );
        g["process_points"][0]["default_value"] = json!("-1");
        assert!(
            validate(&g)
                .iter()
                .any(|i| i["code"] == "default_range" && i["level"] == "error")
        );
        g["process_points"][0]["default_value"] = json!("NEW_UNRESOLVED_VALUE");
        assert!(
            validate(&g)
                .iter()
                .any(|i| i["code"] == "symbol_default_value" && i["level"] == "error")
        );
        g["process_points"][0]["metadata"]["source_cells"]["values"]["I"] =
            json!("NEW_UNRESOLVED_VALUE");
        assert!(
            validate(&g)
                .iter()
                .any(|i| i["code"] == "symbol_default_value" && i["level"] == "warning")
        );
    }

    #[test]
    fn dsp_workbook_produces_a_valid_native_graph() {
        let data = crate::dsp_workbook::parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
        )
        .unwrap();
        let mut g = graph();
        let mut ids = BTreeMap::new();
        g["process_points"] = json!(
            data.process
                .into_iter()
                .enumerate()
                .map(|(index, source)| {
                    let mut point = defaults("process");
                    point
                        .as_object_mut()
                        .unwrap()
                        .extend(source.as_object().unwrap().clone());
                    let id = index as i64 + 1;
                    point["id"] = json!(id);
                    point["project_id"] = json!(7);
                    point["board_key"] = json!("DSP");
                    ids.insert(strv(&point, "enum_name").to_owned(), id);
                    point
                })
                .collect::<Vec<_>>()
        );
        g["transmit_points"] = json!(
            data.transmit
                .into_iter()
                .enumerate()
                .map(|(index, source)| {
                    let mut point = defaults("forward");
                    point
                        .as_object_mut()
                        .unwrap()
                        .extend(source.as_object().unwrap().clone());
                    point["id"] = json!(index + 1);
                    point["project_id"] = json!(7);
                    point["board_key"] = json!("DSP");
                    point["process_point_id"] = json!(ids[strv(&point, "process_enum")]);
                    point
                })
                .collect::<Vec<_>>()
        );
        let errors: Vec<_> = validate(&g)
            .into_iter()
            .filter(|i| i["level"] == "error")
            .collect();
        assert!(
            errors.is_empty(),
            "{}",
            serde_json::to_string_pretty(&errors).unwrap()
        );
        assert!(!generate(&g)["board_types/DSP/UPP_SERVICE.xml"].is_empty());
    }
}
