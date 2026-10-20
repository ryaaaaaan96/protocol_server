//! Table-owned business rules. Rust owns identity, storage, transactions and safety.
use crate::error::{AppError, Result};
use rquickjs::{CatchResultExt, Function, Module};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const MAX_ROWS: usize = 10_000;
const MAX_JSON: usize = 16 * 1024 * 1024;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rule {
    engine: String,
    script_file: String,
    script: String,
    parameters: Value,
    #[serde(default)]
    editable_fields: Vec<String>,
    #[serde(default)]
    metadata_fields: Vec<String>,
    #[serde(default)]
    project_fields: Vec<String>,
    #[serde(default)]
    owned_fields: Vec<String>,
}

fn fail(message: impl std::fmt::Display) -> AppError {
    AppError::bad(format!("点表行为脚本失败：{message}"))
}

fn object_size(value: &Map<String, Value>) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn field_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .enumerate()
            .all(|(i, ch)| ch == b'_' || ch.is_ascii_alphabetic() || i > 0 && ch.is_ascii_digit())
        && !["__proto__", "constructor", "prototype"].contains(&value)
}

fn protected(key: &str) -> bool {
    [
        "id",
        "project_id",
        "board_key",
        "group_key",
        "endpoint_key",
        "process_point_id",
        "source_id",
        "edit_values",
        "can_edit",
        "source_sheet",
        "source_row",
        "source_cells",
        "source_rows",
    ]
    .contains(&key)
}

fn parse(value: &Value) -> Result<Rule> {
    let rule: Rule = serde_json::from_value(value.clone()).map_err(fail)?;
    if rule.engine != "javascript"
        || !rule.parameters.is_object()
        || rule.parameters.to_string().len() > 32_768
        || rule.script.trim().is_empty()
        || rule.script.len() > 32_768
        || rule.script_file.is_empty()
        || rule.script_file.len() > 256
    {
        return Err(fail(
            "behavior 须使用 javascript、非空 script_file 和对象 parameters；脚本和参数分别最多 32 KiB",
        ));
    }
    for (kind, fields) in [
        ("editable_fields", &rule.editable_fields),
        ("metadata_fields", &rule.metadata_fields),
        ("project_fields", &rule.project_fields),
        ("owned_fields", &rule.owned_fields),
    ] {
        let mut seen = BTreeSet::new();
        if fields.len() > 128
            || fields.iter().any(|key| {
                !field_name(key)
                    || !seen.insert(key)
                    || protected(key)
                    || (kind != "metadata_fields" && key == "metadata")
                    || (kind == "metadata_fields"
                        && ["original_ranges", "source_warnings"].contains(&key.as_str()))
            })
        {
            return Err(fail(format!(
                "{kind} 含重复、受保护或无效字段，或超过 128 项"
            )));
        }
    }
    if rule
        .editable_fields
        .iter()
        .any(|key| !rule.project_fields.contains(key))
    {
        return Err(fail("editable_fields 必须同时声明在 project_fields 中"));
    }
    Ok(rule)
}

pub fn validate_rule(value: &Value) -> Result<()> {
    let rule = parse(value)?;
    crate::script_runtime::engine()?.with(|ctx| {
        // Loading files only parses the module; it never runs its top-level code.
        Module::declare(ctx.clone(), rule.script_file, rule.script)
            .catch(&ctx)
            .map(|_| ())
            .map_err(fail)
    })
}

/// Reject non-JSON values before serialization: JSON.stringify alone would hide
/// undefined, non-enumerable keys, symbols, getters and non-finite numbers.
/// Capture intrinsics before evaluating the configurable module.
const ENCODER: &str = r#"
(() => {
  const ownKeys = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor;
  const prototype = Object.getPrototypeOf;
  const setPrototype = Object.setPrototypeOf;
  const create = Object.create;
  const array = Array.isArray;
  const hasOwn = Object.hasOwn;
  const finite = Number.isFinite;
  const stringify = JSON.stringify;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  return function encode(value) {
    let count = 0;
    function copy(value, depth) {
      if (++count > 500000 || depth > 32) throw Error("脚本输出过大或嵌套过深");
      if (value === null || typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number") {
        if (!finite(value)) throw Error("脚本输出不允许 NaN 或 Infinity");
        return value;
      }
      if (typeof value !== "object") throw Error("脚本输出只能包含 JSON 数据");
      const isArray = array(value);
      const proto = prototype(value);
      if (isArray ? proto !== arrayPrototype && proto !== null : proto !== objectPrototype && proto !== null) {
        throw Error("脚本输出必须为普通对象或数组");
      }
      const out = isArray ? setPrototype([], null) : create(null);
      const keys = ownKeys(value);
      let length = 0;
      if (isArray) {
        const size = descriptor(value, "length");
        length = size.value;
        if (length > 10000) throw Error("脚本数组超过 10000 项");
        out.length = length;
      }
      let entries = 0;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (isArray && key === "length") continue;
        if (typeof key !== "string") throw Error("脚本输出不能包含 Symbol");
        const prop = descriptor(value, key);
        if (!prop.enumerable || !hasOwn(prop, "value")) throw Error("脚本输出不能包含隐藏属性或 getter");
        if (isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || +key >= length)) {
          throw Error("脚本数组不能包含额外属性");
        }
        out[key] = copy(prop.value, depth + 1);
        entries++;
      }
      if (isArray && entries !== length) throw Error("脚本数组不能包含空项");
      return out;
    }
    return stringify(copy(value, 0));
  };
})()
"#;

pub fn evaluate(rule: &Value, context: &Value) -> Result<Value> {
    let rule = parse(rule)?;
    let input = serde_json::to_vec(context).map_err(fail)?;
    if input.len() > MAX_JSON {
        return Err(fail("脚本输入超过 16 MiB"));
    }
    crate::script_runtime::engine()?.with(|ctx| {
        let encoder: Function = ctx.eval(ENCODER).catch(&ctx).map_err(fail)?;
        let input = ctx.json_parse(input).catch(&ctx).map_err(fail)?;
        let parameters = ctx
            .json_parse(rule.parameters.to_string())
            .catch(&ctx)
            .map_err(fail)?;
        let (module, ready) = Module::declare(ctx.clone(), rule.script_file, rule.script)
            .and_then(|module| module.eval())
            .catch(&ctx)
            .map_err(fail)?;
        ready
            .result::<()>()
            .ok_or_else(|| fail("behavior 不能使用异步模块或 await"))?
            .catch(&ctx)
            .map_err(fail)?;
        let behavior: Function = module.get("behavior").catch(&ctx).map_err(fail)?;
        let output: rquickjs::Value = behavior
            .call((input, parameters))
            .catch(&ctx)
            .map_err(fail)?;
        let encoded: String = encoder.call((output,)).catch(&ctx).map_err(fail)?;
        if encoded.len() > MAX_JSON {
            return Err(fail("脚本输出超过 16 MiB"));
        }
        serde_json::from_str(&encoded).map_err(fail)
    })
}

fn rule(definition: &Value) -> Option<&Value> {
    definition.get("behavior").filter(|value| !value.is_null())
}

fn index(rows: &[Value]) -> Result<BTreeMap<i64, &Value>> {
    if rows.len() > MAX_ROWS {
        return Err(fail("一张表最多处理 10000 行"));
    }
    let mut records = BTreeMap::new();
    for row in rows {
        let id = row["id"]
            .as_i64()
            .filter(|id| *id > 0 && id.unsigned_abs() <= MAX_SAFE_ID)
            .ok_or_else(|| fail("记录 ID 必须为正安全整数"))?;
        if records.insert(id, row).is_some() {
            return Err(fail("输入包含重复记录 ID"));
        }
    }
    Ok(records)
}

fn patches(
    output: Value,
    rows: &[Value],
    allowed: &[String],
) -> Result<Vec<(i64, Map<String, Value>)>> {
    let records = index(rows)?;
    let patches = output
        .as_array()
        .filter(|items| items.len() == rows.len())
        .ok_or_else(|| fail("project/reconcile 必须完整返回当前表的所有行"))?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(patches.len());
    for patch in patches {
        let object = patch
            .as_object()
            .filter(|object| {
                object.len() == 2 && object.contains_key("id") && object.contains_key("values")
            })
            .ok_or_else(|| fail("每行结果只能包含 id 和 values"))?;
        let id = object["id"]
            .as_i64()
            .filter(|id| records.contains_key(id) && seen.insert(*id))
            .ok_or_else(|| fail("输出包含新增、重复或其他表记录 ID"))?;
        let values = object["values"]
            .as_object()
            .ok_or_else(|| fail("values 必须为对象"))?;
        if values
            .keys()
            .any(|key| !allowed.contains(key) || protected(key))
        {
            return Err(fail("输出包含未声明或受保护的字段"));
        }
        if values.len() > 128 || object_size(values) > 128 * 1024 {
            return Err(fail("单行输出字段过多或超过 128 KiB"));
        }
        out.push((id, values.clone()));
    }
    Ok(out)
}

pub fn project(definition: &Value, rows: &mut [Value], sources: &[Value]) -> Result<()> {
    let Some(value) = rule(definition) else {
        return Ok(());
    };
    let parsed = parse(value)?;
    index(rows)?;
    index(sources)?;
    let mut input_rows = rows.to_vec();
    input_rows.sort_by_key(|row| row["id"].as_i64().unwrap());
    let mut input_sources = sources.to_vec();
    input_sources.sort_by_key(|row| row["id"].as_i64().unwrap());
    let output = evaluate(
        value,
        &json!({"action":"project","rows":input_rows,"sources":input_sources}),
    )?;
    let updates: BTreeMap<_, _> = patches(output, rows, &parsed.project_fields)?
        .into_iter()
        .collect();
    for row in rows {
        let values = &updates[&row["id"].as_i64().unwrap()];
        if parsed
            .editable_fields
            .iter()
            .any(|key| !values.contains_key(key))
        {
            return Err(fail(
                "project 必须明确返回每个 editable_fields 字段，空值请返回 null",
            ));
        }
        if row["enabled"] == true && values.get("enabled") == Some(&json!(false)) {
            return Err(fail(
                "project 不能隐藏已启用的记录；停用须经过正式写入和校验",
            ));
        }
        if !row["edit_values"].is_object() {
            row["edit_values"] = row.clone();
        }
        for key in &parsed.editable_fields {
            if let Some(value) = values.get(key) {
                row["edit_values"][key] = value.clone();
            }
        }
        row.as_object_mut().unwrap().extend(values.clone());
    }
    Ok(())
}

fn metadata_preserved(rule: &Rule, old: &Value, values: &Map<String, Value>) -> Result<()> {
    let Some(metadata) = values.get("metadata") else {
        return Ok(());
    };
    let metadata = metadata
        .as_object()
        .ok_or_else(|| fail("metadata 必须为对象"))?;
    let original = old["metadata"].as_object().cloned().unwrap_or_default();
    for key in original.keys().chain(metadata.keys()) {
        if !rule.metadata_fields.contains(key) && original.get(key) != metadata.get(key) {
            return Err(fail(format!(
                "metadata.{key} 未声明为可写，不能修改来源证据"
            )));
        }
    }
    if metadata.len() > 256 || object_size(metadata) > 128 * 1024 {
        return Err(fail("metadata 超出 256 项或 128 KiB"));
    }
    Ok(())
}

pub fn normalize(
    definition: &Value,
    old: &Value,
    fields: &Map<String, Value>,
    source: &Value,
    operation: &str,
) -> Result<Map<String, Value>> {
    let Some(value) = rule(definition) else {
        return Ok(fields.clone());
    };
    let parsed = parse(value)?;
    let output = evaluate(
        value,
        &json!({
            "action":"normalize","row":old,"fields":fields,"source":source,"operation":operation
        }),
    )?;
    let object = output
        .as_object()
        .filter(|object| object.len() == 1 && object.contains_key("values"))
        .ok_or_else(|| fail("normalize 必须返回仅包含 values 的对象"))?;
    let values = object["values"]
        .as_object()
        .ok_or_else(|| fail("normalize.values 必须为对象"))?;
    if values.len() > 128 || object_size(values) > 128 * 1024 {
        return Err(fail("规范化后的单行超过 128 项或 128 KiB"));
    }
    // Association fields may be explicitly supplied by a user; the platform
    // validates their scope. A script cannot silently switch those identities.
    for key in values.keys().filter(|key| protected(key)) {
        if !["group_key", "endpoint_key", "process_point_id"].contains(&key.as_str())
            || fields.get(key) != values.get(key)
        {
            return Err(fail(format!("normalize 不能修改受保护字段 {key}")));
        }
    }
    metadata_preserved(&parsed, old, values)?;
    Ok(values.clone())
}

pub fn reconcile(
    definition: &Value,
    rows: &[Value],
    sources: &[Value],
) -> Result<Vec<(i64, Map<String, Value>)>> {
    let Some(value) = rule(definition) else {
        return Ok(vec![]);
    };
    let parsed = parse(value)?;
    index(rows)?;
    index(sources)?;
    let output = evaluate(
        value,
        &json!({"action":"reconcile","rows":rows,"sources":sources}),
    )?;
    let patches = patches(output, rows, &parsed.owned_fields)?;
    let original = index(rows)?;
    for (id, values) in &patches {
        metadata_preserved(&parsed, original[id], values)?;
    }
    Ok(patches)
}

pub fn issues(
    definition: &Value,
    rows: &[Value],
    sources: &[Value],
    entity: &str,
) -> Result<Vec<Value>> {
    let Some(value) = rule(definition) else {
        return Ok(vec![]);
    };
    let records = index(rows)?;
    let source_records = index(sources)?;
    let output = evaluate(
        value,
        &json!({"action":"validate","rows":rows,"sources":sources}),
    )?;
    let issues = output
        .as_array()
        .filter(|issues| issues.len() <= MAX_ROWS)
        .ok_or_else(|| fail("validate 必须返回最多 10000 项的数组"))?;
    let mut out = Vec::with_capacity(issues.len());
    for issue in issues {
        let object = issue
            .as_object()
            .ok_or_else(|| fail("校验问题必须为对象"))?;
        if object.keys().any(|key| {
            ![
                "id",
                "code",
                "message",
                "level",
                "related_id",
                "field",
                "recommended_wire_type",
                "actual_wire_type",
            ]
            .contains(&key.as_str())
        }) {
            return Err(fail("校验问题包含未支持的字段"));
        }
        let id = issue["id"]
            .as_i64()
            .filter(|id| *id == 0 || records.contains_key(id))
            .ok_or_else(|| fail("校验问题引用其他表的记录"))?;
        let code = issue["code"]
            .as_str()
            .filter(|value| field_name(value))
            .ok_or_else(|| fail("校验问题 code 无效"))?;
        if issue["message"]
            .as_str()
            .is_none_or(|message| message.is_empty() || message.len() > 4096)
            || !["warning", "error"].contains(&issue["level"].as_str().unwrap_or(""))
        {
            return Err(fail("校验问题需要有效 message 和 error/warning level"));
        }
        let related = match issue.get("related_id") {
            None => 0,
            Some(value) => value
                .as_i64()
                .filter(|id| *id == 0 || source_records.contains_key(id))
                .ok_or_else(|| fail("related_id 必须引用输入来源记录"))?,
        };
        if issue
            .get("field")
            .is_some_and(|field| field.as_str().is_none_or(|key| !field_name(key)))
        {
            return Err(fail("校验问题 field 无效"));
        }
        let mut issue = issue.clone();
        issue["key"] = json!(format!("{entity}:{id}:{code}:{related}"));
        issue["entity"] = json!(entity);
        issue["related_id"] = json!(related);
        if let Some(row) = records.get(&id) {
            issue["name"] = row["name"].clone();
            issue["board_key"] = row["board_key"].clone();
        }
        out.push(issue);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(kind: &str) -> Value {
        let (json, script) = if kind == "process" {
            (
                include_str!("../config/dc-ups/DSP/process.json"),
                include_str!("../config/dc-ups/DSP/process.js"),
            )
        } else {
            (
                include_str!("../config/dc-ups/DSP/transmit.json"),
                include_str!("../config/dc-ups/DSP/transmit.js"),
            )
        };
        let mut value: Value = serde_json::from_str(json).unwrap();
        value["behavior"]["script"] = json!(script);
        value
    }

    fn source() -> Value {
        json!({"id":1,"name":"测试变量","enum_name":"TEST_VALUE","internal_type":"F32",
            "element_count":1,"byte_length":4,
            "metadata":{"source_variable":"TestValue","display_digits":3,"category":"任务级观测量",
                "source_cells":{"values":{"B":"TestValue"}}}})
    }

    #[test]
    fn dsp_script_preserves_all_worksheet_columns() {
        let imported = crate::dsp_workbook::parse_workbook(
            include_bytes!("../config/dc-ups/sources/DC-UPS测点数据表.xlsx").to_vec(),
        )
        .unwrap();
        let mut points = imported.process;
        for (index, point) in points.iter_mut().enumerate() {
            point["id"] = json!(index + 1);
        }
        project(&definition("process"), &mut points, &[]).unwrap();
        assert_eq!(points.len(), 552);
        let fields = [
            "name",
            "variable_name",
            "sheet_type",
            "enum_table",
            "display_digits",
            "type_length",
            "element_count",
            "byte_length",
            "default_value",
            "max_value",
            "min_value",
            "unit",
            "access",
            "ram",
            "flash",
            "eeprom",
            "calibration",
            "structure",
            "cpu",
            "precision",
            "sheet_data_type",
            "upload_level",
            "category",
            "sheet_upp_model",
            "notes",
        ];
        for row in &points {
            for (column, field) in ('A'..='Y').zip(fields) {
                let actual = row[field]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| row[field].to_string());
                assert_eq!(
                    actual,
                    row["metadata"]["source_cells"]["values"][column.to_string()]
                        .as_str()
                        .unwrap_or_default(),
                    "source row {}: {field}",
                    row["source_row"]
                );
            }
        }
        let mut mappings = imported.transmit;
        for (index, mapping) in mappings.iter_mut().enumerate() {
            mapping["id"] = json!(index + 1);
            let source = points
                .iter()
                .find(|point| point["enum_name"] == mapping["process_enum"])
                .unwrap();
            mapping["process_point_id"] = source["id"].clone();
        }
        project(&definition("forward"), &mut mappings, &points).unwrap();
        assert_eq!(mappings.len(), 445);
        for mapping in mappings {
            let source = points
                .iter()
                .find(|point| point["id"] == mapping["process_point_id"])
                .unwrap();
            let reference = crate::sheet_layout::wire_defaults(source, None);
            for key in ["wire_type", "wire_length", "scale", "conversion"] {
                if key == "scale" {
                    assert_eq!(
                        mapping["recommended_scale"].as_f64(),
                        reference["scale"].as_f64(),
                        "transmit {}: scale",
                        mapping["id"]
                    );
                    continue;
                }
                assert_eq!(
                    mapping[format!("recommended_{key}")],
                    reference[key],
                    "transmit {}: {key}",
                    mapping["id"]
                );
            }
            assert_eq!(
                mapping["conversion"],
                crate::sheet_layout::wire_defaults(source, mapping["wire_type"].as_str())["conversion"]
            );
        }
    }

    #[test]
    fn dsp_scripts_edit_project_and_reconcile_without_rewriting_manual_wire_values() {
        let process = definition("process");
        let forward = definition("forward");
        let mut row = source();
        row["metadata"]["source_cells"]["values"]["I"] = json!("SOURCE_DEFAULT");
        row["metadata"]["source_cells"]["values"]["K"] = json!("SOURCE_MIN");
        row["metadata"]["source_cells"]["values"]["J"] = json!("SOURCE_MAX");
        row["default_value"] = json!("CURRENT_DEFAULT");
        let evidence = row["metadata"]["source_cells"].clone();
        let fields = json!({"variable_name":"UpdatedProduct","sheet_type":"Sys_F32",
            "display_digits":4,"ram":"Y","category":"任务级标定量"});
        let values = normalize(
            &process,
            &row,
            fields.as_object().unwrap(),
            &Value::Null,
            "update",
        )
        .unwrap();
        row.as_object_mut().unwrap().extend(values);
        let mut sources = vec![row];
        project(&process, &mut sources, &[]).unwrap();
        assert_eq!(sources[0]["metadata"]["source_cells"], evidence);
        assert_eq!(
            sources[0]["source_values"],
            json!({"default_value":"SOURCE_DEFAULT","min_value":"SOURCE_MIN","max_value":"SOURCE_MAX"})
        );
        assert_eq!(sources[0]["variable_name"], "UpdatedProduct");
        assert_eq!(sources[0]["enum_name"], "UPDATED_PRODUCT");
        assert_eq!(sources[0]["precision"], "0.0001");
        assert_eq!(sources[0]["sheet_upp_model"], 103);
        let mut rows = vec![
            json!({"id":2,"name":"旧名称","process_point_id":1,"enabled":false,
            "wire_type":"F32","wire_length":4,"scale":1.0,"upp_model":99,"address":16,
            "conversion":"identity","byte_order":1}),
        ];
        let original = rows[0].clone();
        project(&forward, &mut rows, &sources).unwrap();
        assert_eq!(rows[0]["name"], "测试变量");
        assert_eq!(rows[0]["edit_values"]["name"], "旧名称");
        assert_eq!(rows[0]["recommended_wire_type"], "S32");
        let patches = reconcile(&forward, &[original], &sources).unwrap();
        assert_eq!(patches[0].1["upp_model"], 103);
        assert_eq!(patches[0].1["enabled"], true);
        for manual in ["wire_type", "wire_length", "scale", "address"] {
            assert!(!patches[0].1.contains_key(manual));
        }
        let warnings = issues(&forward, &rows, &sources, "transmit_points").unwrap();
        assert!(
            warnings
                .iter()
                .any(|issue| issue["code"] == "wire_type_suggestion"
                    && issue["level"] == "warning"
                    && issue["related_id"] == 1)
        );
        let created = normalize(&forward, &json!({}), &Map::new(), &sources[0], "create").unwrap();
        assert_eq!(created["wire_type"], "S32");
        assert_eq!(created["wire_length"], 4);
        assert_eq!(created["scale"], 0.0001);
        assert!(
            normalize(
                &forward,
                &rows[0],
                json!({"upp_model":2}).as_object().unwrap(),
                &sources[0],
                "update"
            )
            .is_err()
        );
        assert!(
            normalize(
                &forward,
                &rows[0],
                json!({"enabled":false}).as_object().unwrap(),
                &sources[0],
                "update"
            )
            .is_err()
        );
    }

    #[test]
    fn script_outputs_cannot_change_identity_or_source_evidence() {
        let mut definition = definition("process");
        let rows = vec![source()];
        for body in [
            "return [{id:2, values:{}}]",
            "return []",
            "return [{id:1,values:{can_edit:true}}]",
            "return [{id:1,values:{id:4}}]",
            "return [{id:1,values:{metadata:{}}}]",
            "return [{id:1,values:{precision:NaN}}]",
            "return [{id:1,values:{precision:undefined}}]",
            "return [{id:1,values:{get precision(){return 'x'}}}]",
            "return [{id:1,values:Object.defineProperty({},'precision',{value:'x'})}]",
            "return [{id:1,values:{[Symbol('hidden')]:true}}]",
            "return [{id:1,values:{}}]",
            "return Promise.resolve([])",
        ] {
            definition["behavior"]["script"] =
                json!(format!("export function behavior() {{ {body} }}"));
            assert!(
                project(&definition, &mut rows.clone(), &[]).is_err(),
                "{body}"
            );
        }
        definition["behavior"]["script"] =
            json!("export function behavior() { return {values:{metadata:{source_cells:{}}}} }");
        assert!(normalize(&definition, &rows[0], &Map::new(), &Value::Null, "update").is_err());
        definition["behavior"]["script"] = json!("export function behavior() { while (true) {} }");
        assert!(project(&definition, &mut rows.clone(), &[]).is_err());
        definition["behavior"]["editable_fields"] = json!([]);
        definition["behavior"]["project_fields"] = json!(["enabled"]);
        definition["behavior"]["owned_fields"] = json!(["enabled"]);
        definition["behavior"]["script"] =
            json!("export function behavior() { return [{id:1,values:{enabled:false}}]; }");
        let mut enabled = rows.clone();
        enabled[0]["enabled"] = json!(true);
        assert!(project(&definition, &mut enabled, &[]).is_err());
    }

    #[test]
    fn generic_declared_metadata_field_is_editable_without_native_code() {
        let definition = json!({"behavior":{
            "engine":"javascript","script_file":"new-table.js","parameters":{},
            "editable_fields":["site_label"],"metadata_fields":["site_label"],
            "project_fields":["site_label"],"owned_fields":[],
            "script":"export function behavior(c) { if(c.action==='normalize') return {values:{metadata:{...c.row.metadata,site_label:c.fields.site_label}}}; if(c.action==='project') return c.rows.map(r=>({id:r.id,values:{site_label:r.metadata.site_label || ''}})); return c.action==='validate' ? [] : c.rows.map(r=>({id:r.id,values:{}})); }"
        }});
        let mut rows = vec![source()];
        let values = normalize(
            &definition,
            &rows[0],
            json!({"site_label":"楼层 3"}).as_object().unwrap(),
            &Value::Null,
            "update",
        )
        .unwrap();
        rows[0].as_object_mut().unwrap().extend(values);
        project(&definition, &mut rows, &[]).unwrap();
        assert_eq!(rows[0]["site_label"], "楼层 3");
        assert_eq!(rows[0]["edit_values"]["site_label"], "楼层 3");
        assert_eq!(
            rows[0]["metadata"]["source_cells"],
            source()["metadata"]["source_cells"]
        );
    }

    #[test]
    fn projection_input_order_is_stable_without_reordering_display_rows() {
        let definition = json!({"behavior":{
            "engine":"javascript","script_file":"rank.js","parameters":{},
            "editable_fields":[],"metadata_fields":[],"project_fields":["source_rank"],
            "owned_fields":[],
            "script":"export function behavior(c) { return c.rows.map((r,i)=>({id:r.id,values:{source_rank:i+1}})); }"
        }});
        let mut rows = vec![
            json!({"id":3,"display_order":0}),
            json!({"id":1,"display_order":1}),
            json!({"id":2,"display_order":2}),
        ];
        project(&definition, &mut rows, &[]).unwrap();
        assert_eq!(
            rows.iter().map(|row| row["id"].clone()).collect::<Vec<_>>(),
            vec![json!(3), json!(1), json!(2)]
        );
        assert_eq!(
            rows.iter()
                .map(|row| row["source_rank"].clone())
                .collect::<Vec<_>>(),
            vec![json!(3), json!(1), json!(2)]
        );
    }
}
