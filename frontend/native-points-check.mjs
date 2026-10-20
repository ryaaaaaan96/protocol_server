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
const { pointChoices, pointDataType, pointIsString, isDspSheet, isDspForward, pointChangeSummary, communicationRecommendation, communicationHint, communicationDiffers, editableCommunicationRecommendation } = await import(choicesUrl);
const { parseCell, displayCell, fieldForColumn } = await import(moduleUrl((await compile("./src/domain/pointGrid.ts")).replace('"./pointTables"', JSON.stringify(choicesUrl))));
const { allowsPoint } = await import(moduleUrl(await compile("./src/domain/permissions.ts")));
const { belongsToBoard, scopedRows } = await import(moduleUrl(await compile("./src/domain/board.ts")));
const processDefinition = JSON.parse(await readFile(new URL("../config/dc-ups/DSP/process.json", import.meta.url), "utf8"));
const forwardDefinition = JSON.parse(await readFile(new URL("../config/dc-ups/DSP/transmit.json", import.meta.url), "utf8"));
const point = {
  id: 1, board_key: "DSP", group_key: "LOCAL", name: "母线电压", enum_name: "DC_BUS_VOLTAGE", sig_id: 4097,
  variable_name: "DcBusVoltage", sheet_type: "Sys_F32", type_length: 4, display_digits: 0, precision: 1, sheet_data_type: "S32", category: "系统参数1", sheet_upp_model: 1, enum_table: "bit0:有效\nbit1:故障",
  data_type: "F32", internal_type: "F32", element_count: 1, byte_length: 4, unit: "V", default_value: "0", min_value: "0", max_value: "1000",
};
const alternate = { ...point, id: 2, name: "设备名称", enum_name: "DEVICE_NAME", variable_name: "DeviceName", sig_id: 4098, data_type: "STRING", internal_type: "STRING", sheet_type: "Sys_U16", sheet_data_type: "STRING", element_count: 16, byte_length: 32, category: "任务级观测量" };
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
assert.equal(isDspSheet(process), true);
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
assert.equal(displayCell(process, processRow, "byte_length", { sheet_type: "Sys_U16", element_count: 15 }), "30");
assert.equal(displayCell(process, processRow, "type_length", { sheet_type: "Sys_U16" }), "2");
assert.equal(displayCell(process, processRow, "precision", { display_digits: 3 }), "0.001");
assert.equal(displayCell(process, processRow, "precision", { display_digits: 7 }), "0.0000001");
assert.equal(displayCell(process, processRow, "precision", { display_digits: 8 }), "0.00000001");
assert.equal(displayCell(process, processRow, "sheet_data_type", { sheet_type: "Sys_U16", element_count: 15 }), "STRING");
assert.equal(displayCell(process, processRow, "sheet_data_type", { sheet_type: "Sys_U16" }), "U16");
assert.equal(displayCell(process, { ...processRow, sheet_type: "Sys_U16", edit_values: { ...point, sheet_type: "Sys_U16" } }, "sheet_data_type", { sheet_type: "Sys_F32" }), "S32");
assert.equal(displayCell(process, processRow, "sheet_upp_model", { category: "任务级观测量" }), "99");
assert.equal(displayCell(process, processRow, "sheet_upp_model", { category: "" }), "");
const legacyString = { ...processRow, internal_type: "STRING", sheet_type: "Sys_U16", element_count: 15, max_value: "65534", edit_values: { ...point, internal_type: "STRING", sheet_type: "Sys_U16", element_count: 15, max_value: "65534" } };
assert.equal(pointIsString(process, legacyString.edit_values, legacyString), false);
assert.equal(displayCell(process, legacyString, "max_value", {}), "65534");
assert.equal(parseCell(process, "max_value", "65533", legacyString.edit_values), "65533");
// Definitions without sheet columns retain the generic table behavior.
const generic = { ...process, definition: { ...processDefinition,
  columns: ["name", "data_type", "byte_length", "min_value", "max_value"],
  editor: ["name", "group_key", "internal_type", "element_count", "default_value", "min_value", "max_value", "sig_id"],
  fields: { ...processDefinition.fields, group_key: { label: "点表分组", reference: "native_groups" }, internal_type: { label: "内部类型" }, sig_id: { label: "sigID", type: "number" } },
  inline: { data_type: "internal_type", resolved_sig_id: "sig_id" },
} };
assert.equal(isDspSheet(generic), false);
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
for (const expected of ["VariateName：DcBusVoltage → NewVariable", "DateType：Sys_F32 → Sys_U16", "RAM：N → Y", "数据来自CPU：CPU2 → CPU1", "EnumTab：bit0:有效 → bit0:有效\nbit1:故障"]) assert.ok(sheetSummary.includes(expected), sheetSummary);
for (const hidden of ["[object Object]", "source_cells", "metadata", "enum_name", "internal_type"]) assert.ok(!sheetSummary.includes(hidden), sheetSummary);
assert.equal(pointChangeSummary({ entity: "process_points", before: rawBefore, after: { ...rawBefore, metadata: { ...rawBefore.metadata, source_cells: { values: { N: "Y" } } } } }, processDefinition.fields), "");
assert.equal(pointChangeSummary({ entity: "process_points", before: { ...rawBefore, metadata: { source_cells: { values: { N: "N" } } } }, after: { ...rawBefore, metadata: { source_cells: { values: { N: "N" } }, ram: "Y" } } }, processDefinition.fields), "RAM：N → Y");
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
assert.equal(isDspForward(forward), true);
assert.equal(isDspForward(process), false);
assert.equal(isDspForward({ ...forward, definition: { ...forwardDefinition, fields: {} } }), false);
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
assert.equal(displayCell(forward, forwardRow, "upp_model", { process_point_id: 2 }), "99");
assert.equal(displayCell(forward, forwardRow, "upp_model", { process_point_id: null }), "待计算");
assert.equal(displayCell(forward, forwardRow, "upp_model", { process_point_id: 999 }), "待计算");
assert.equal(displayCell(forward, forwardRow, "effective_length", { process_point_id: 2 }), "4", "Changing the source never replaces the actual protocol length with its internal length");
assert.equal(displayCell(forward, forwardRow, "effective_length", { wire_length: 32 }), "4");
assert.equal(fieldForColumn(forward, "upp_model"), undefined);
assert.ok(!forwardDefinition.editor.includes("upp_model"));
assert.equal(displayCell(forward, forwardRow, "category", { process_point_id: 2 }), "任务级观测量");
assert.equal(displayCell(forward, forwardRow, "variable_name", { process_point_id: 2 }), "DeviceName");
assert.equal(displayCell(forward, forwardRow, "sheet_type", { process_point_id: 2 }), "Sys_U16");
assert.deepEqual(communicationRecommendation(forward, mapping), { wire_type: "S32", wire_length: 4, scale: 1 });
assert.deepEqual(communicationRecommendation(forward, { process_point_id: 2 }), { wire_type: "STRING", wire_length: 32, scale: 1 });
assert.equal(communicationRecommendation(generic, mapping), undefined);
assert.match(communicationHint(forward, { ...mapping, wire_type: "F32" }), /当前 F32 偏离建议/);
assert.equal(communicationDiffers(forward, { ...mapping, scale: 1 }), false);
assert.equal(communicationDiffers(forward, mapping), true);
assert.equal(communicationDiffers(forward, { ...mapping, scale: 1, wire_length: null }, mapping), false);
assert.equal(communicationRecommendation(forward, { process_point_id: null }, mapping), undefined);
assert.equal(pointChangeSummary({ entity: "transmit_points", before: { upp_model: 1 }, after: { upp_model: 99 } }, forwardDefinition.fields), "UPP模型号：1 → 99；数据分类：系统参数1 → 任务级观测量");
assert.equal(pointChangeSummary({ entity: "transmit_points",
  before: { name: "旧别名", enabled: false, conversion: "identity", byte_order: 2, scale: 1 },
  after: { name: "内部数据名称", enabled: true, conversion: "fixed_point", byte_order: 0, scale: 0.01 },
}, forwardDefinition.fields), "协议系数：1 → 0.01");
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
console.log("PASS: DSP sheet projections, hidden protocol fields, communication recommendations, category summaries, editable aliases, array bounds, generic tables and scoped permissions");

assert.equal(forwardDefinition.calculation.engine, "javascript");
assert.equal(forwardDefinition.calculation.script_file, "transmit.js");
for (const column of ["effective_address", "effective_length"]) assert.equal(fieldForColumn(forward, column), undefined);
assert.deepEqual(editableCommunicationRecommendation(forward, mapping), {wire_type:"S32", scale:1});
