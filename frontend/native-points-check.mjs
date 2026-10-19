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
const { pointChoices, pointDataType } = await import(choicesUrl);
const { parseCell, displayCell } = await import(moduleUrl((await compile("./src/domain/pointGrid.ts")).replace('"./pointTables"', JSON.stringify(choicesUrl))));
const { allowsPoint } = await import(moduleUrl(await compile("./src/domain/permissions.ts")));
const { belongsToBoard, scopedRows } = await import(moduleUrl(await compile("./src/domain/board.ts")));
const processDefinition = JSON.parse(await readFile(new URL("../config/dc-ups/DSP/process.json", import.meta.url), "utf8"));
const forwardDefinition = JSON.parse(await readFile(new URL("../config/dc-ups/DSP/transmit.json", import.meta.url), "utf8"));
const point = {
  id: 1, board_key: "DSP", group_key: "LOCAL", name: "母线电压", enum_name: "DC_BUS_VOLTAGE", sig_id: 4097,
  data_type: "F32", internal_type: "F32", element_count: 1, byte_length: 4, unit: "V", default_value: "0", min_value: "0", max_value: "1000",
};
const alternate = { ...point, id: 2, name: "设备名称", enum_name: "DEVICE_NAME", sig_id: 4098, data_type: "STRING", internal_type: "STRING", element_count: 32, byte_length: 32 };
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
assert.deepEqual(pointChoices(process, "group_key", {}).map(group => group.id), ["LOCAL"]);
assert.equal(parseCell(process, "group_key", "LOCAL", point), "LOCAL");
assert.equal(parseCell(process, "group_key", "本机数据", point), "LOCAL");
assert.throws(() => parseCell(process, "group_key", "MISSING", point), /未匹配/);
assert.equal(displayCell(process, processRow, "default_value", { default_value: null }), "—");
assert.equal(displayCell(process, processRow, "byte_length", { internal_type: "U16", element_count: 8 }), "16");
assert.equal(displayCell(process, processRow, "data_type", { internal_type: "U16" }), "U16");
assert.equal(displayCell(process, processRow, "resolved_sig_id", { sig_id: 4100 }), "4100");
assert.equal(displayCell(process, processRow, "min_value", { internal_type: "STRING" }), "—");
assert.ok(!processDefinition.editor.includes("data_item_id"));
assert.ok(!processDefinition.editor.includes("group_id"));
assert.ok(!processDefinition.editor.includes("byte_length"));
const forward = { ...process, kind: "forward", definition: forwardDefinition };
const mapping = { process_point_id: 1, endpoint_key: "UPP_SERVICE", name: "电压转发", upp_model: 5, address: 6, wire_type: "S32", wire_length: 4, scale: 0.001, access: "RO", byte_order: 0, conversion: "fixed_point", enabled: true };
const forwardRow = { ...mapping, signal_id: 1, signal_name: point.name, resolved_sig_id: point.sig_id, enum_name: point.enum_name, data_type: "F32", effective_address: 6, effective_type: "S32", effective_length: 4, edit_values: mapping };
assert.equal(pointDataType(forward, mapping), "F32");
assert.equal(pointDataType(forward, { process_point_id: 2 }), "STRING");
assert.deepEqual(pointChoices(forward, "process_point_id", {}).map(record => record.id), [1, 2]);
assert.equal(parseCell(forward, "process_point_id", "母线电压", mapping), 1);
assert.equal(parseCell(forward, "scale", "0.001", mapping), 0.001);
assert.equal(parseCell(forward, "byte_order", "2", mapping), 2);
assert.equal(displayCell(forward, forwardRow, "upp_model", {}), "5");
assert.equal(displayCell(forward, forwardRow, "effective_address", { address: 10 }), "10");
assert.equal(displayCell(forward, forwardRow, "signal_name", { process_point_id: 2 }), "设备名称");
assert.equal(displayCell(forward, forwardRow, "enum_name", { process_point_id: 2 }), "DEVICE_NAME");
assert.equal(displayCell(forward, forwardRow, "data_type", { process_point_id: 2 }), "STRING");
assert.equal(displayCell(forward, forwardRow, "byte_length", { process_point_id: 2 }), "32");
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
console.log("PASS: native DSP references, draft projection, nullable values, fractional scale, numeric choices and scoped permissions");
