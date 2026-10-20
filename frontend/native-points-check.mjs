import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function compile(path) {
  return ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const choicesUrl = moduleUrl(await compile("./src/domain/pointTables.ts"));
const { pointChoices, pointDataType, pointIsString, hasRecommendation, hasRecalculation, definitionForProtocol, pointChangeSummary, communicationRecommendation, communicationHint, communicationDiffers, editableCommunicationRecommendation, hiddenProcessPoint } = await import(choicesUrl);
const gridUrl = moduleUrl((await compile("./src/domain/pointGrid.ts")).replace('"./pointTables"', JSON.stringify(choicesUrl)));
const { parseCell, displayCell, fieldForColumn, columnApplies } = await import(gridUrl);
const { overviewDefinition, overviewText } = await import(moduleUrl((await compile("./src/domain/pointOverview.ts"))
  .replace('"./pointGrid"', JSON.stringify(gridUrl)).replace('"./pointTables"', JSON.stringify(choicesUrl))));
const { allowsPoint } = await import(moduleUrl(await compile("./src/domain/permissions.ts")));
const { belongsToBoard, scopedRows } = await import(moduleUrl(await compile("./src/domain/board.ts")));
const processDefinition = JSON.parse(await readFile(new URL("../config/dc-ups/DSP/process.json", import.meta.url), "utf8"));
const forwardDefinition = JSON.parse(await readFile(new URL("../config/dc-ups/DSP/transmit.json", import.meta.url), "utf8"));
const point = {
  id: 1, board_key: "DSP", group_key: "LOCAL", name: "母线电压", enum_name: "DC_BUS_VOLTAGE", sig_id: 4097,
  variable_name: "DcBusVoltage", sheet_type: "Sys_F32", type_length: 4, display_digits: 0, precision: 1, sheet_data_type: "S32", category: "系统参数1", sheet_upp_model: 1, enum_table: "bit0:有效\nbit1:故障",
  recommended_wire_type: "S32", recommended_wire_length: 4, recommended_scale: 1,
  data_type: "F32", internal_type: "F32", element_count: 1, byte_length: 4, unit: "V", default_value: "0", min_value: "0", max_value: "1000",
};
const alternate = { ...point, id: 2, name: "设备名称", enum_name: "DEVICE_NAME", variable_name: "DeviceName", sig_id: 4098, data_type: "STRING", internal_type: "STRING", sheet_type: "Sys_U16", sheet_data_type: "STRING", element_count: 16, byte_length: 32, category: "任务级观测量", recommended_wire_type: "STRING", recommended_wire_length: 32, recommended_scale: 1 };
const boardGraph = {
  project_config: { board_types: [
    { code: "DSP", point_storage: "native" },
    { code: "UPM" },
  ] },
};
const dspBoard = { code: "DSP" }, upmBoard = { code: "UPM" };
for (const entity of ["process_points", "transmit_points"]) {
  assert.equal(belongsToBoard(boardGraph, dspBoard, entity, point), true);
  assert.equal(belongsToBoard(boardGraph, upmBoard, entity, point), false);
  assert.equal(belongsToBoard(boardGraph, { code: "MISSING" }, entity, point), false);
  assert.equal(belongsToBoard({ ...boardGraph, project_config: null }, dspBoard, entity, point), false);
  assert.deepEqual(scopedRows(boardGraph, dspBoard, entity, [point, { ...alternate, board_key: "UPM" }]), [point]);
  assert.deepEqual(scopedRows(boardGraph, upmBoard, entity, [point]), []);
}
const options = { native_groups: [{ code: "LOCAL", name: "本机数据" }], process_points: [point, alternate], endpoints: [{ code: "UPP_SERVICE", name: "UPP 对外接口", protocol: "UPP" }] };
const process = { storage: "native", board_key: "DSP", kind: "process", definition: processDefinition, options, rows: [], revision: 1 };
const processRow = { ...point, group_name: "本机数据", resolved_sig_id: point.sig_id, edit_values: { ...point } };
const visibilityDefinition = JSON.parse(await readFile(new URL("../config/dc-ups/UPM/process.json", import.meta.url), "utf8"));
assert.equal(hiddenProcessPoint(visibilityDefinition, {sig_id:null,metadata:{source_sig_id:" ※ "}}), true);
for (const row of [{sig_id:5,source_sig_id:"※"},{sig_id:0,source_sig_id:"※"},{sig_id:null,source_sig_id:""},{sig_id:null},{sig_id:null,source_sig_id:"0"}])
  assert.equal(hiddenProcessPoint(visibilityDefinition,row), false);
assert.equal(hiddenProcessPoint(processDefinition,{sig_id:null,source_sig_id:"※"}),false);
const markedProcess = {...process,definition:visibilityDefinition};
const markedRow = {sig_id:null,metadata:{source_sig_id:"※"},edit_values:{sig_id:null}};
assert.equal(displayCell(markedProcess,markedRow,"sig_id",{}),"※（不上传 UPP）");
assert.equal(displayCell(markedProcess,markedRow,"sig_id",{sig_id:123}),"123");
assert.equal(processDefinition.presentation.empty_text, "");
assert.equal(processDefinition.columns.length, 23);
for (const key of ["sheet_data_type", "sheet_upp_model"]) assert.ok(!processDefinition.columns.includes(key));
assert.deepEqual(processDefinition.columns.slice(0, 8), ["name", "variable_name", "sheet_type", "enum_table", "display_digits", "type_length", "element_count", "byte_length"]);
assert.equal(fieldForColumn(process, "variable_name"), "variable_name");
assert.equal(fieldForColumn(process, "sheet_type"), "sheet_type");
for (const key of ["type_length", "byte_length", "precision", "sheet_data_type", "sheet_upp_model"]) assert.equal(fieldForColumn(process, key), undefined);
for (const key of ["sig_id", "enum_name", "internal_type"]) assert.ok(!processDefinition.editor.includes(key));
assert.equal(parseCell(process, "variable_name", "NewVariable", point), "NewVariable");
assert.equal(parseCell(process, "sheet_type", "Sys_U16", point), "Sys_U16");
assert.equal(parseCell(process, "enum_table", "bit0:有效\nbit1:故障", point), "bit0:有效\nbit1:故障");
assert.equal(displayCell(process, processRow, "default_value", { default_value: null }), "");
assert.equal(displayCell(process, processRow, "notes", {}), "");
assert.equal(displayCell(process, processRow, "enum_table", {}), "bit0:有效\nbit1:故障");
assert.equal(displayCell(process, processRow, "byte_length", { sheet_type: "Sys_U16", element_count: 15 }), "待计算");
assert.equal(displayCell(process, processRow, "type_length", { sheet_type: "Sys_U16" }), "待计算");
assert.equal(displayCell(process, processRow, "precision", { display_digits: 3 }), "待计算");
assert.equal(displayCell(process, processRow, "precision", { display_digits: 7 }), "待计算");
assert.equal(displayCell(process, processRow, "precision", { display_digits: 8 }), "待计算");
assert.equal(displayCell(process, processRow, "sheet_data_type", { sheet_type: "Sys_U16", element_count: 15 }), "待计算");
assert.equal(displayCell(process, processRow, "sheet_data_type", { sheet_type: "Sys_U16" }), "待计算");
assert.equal(displayCell(process, { ...processRow, sheet_type: "Sys_U16", edit_values: { ...point, sheet_type: "Sys_U16" } }, "sheet_data_type", { sheet_type: "Sys_F32" }), "待计算");
assert.equal(displayCell(process, processRow, "sheet_upp_model", { category: "任务级观测量" }), "待计算");
assert.equal(displayCell(process, processRow, "sheet_upp_model", { category: "" }), "待计算");
const legacyString = { ...processRow, internal_type: "STRING", sheet_type: "Sys_U16", element_count: 15, max_value: "65534", edit_values: { ...point, internal_type: "STRING", sheet_type: "Sys_U16", element_count: 15, max_value: "65534" } };
assert.equal(pointIsString(process, legacyString.edit_values, legacyString), false);
assert.equal(displayCell(process, legacyString, "max_value", {}), "65534");
assert.equal(parseCell(process, "max_value", "65533", legacyString.edit_values), "65533");
// Definitions without sheet columns retain the generic table behavior.
const generic = { ...process, definition: { ...processDefinition, presentation: undefined,
  columns: ["name", "data_type", "byte_length", "min_value", "max_value"],
  editor: ["name", "group_key", "internal_type", "element_count", "default_value", "min_value", "max_value", "sig_id"],
  fields: { ...processDefinition.fields, group_key: { label: "点表分组", reference: "native_groups" }, internal_type: { label: "内部类型" }, sig_id: { label: "sigID", type: "number" } },
  inline: { data_type: "internal_type", resolved_sig_id: "sig_id" },
} };
assert.equal(hasRecommendation(generic), false);
assert.deepEqual(pointChoices(generic, "group_key", {}).map(group => group.id), ["LOCAL"]);
assert.equal(parseCell(generic, "group_key", "LOCAL", point), "LOCAL");
assert.equal(parseCell(generic, "group_key", "本机数据", point), "LOCAL");
assert.throws(() => parseCell(generic, "group_key", "MISSING", point), /未匹配/);
assert.equal(displayCell(generic, processRow, "default_value", { default_value: null }), "—");
assert.equal(displayCell(generic, processRow, "byte_length", { internal_type: "U16", element_count: 8 }), "16");
assert.equal(displayCell(generic, processRow, "data_type", { internal_type: "U16" }), "U16");
assert.equal(displayCell(generic, processRow, "resolved_sig_id", { sig_id: 4100 }), "4100");
assert.equal(displayCell(generic, processRow, "min_value", { internal_type: "STRING" }), "—");
assert.ok(!processDefinition.editor.includes("data_item_id"));
assert.ok(!processDefinition.editor.includes("group_id"));
assert.ok(!processDefinition.editor.includes("byte_length"));
const rawBefore = { id: 1, board_key: "DSP", enum_name: "DC_BUS_VOLTAGE", internal_type: "F32", metadata: {
  source_variable: "DcBusVoltage", ram: "N", cpu: "CPU2", enum_table: "bit0:有效", source_cells: { values: { N: "N", D: "bit0:有效" } },
} };
const rawAfter = { ...rawBefore, enum_name: "NEW_VARIABLE", internal_type: "U16", metadata: {
  ...rawBefore.metadata, source_variable: "NewVariable", ram: "Y", cpu: "CPU1", enum_table: "bit0:有效\nbit1:故障",
} };
const sheetSummary = pointChangeSummary({ entity: "process_points", before: rawBefore, after: rawAfter }, processDefinition.fields);
assert.ok(sheetSummary.includes("enum_name：DC_BUS_VOLTAGE → NEW_VARIABLE"), sheetSummary);
assert.ok(sheetSummary.includes("internal_type：F32 → U16"), sheetSummary);
assert.ok(sheetSummary.includes('metadata：{"source_variable":'), sheetSummary);
assert.ok(!sheetSummary.includes("[object Object]"), sheetSummary);
// Server-projected snapshots already carry the table's labels and require no client formulas.
assert.equal(pointChangeSummary({ before: { variable_name: "Before", sheet_type: "Sys_F32", ram: "N" }, after: { variable_name: "After", sheet_type: "Sys_U16", ram: "Y" } }, processDefinition.fields),
  "VariateName：Before → After；DateType：Sys_F32 → Sys_U16；RAM：N → Y");
const relatedSummary = pointChangeSummary({ entity: "transmit_points", before: { process_point_id: 1, access: "RO", metadata: { ram: "N" } }, after: { process_point_id: 1, access: "RW", metadata: { ram: "Y" } } }, processDefinition.fields);
assert.ok(relatedSummary.includes("RW：RO → RW"), relatedSummary);
assert.ok(relatedSummary.includes('metadata：{"ram":"N"} → {"ram":"Y"}'), relatedSummary);
assert.ok(!relatedSummary.includes("RAM："), relatedSummary);
assert.equal(pointChangeSummary({ entity: "process_points", before: { internal_type: "U16" }, after: { internal_type: "F32" } }, { internal_type: { label: "内部类型" } }), "内部类型：U16 → F32");
const forward = { ...process, kind: "forward", definition: forwardDefinition };
const mapping = { process_point_id: 1, endpoint_key: "UPP_SERVICE", name: "电压转发", upp_model: 1, address: 6, wire_type: "S32", wire_length: 4, scale: 0.001, access: "RO", byte_order: 0, conversion: "fixed_point", enabled: true };
const forwardRow = { ...mapping, signal_id: 1, signal_name: point.name, resolved_sig_id: point.sig_id, enum_name: point.enum_name, data_type: "F32", effective_address: 6, effective_type: "S32", effective_length: 4, edit_values: mapping };
assert.equal(pointDataType(forward, mapping), "F32");
assert.equal(pointDataType(forward, { process_point_id: 2 }), "STRING");
assert.deepEqual(pointChoices(forward, "process_point_id", {}).map(record => record.id), [1, 2]);
assert.equal(parseCell(forward, "process_point_id", "母线电压", mapping), 1);
assert.equal(parseCell(forward, "scale", "0.001", mapping), 0.001);
assert.equal(displayCell(forward, forwardRow, "upp_model", {}), "1");
assert.equal(displayCell(forward, forwardRow, "effective_address", { address: 10 }), "6");
assert.equal(displayCell(forward, forwardRow, "signal_name", { process_point_id: 2 }), "设备名称");
assert.equal(displayCell(forward, forwardRow, "enum_name", { process_point_id: 2 }), "DEVICE_NAME");
assert.equal(displayCell(forward, forwardRow, "data_type", { process_point_id: 2 }), "STRING");
assert.equal(displayCell(forward, forwardRow, "byte_length", { process_point_id: 2 }), "32");
assert.equal(hasRecommendation(forward), true);
assert.equal(hasRecommendation(process), false);
assert.equal(hasRecommendation({ ...forward, definition: { ...forwardDefinition, presentation: undefined } }), false);
assert.deepEqual(forwardDefinition.columns, ["signal_name", "variable_name", "category", "upp_model", "effective_address", "effective_length", "effective_type", "scale", "access"]);
for (const key of ["conversion", "byte_order"]) assert.ok(!forwardDefinition.editor.includes(key));
for (const key of ["name", "enabled", "byte_length", "resolved_sig_id", "enum_name", "sheet_type"]) assert.ok(!forwardDefinition.columns.includes(key));
for (const key of ["name", "enabled"]) {
  assert.ok(!forwardDefinition.editor.includes(key));
  assert.equal(fieldForColumn(forward, key), undefined);
}
assert.equal(forwardDefinition.fields.signal_name.label, processDefinition.fields.name.label);
assert.equal(forwardDefinition.fields.process_point_id.label, processDefinition.fields.name.label);
assert.equal(forwardDefinition.fields.variable_name.label, processDefinition.fields.variable_name.label);
assert.equal(forwardDefinition.fields.effective_address.label, "UPP偏移地址");
assert.equal(forwardDefinition.fields.effective_length.label, "UPP协议字节数");
assert.equal(displayCell(forward, forwardRow, "upp_model", { process_point_id: 2 }), "待计算");
assert.equal(displayCell(forward, forwardRow, "upp_model", { process_point_id: null }), "待计算");
assert.equal(displayCell(forward, forwardRow, "upp_model", { process_point_id: 999 }), "待计算");
assert.equal(displayCell(forward, forwardRow, "effective_length", { process_point_id: 2 }), "待计算");
assert.equal(displayCell(forward, forwardRow, "effective_length", { wire_length: 32 }), "待计算");
assert.equal(fieldForColumn(forward, "upp_model"), undefined);
assert.ok(!forwardDefinition.editor.includes("upp_model"));
assert.equal(displayCell(forward, forwardRow, "category", { process_point_id: 2 }), "任务级观测量");
assert.equal(displayCell(forward, forwardRow, "variable_name", { process_point_id: 2 }), "待计算");
assert.equal(displayCell(forward, forwardRow, "sheet_type", { process_point_id: 2 }), "—", "Undeclared source projections are not inferred by the browser");
assert.deepEqual(communicationRecommendation(forward, mapping), { wire_type: "S32", wire_length: 4, scale: 1 });
assert.deepEqual(communicationRecommendation(forward, { process_point_id: 2 }), { wire_type: "STRING", wire_length: 32, scale: 1 });
assert.equal(communicationRecommendation(generic, mapping), undefined);
assert.match(communicationHint(forward, { ...mapping, wire_type: "F32" }), /当前 F32 偏离建议/);
assert.equal(communicationDiffers(forward, { ...mapping, scale: 1 }), false);
assert.equal(communicationDiffers(forward, mapping), true);
assert.equal(communicationDiffers(forward, { ...mapping, scale: 1, wire_length: null }, mapping), false);
assert.equal(communicationRecommendation(forward, { process_point_id: null }, mapping), undefined);
assert.equal(pointChangeSummary({ entity: "transmit_points", before: { upp_model: 1 }, after: { upp_model: 99 } }, forwardDefinition.fields), "UPP模型号：1 → 99");
assert.equal(pointChangeSummary({ entity: "transmit_points",
  before: { name: "旧别名", enabled: false, conversion: "identity", byte_order: 2, scale: 1 },
  after: { name: "内部数据名称", enabled: true, conversion: "fixed_point", byte_order: 0, scale: 0.01 },
}, forwardDefinition.fields), "数据名称：旧别名 → 内部数据名称；参与转发：否 → 是；派生数据转换：identity → fixed_point；兼容字节序：2 → 0；协议系数：1 → 0.01");
const serverRecommendation = { ...point, recommended_wire_type: "U16", recommended_wire_length: 2, recommended_scale: 1, recommended_conversion: "identity" };
assert.deepEqual(communicationRecommendation({ ...forward, options: { ...options, process_points: [serverRecommendation] } }, mapping), { wire_type: "U16", wire_length: 2, scale: 1 });
const permissions = { role: "engineer", can_edit: true, can_manage_project: false, edit_scope: "scoped", grants: [{ board_key: "DSP", scope: "internal" }], catalog: [] };
assert.equal(allowsPoint(permissions, "DSP", "process", process, processRow), true);
assert.equal(allowsPoint(permissions, "DSP", "forward", forward, forwardRow), false);
assert.equal(allowsPoint({ ...permissions, grants: [{ board_key: "DSP", scope: "board" }] }, "DSP", "forward", forward, forwardRow), true);
assert.equal(allowsPoint({ ...permissions, can_edit: false }, "DSP", "process", process, processRow), false);
const protocolPermissions = { ...permissions, grants: [{ board_key: "DSP", scope: "protocol", endpoint_key: "UPP_SERVICE" }] };
assert.equal(allowsPoint(protocolPermissions, "DSP", "forward", forward, forwardRow), true);
assert.equal(allowsPoint(protocolPermissions, "DSP", "forward", forward), true);
assert.equal(allowsPoint(protocolPermissions, "DSP", "forward", forward, { ...forwardRow, edit_values: { ...mapping, endpoint_key: "OTHER" } }), false);
assert.equal(allowsPoint(protocolPermissions, "UPM", "forward", forward, forwardRow), false);
assert.equal(allowsPoint(protocolPermissions, "DSP", "process", process, processRow), false);
assert.deepEqual(pointChoices(forward, "endpoint_key", {}).map(endpoint => endpoint.id), ["UPP_SERVICE"]);
const custom = { ...forward, board_key: "CUSTOM_BOARD", definition: { ...forwardDefinition,
  fields: { ...forwardDefinition.fields, source: { label: "来源", reference: "custom_sources" } }, presentation: {
  suggestion: { reference: "custom_sources", source_key: "source", fields: { wire_type: "recommend_type", scale: "recommend_factor" }, description: "自定义规则建议" },
  computed_dependencies: { custom_output: ["custom_input"] },
} }, options: { custom_sources: [{ id: 19, recommend_type: "U8", recommend_factor: 7 }] } };
assert.deepEqual(communicationRecommendation(custom, { source: 19 }), { wire_type: "U8", scale: 7 });
assert.equal(communicationRecommendation({ ...custom, options: {} }, { source: 19 }), undefined, "Missing recommendations never fall back to a browser formula");
assert.equal(displayCell(custom, { custom_output: 100, edit_values: { custom_input: 5 } }, "custom_output", { custom_input: 6 }), "待计算");
assert.equal(displayCell(custom, { custom_output: 100, edit_values: { custom_input: 5 } }, "custom_output", {}), "100");
const customOverview = overviewDefinition({ revision: 1, process, forward: custom });
for (const key of ["signal_name", "variable_name", "category"])
  assert.ok(customOverview.columns.includes(`forward:${key}`), "New definitions retain their columns unless explicitly hidden");
const configuredOverview = overviewDefinition({ revision: 1, process, forward });
for (const key of forwardDefinition.presentation.overview_hidden_fields)
  assert.ok(!configuredOverview.columns.includes(`forward:${key}`));
const defaultOverview = overviewDefinition({ revision: 1, process: { ...process, definition: { ...processDefinition, presentation: undefined } }, forward: custom });
assert.deepEqual(defaultOverview.columns.slice(0, processDefinition.columns.length), processDefinition.columns.map(key => `process:${key}`));
assert.deepEqual(configuredOverview.columns.slice(0, 4), processDefinition.presentation.overview_leading_fields.map(key => `process:${key}`));
const protocolDefinition = { ...forwardDefinition, columns: ["upp_model", "custom_value", "scale"], editor: ["upp_model", "custom_value", "scale"],
  inline: { upp_model: "upp_model", custom_value: "custom_value", scale: "scale" },
  fields: { upp_model: { label: "模型", protocols: ["UPP"] }, custom_value: { label: "自定义", protocols: ["MODBUS"] }, scale: { label: "系数" } } };
assert.deepEqual(definitionForProtocol(protocolDefinition, "MODBUS").columns, ["custom_value", "scale"]);
assert.deepEqual(definitionForProtocol(protocolDefinition, "UPP").editor, ["upp_model", "scale"]);
assert.deepEqual(definitionForProtocol(protocolDefinition, "MODBUS").inline, { custom_value: "custom_value", scale: "scale" });
const protocolData = { ...forward, definition: protocolDefinition, options: {
  ...options, endpoints: [...options.endpoints, { code: "BUS", protocol: "MODBUS", name: "总线" }],
} };
const busRow = { ...forwardRow, endpoint_key: "BUS", custom_value: 3, edit_values: { ...mapping, endpoint_key: "BUS", custom_value: 3 } };
assert.equal(columnApplies(protocolData, "upp_model", busRow.edit_values), false);
assert.equal(columnApplies(protocolData, "custom_value", busRow.edit_values), true);
assert.equal(displayCell(protocolData, busRow, "upp_model", {}), "—");
assert.equal(displayCell(protocolData, busRow, "custom_value", {}), "3");
assert.throws(() => parseCell(protocolData, "upp_model", "2", busRow.edit_values), /不可直接编辑/);
assert.equal(overviewText({ revision: 1, process, forward: protocolData }, { "process:1": { name: "新名称" } },
  { key: "1:1", process: processRow, forward: busRow }, "forward:upp_model"), "—");
const aliasData = { ...protocolData, definition: { ...protocolDefinition,
  columns: ["effective_address"], editor: ["address"], inline: { effective_address: "address" },
  fields: { effective_address: { label: "地址", protocols: ["UPP"] }, address: { label: "地址", type: "number" } },
} };
assert.equal(columnApplies(aliasData, "effective_address", busRow.edit_values), false);
for (const [reference, sourceKey, source] of [
  ["endpoints", "endpoint_key", { code: "BUS", protocol: "MODBUS" }],
  ["native_groups", "group_key", { code: "GROUP" }],
]) {
  const suggestionData = { ...protocolData, definition: { ...protocolDefinition,
    fields: { ...protocolDefinition.fields, [sourceKey]: { label: "来源", reference } },
    presentation: { suggestion: { reference, source_key: sourceKey,
      fields: { upp_model: "model", custom_value: "value", scale: "factor" } } },
  }, options: { ...protocolData.options, [reference]: [{ ...source, model: 5, value: 7, factor: 2 }] } };
  const current = { [sourceKey]: source.code, endpoint_key: "BUS" };
  assert.deepEqual(communicationRecommendation(suggestionData, current), { custom_value: 7, scale: 2 });
  assert.deepEqual(editableCommunicationRecommendation(suggestionData, current), { custom_value: 7, scale: 2 });
}
console.log("PASS: declarative presentation, server recommendations, pending script values, protocol fields, generic tables and scoped permissions");

assert.ok(["builtin", "javascript"].includes(forwardDefinition.calculation.engine));
assert.equal(hasRecalculation(forwardDefinition), true);
assert.equal(hasRecalculation(processDefinition), false);
assert.equal(hasRecalculation({ ...processDefinition, behavior: { owned_fields: ["name"] } }), true);
assert.equal(hasRecalculation({ ...forwardDefinition, calculation: undefined, behavior: { owned_fields: [] } }), false);
for (const column of ["effective_address", "effective_length"]) assert.equal(fieldForColumn(forward, column), undefined);
assert.deepEqual(editableCommunicationRecommendation(forward, mapping), {wire_type:"S32", scale:1});
