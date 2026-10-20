//! Pure table scripts: input is a snapshot, output is a whitelisted layout.
use crate::{
    error::{AppError, Result},
    project_files::ProjectFiles,
    topology::{self, num, rows, strv},
};
use rquickjs::{
    Array, CatchResultExt, Context, Function, Module, Object, Runtime, context::intrinsic,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    engine: String,
    #[serde(default)]
    script_file: String,
    #[serde(default)]
    script: String,
    parameters: Value,
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub id: i64,
    pub address: i64,
    pub wire_length: i64,
}

fn fail(message: impl std::fmt::Display) -> AppError {
    AppError::bad(format!("点表计算失败：{message}；全部修改未保存"))
}

pub(crate) fn engine() -> Result<Context> {
    let runtime = Runtime::new().map_err(fail)?;
    runtime.set_memory_limit(64 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let started = Instant::now();
    let mut interrupts = 0;
    runtime.set_interrupt_handler(Some(Box::new(move || {
        interrupts += 1;
        interrupts > 2_000 || started.elapsed() > Duration::from_secs(2)
    })));
    // No module loader, host I/O, Date, performance or timers.
    let context = Context::custom::<(
        intrinsic::Eval,
        intrinsic::Json,
        intrinsic::MapSet,
        intrinsic::Promise,
    )>(&runtime)
    .map_err(fail)?;
    context.with(|ctx| {
        ctx.eval::<(), _>("delete Math.random;")
            .catch(&ctx)
            .map_err(fail)
    })?;
    Ok(context)
}

fn parse(value: &Value) -> Result<Rule> {
    let rule: Rule = serde_json::from_value(value.clone()).map_err(fail)?;
    if rule.engine == "builtin" {
        builtin_parameters(&rule.parameters)?;
        if !rule.script.is_empty() || !rule.script_file.is_empty() {
            return Err(fail("builtin 不接受脚本"));
        }
        return Ok(rule);
    }
    if rule.engine != "javascript" || !rule.parameters.is_object() {
        return Err(fail(
            "calculation.engine 必须为 javascript，parameters 必须为对象",
        ));
    }
    if rule.script.trim().is_empty()
        || rule.script.len() > 32_768
        || rule.parameters.to_string().len() > 32_768
    {
        return Err(fail("脚本不能为空，脚本和参数分别最多 32 KiB"));
    }
    Ok(rule)
}

pub fn validate(value: &Value) -> Result<()> {
    let rule = parse(value)?;
    if rule.engine == "builtin" {
        return Ok(());
    }
    engine()?.with(|ctx| {
        // Parse only: loading configuration must not execute module-level code.
        Module::declare(ctx.clone(), rule.script_file, rule.script)
            .catch(&ctx)
            .map(|_| ())
            .map_err(fail)
    })
}

pub async fn configuration(
    tx: &mut PgConnection,
    pid: i64,
    files: &ProjectFiles,
    board: &str,
) -> Result<Value> {
    let definition =
        crate::point_tables::board_definition(tx, pid, board, "forward", files).await?;
    Ok(definition
        .get("calculation")
        .cloned()
        .unwrap_or(Value::Null))
}

/// Stable source order deliberately excludes the UI's display_order.
pub fn inputs(graph: &Value, board: &str) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for mapping in rows(graph, "transmit_points")
        .iter()
        .filter(|row| row["board_key"] == board)
    {
        let point = topology::find(graph, "process_points", num(mapping, "process_point_id"))
            .filter(|point| point["board_key"] == board)
            .ok_or_else(|| fail("转发引用的内部点不存在"))?;
        let mut point = point.clone();
        if let Some(definition) = crate::board_rules::board(graph, board) {
            if crate::sheet_layout::enabled(definition) {
                crate::sheet_layout::project_for(definition, &mut point);
            }
        } else {
            point["upload_level"] = point["metadata"]["upload_level"].clone();
        }
        result.push(json!({
            "id":mapping["id"],"process_point_id":point["id"],
            "endpoint_key":mapping["endpoint_key"],"upp_model":mapping["upp_model"],
            "wire_type":mapping["wire_type"],"scale":mapping["scale"],
            "name":point["name"],"variable_name":point["variable_name"],
            "internal_type":point["internal_type"],"element_count":point["element_count"],
            "byte_length":point["byte_length"],"upload_level":point["upload_level"],
            "category":point["category"],
            "source_order":point["source_row"].as_i64().unwrap_or(num(&point,"id")),
        }));
    }
    if result.len() > 10_000 {
        return Err(fail("每张表最多计算 10000 条转发"));
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuiltinParameters {
    header_bytes: i64,
    type_bytes: BTreeMap<String, i64>,
    #[serde(default)]
    fixed_offsets: BTreeMap<String, i64>,
    fixed_offset_key: String,
    group_by: Vec<String>,
    sort_by: Vec<SortField>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SortField {
    field: String,
    #[serde(default)]
    descending: bool,
}
fn builtin_parameters(value: &Value) -> Result<BuiltinParameters> {
    let p: BuiltinParameters = serde_json::from_value(value.clone()).map_err(fail)?;
    const FIELDS: &[&str] = &[
        "id",
        "process_point_id",
        "source_order",
        "endpoint_key",
        "upp_model",
        "upload_level",
        "category",
        "name",
        "variable_name",
    ];
    if value.to_string().len() > 32768
        || !(0..65536).contains(&p.header_bytes)
        || p.type_bytes.is_empty()
        || p.type_bytes.iter().any(|(t, n)| {
            !["U8", "U16", "S16", "U32", "S32", "F32"].contains(&t.as_str())
                || !(1..65536).contains(n)
        })
        || p.fixed_offsets.values().any(|a| !(0..65536).contains(a))
        || !FIELDS.contains(&p.fixed_offset_key.as_str())
        || p.group_by.is_empty()
        || p.group_by.len() > 8
        || p.sort_by.len() > 8
        || p.group_by.iter().any(|f| !FIELDS.contains(&f.as_str()))
        || p.sort_by
            .iter()
            .any(|f| !FIELDS.contains(&f.field.as_str()))
    {
        return Err(fail("builtin 分组、排序、字节数或地址参数无效"));
    }
    Ok(p)
}
fn builtin(parameters: &Value, input: &[Value]) -> Result<Vec<Layout>> {
    let p = builtin_parameters(parameters)?;
    let mut ordered: Vec<_> = input.iter().collect();
    ordered.sort_by(|a, b| {
        for field in &p.sort_by {
            let av = &a[&field.field];
            let bv = &b[&field.field];
            let comparison = match (av.as_i64(), bv.as_i64()) {
                (Some(a), Some(b)) => a.cmp(&b),
                _ => av.as_str().unwrap_or("").cmp(bv.as_str().unwrap_or("")),
            };
            if !comparison.is_eq() {
                return if field.descending {
                    comparison.reverse()
                } else {
                    comparison
                };
            }
        }
        num(a, "id").cmp(&num(b, "id"))
    });
    let mut used: BTreeMap<String, i64> = BTreeMap::new();
    ordered
        .into_iter()
        .map(|row| {
            let length = if row["wire_type"] == "STRING" {
                num(row, "byte_length")
            } else {
                *p.type_bytes
                    .get(strv(row, "wire_type"))
                    .ok_or_else(|| fail("通信类型缺少字节数配置"))?
            };
            let group = json!(p.group_by.iter().map(|f| &row[f]).collect::<Vec<_>>()).to_string();
            let preceding = used.entry(group).or_default();
            let address = p
                .fixed_offsets
                .get(strv(row, &p.fixed_offset_key))
                .copied()
                .unwrap_or(p.header_bytes + *preceding);
            *preceding = preceding
                .checked_add(length)
                .ok_or_else(|| fail("累计字节数溢出"))?;
            Ok(Layout {
                id: num(row, "id"),
                address,
                wire_length: length,
            })
        })
        .collect()
}

pub fn evaluate(rule: &Value, input: &[Value]) -> Result<Vec<Layout>> {
    let rule = parse(rule)?;
    if input.len() > 10_000
        || input.iter().any(|point| {
            ["id", "process_point_id", "source_order"]
                .iter()
                .any(|key| num(point, key).unsigned_abs() > 9_007_199_254_740_991)
        })
    {
        return Err(fail(
            "输入超过 10000 条或记录 ID 超出 JavaScript 安全整数范围",
        ));
    }
    let layout = if rule.engine == "builtin" {
        builtin(&rule.parameters, input)?
    } else {
        engine()?.with(|ctx| -> Result<Vec<Layout>> {
            let points = ctx
                .json_parse(serde_json::to_vec(input).map_err(fail)?)
                .catch(&ctx)
                .map_err(fail)?;
            let parameters = ctx
                .json_parse(rule.parameters.to_string())
                .catch(&ctx)
                .map_err(fail)?;
            let (module, ready) = Module::declare(ctx.clone(), rule.script_file, rule.script)
                .and_then(|module| module.eval())
                .catch(&ctx)
                .map_err(fail)?;
            // No asynchronous jobs are driven: calculations must finish synchronously.
            ready
                .result::<()>()
                .ok_or_else(|| fail("脚本不能使用异步模块或 await"))?
                .catch(&ctx)
                .map_err(fail)?;
            let calculate: Function = module.get("default").catch(&ctx).map_err(fail)?;
            let result: Array = calculate
                .call((points, parameters))
                .catch(&ctx)
                .map_err(fail)?;
            if result.len() != input.len() {
                return Err(fail(
                    "脚本必须返回当前表的每条记录，不能增加、删除或遗漏记录",
                ));
            }
            result
                .iter::<Object>()
                .map(|row| {
                    let row = row.catch(&ctx).map_err(fail)?;
                    let keys: Vec<String> = row
                        .own_keys(rquickjs::object::Filter::new().string().symbol())
                        .collect::<rquickjs::Result<_>>()
                        .catch(&ctx)
                        .map_err(fail)?;
                    if keys.len() != 3
                        || keys
                            .iter()
                            .any(|key| !["id", "address", "wire_length"].contains(&key.as_str()))
                    {
                        return Err(fail("每条计算结果只能包含 id、address、wire_length"));
                    }
                    let integer = |key| -> Result<i64> {
                        let value: rquickjs::Value = row.get(key).catch(&ctx).map_err(fail)?;
                        let value = value
                            .as_number()
                            .filter(|value| {
                                value.is_finite()
                                    && value.fract() == 0.0
                                    && value.abs() <= 9_007_199_254_740_991.0
                            })
                            .ok_or_else(|| fail(format!("{key} 必须为安全整数")))?;
                        Ok(value as i64)
                    };
                    Ok(Layout {
                        id: integer("id")?,
                        address: integer("address")?,
                        wire_length: integer("wire_length")?,
                    })
                })
                .collect()
        })?
    };
    let records: BTreeMap<_, _> = input.iter().map(|row| (num(row, "id"), row)).collect();
    let mut seen = BTreeSet::new();
    let mut ranges: BTreeMap<(&str, i64), Vec<(i64, i64)>> = BTreeMap::new();
    for row in &layout {
        let original = records
            .get(&row.id)
            .ok_or_else(|| fail("脚本不能增加或引用其他表的记录"))?;
        if !seen.insert(row.id) {
            return Err(fail("脚本返回重复记录 ID"));
        }
        if row.wire_length <= 0
            || row.wire_length > 65535
            || row.address < 0
            || row
                .address
                .checked_add(row.wire_length)
                .is_none_or(|end| end > 65536)
        {
            return Err(fail(format!("记录 {} 的字节数或偏移超出范围", row.id)));
        }
        let group = ranges
            .entry((strv(original, "endpoint_key"), num(original, "upp_model")))
            .or_default();
        if group
            .iter()
            .any(|&(start, end)| row.address < end && start < row.address + row.wire_length)
        {
            return Err(fail(format!(
                "记录 {} 的 UPP 地址重叠，请检查脚本及固定地址",
                row.id
            )));
        }
        group.push((row.address, row.address + row.wire_length));
    }
    if seen.len() != records.len() {
        return Err(fail("脚本必须返回当前表的每条记录，不能删除或遗漏记录"));
    }
    Ok(layout)
}

pub async fn apply(tx: &mut PgConnection, pid: i64, board: &str, rule: &Value) -> Result<()> {
    if rule.is_null() {
        return Ok(());
    }
    let graph = topology::snapshot(tx, pid, true).await?;
    let input = inputs(&graph, board)?;
    // CPU work stays off Tokio's asynchronous workers.
    let rule = rule.clone();
    let layout = tokio::task::spawn_blocking(move || evaluate(&rule, &input))
        .await
        .map_err(fail)??;
    sqlx::query("UPDATE points.transmit_points t SET address=v.address,wire_length=v.wire_length FROM jsonb_to_recordset($3) AS v(id bigint,address integer,wire_length integer) WHERE t.project_id=$1 AND t.board_key=$2 AND t.id=v.id AND (t.address,t.wire_length) IS DISTINCT FROM (v.address,v.wire_length)")
        .bind(pid).bind(board).bind(json!(layout)).execute(&mut *tx).await?;
    Ok(())
}

/// Read-only generation/validation never silently changes stored protocol data.
pub async fn issues(
    tx: &mut PgConnection,
    pid: i64,
    files: &ProjectFiles,
    graph: &Value,
) -> Result<Vec<Value>> {
    let mut issues = Vec::new();
    for board in rows(&graph["project_config"], "board_types")
        .iter()
        .filter(|board| board["point_storage"] == "native")
    {
        let code = strv(board, "code");
        let rule = configuration(tx, pid, files, code).await?;
        if rule.is_null() {
            continue;
        }
        let input = inputs(graph, code)?;
        let originals = rows(graph, "transmit_points");
        let calculated = tokio::task::spawn_blocking(move || evaluate(&rule, &input))
            .await
            .map_err(fail)?;
        let message = match calculated {
            Ok(layout)
                if layout.iter().all(|row| {
                    originals
                        .iter()
                        .find(|point| num(point, "id") == row.id)
                        .is_some_and(|point| {
                            num(point, "address") == row.address
                                && num(point, "wire_length") == row.wire_length
                        })
                }) =>
            {
                continue;
            }
            Ok(_) => format!(
                "{code} 的计算规则与已保存布局不一致，请在转发表点击「重算协议布局」并预览保存"
            ),
            Err(error) => format!("{code}：{}", error.1),
        };
        issues.push(json!({"key":format!("calculation:{code}"),"level":"error","entity":"transmit_points","id":0,"board_key":code,"message":message}));
    }
    Ok(issues)
}

/// Preview data is only a snapshot; changing a script must never commit unseen effects.
pub fn guard(reviewed: &Value, current: &Value) -> Result<()> {
    if reviewed != current {
        return Err(AppError::conflict(
            "点表计算脚本或参数已变化，请重新预览；本次修改未保存",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule() -> Value {
        let mut rule =
            serde_json::from_str::<Value>(include_str!("../config/dc-ups/DSP/transmit.json"))
                .unwrap()["calculation"]
                .clone();
        rule["engine"] = json!("javascript");
        rule["script_file"] = json!("transmit.js");
        rule["script"] = json!(include_str!("../config/dc-ups/DSP/transmit.js"));
        rule
    }

    #[test]
    fn default_script_reproduces_every_workbook_length_and_offset() {
        let data = crate::dsp_workbook::parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
        )
        .unwrap();
        let mut graph = json!({"process_points":data.process,"transmit_points":data.transmit});
        for (index, point) in graph["process_points"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            point["id"] = json!(index + 1);
            point["board_key"] = json!("DSP");
        }
        // Workbook mappings carry a source enum until SQL import resolves IDs.
        let points = graph["process_points"].as_array().unwrap().clone();
        for (index, mapping) in graph["transmit_points"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            mapping["id"] = json!(index + 1);
            mapping["board_key"] = json!("DSP");
            let point = points
                .iter()
                .find(|point| point["enum_name"] == mapping["process_enum"])
                .unwrap();
            mapping["process_point_id"] = point["id"].clone();
        }
        let input = inputs(&graph, "DSP").unwrap();
        let output = evaluate(&rule(), &input).unwrap();
        assert_eq!(output.len(), 445);
        let builtin_rule: Value =
            serde_json::from_str::<Value>(include_str!("../config/dc-ups/DSP/transmit.json"))
                .unwrap()["calculation"]
                .clone();
        assert_eq!(evaluate(&builtin_rule, &input).unwrap(), output);
        for row in &output {
            let original = graph["transmit_points"]
                .as_array()
                .unwrap()
                .iter()
                .find(|point| num(point, "id") == row.id)
                .unwrap();
            assert_eq!(
                row.address,
                num(original, "address"),
                "{}",
                original["name"]
            );
            assert_eq!(row.wire_length, num(original, "wire_length"));
        }
        for point in graph["process_points"].as_array_mut().unwrap() {
            point["display_order"] = json!(0);
        }
        graph["transmit_points"].as_array_mut().unwrap().reverse();
        assert_eq!(
            evaluate(&rule(), &inputs(&graph, "DSP").unwrap()).unwrap(),
            output
        );
    }

    fn input() -> Vec<Value> {
        vec![
            json!({"id":1,"process_point_id":11,"endpoint_key":"UPP","upp_model":99,
            "wire_type":"STRING","byte_length":6,"upload_level":"1：上传至UPM","source_order":1,"name":"array"}),
            json!({"id":2,"process_point_id":12,"endpoint_key":"UPP","upp_model":99,
            "wire_type":"U16","byte_length":2,"upload_level":"1：上传至UPM","source_order":2,"name":"scalar"}),
        ]
    }

    #[test]
    fn json_changes_control_formulas_parameters_and_ordering() {
        let mut rule = rule();
        let mut input = input();
        let layout = evaluate(&rule, &input).unwrap();
        assert_eq!(layout[0].address, 6);
        assert_eq!(layout[1].address, 12);
        input[0]["byte_length"] = json!(10);
        assert_eq!(evaluate(&rule, &input).unwrap()[1].address, 16);
        rule["parameters"]["header_bytes"] = json!(20);
        assert_eq!(evaluate(&rule, &input).unwrap()[1].address, 30);
        input[1]["upload_level"] = json!("3：CSU进行轮询");
        let layout = evaluate(&rule, &input).unwrap();
        assert_eq!(layout[0].id, 2);
        assert_eq!(layout[1].address, 22);
        rule["script"] = json!(
            "export default function calculate(points) { return points.map(p => ({id:p.id, address:p.id * 20, wire_length:2})); }"
        );
        assert_eq!(evaluate(&rule, &input).unwrap()[1].address, 40);
    }

    #[test]
    fn scripts_cannot_escape_limits_or_whitelisted_output() {
        let mut rule = rule();
        for script in [
            "while (true) {}",
            "return import('/etc/passwd')",
            "return Date.now()",
            "return Math.random()",
            "return process.env",
            "return require('node:fs')",
            "return fetch('https://example.com')",
            "return [{id:1,address:6,wire_length:2}]",
            "return [{id:9,address:6,wire_length:2},{id:2,address:8,wire_length:2}]",
            "return [{id:1,address:6,wire_length:2},{id:1,address:8,wire_length:2}]",
            r#"return [{id:1,address:6,wire_length:2,name:'injected'},{id:2,address:8,wire_length:2}]"#,
            "return points.map(p => Object.defineProperty({id:p.id,address:p.id*2,wire_length:2}, 'hidden', {value:1}))",
            "return points.map(p => ({id:p.id,address:p.id*2,wire_length:2,[Symbol('hidden')]:1}))",
            "return [{id:1,address:6,wire_length:4},{id:2,address:8,wire_length:2}]",
            "return [{id:1,address:65535,wire_length:2},{id:2,address:8,wire_length:2}]",
            "return [{id:1,address:6,wire_length:0},{id:2,address:8,wire_length:2}]",
            "return [{id:1,address:6.5,wire_length:2},{id:2,address:8,wire_length:2}]",
            "return [{id:1,address:6,wire_length:2.5},{id:2,address:8,wire_length:2}]",
            "return [{id:1,address:NaN,wire_length:2},{id:2,address:8,wire_length:2}]",
            "return [{id:1,address:'6',wire_length:2},{id:2,address:8,wire_length:2}]",
            "return new Array(10001).fill({id:1,address:6,wire_length:2})",
            "return 'x'.repeat(128 * 1024 * 1024)",
            "function recurse() { return recurse() }; return recurse()",
            "return Promise.resolve(points)",
        ] {
            rule["script"] = json!(format!(
                "export default function calculate(points, parameters) {{ {script} }}"
            ));
            assert!(evaluate(&rule, &input()).is_err(), "{script}");
        }
        rule["script"] =
            json!("while (true) {} export default function calculate() { return []; }");
        validate(&rule).unwrap(); // Configuration parsing never executes the body.
        assert!(evaluate(&rule, &input()).is_err());
        assert!(guard(&rule, &Value::Null).is_err());
        assert!(guard(&rule, &rule).is_ok());
    }
}
