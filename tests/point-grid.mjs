import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../frontend/node_modules/typescript/lib/typescript.js";

const toModuleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
const choices = toModuleUrl(
  compile(
    await readFile(
      new URL("../frontend/src/domain/pointTables.ts", import.meta.url),
      "utf8",
    ),
  ),
);
const { pointDataType, pointIsString, isStringType } = await import(choices);
const gridSource = compile(
  await readFile(
    new URL("../frontend/src/domain/pointGrid.ts", import.meta.url),
    "utf8",
  ),
);
const {
  parseClipboard,
  serializeClipboard,
  fieldForColumn,
  parseCell,
  displayCell,
} = await import(
  toModuleUrl(gridSource.replace('"./pointTables"', JSON.stringify(choices)))
);
const definitions = Object.fromEntries(await Promise.all(
  [["process", "process"], ["forward", "transmit"]].map(async ([kind, filename]) => [
    kind, JSON.parse(await readFile(new URL(`../config/upm/DSP/${filename}.json`, import.meta.url), "utf8")),
  ]),
));

assert.deepEqual(parseClipboard("a\tb\t\r\nc\td\t\r\n"), [
  ["a", "b", ""],
  ["c", "d", ""],
]);
assert.deepEqual(parseClipboard("a\n\n"), [["a"], [""]]);
assert.deepEqual(parseClipboard(""), [[""]]);
assert.deepEqual(parseClipboard('"a\tb"\t"first\r\nsecond"\t"a""b"'), [
  ["a\tb", "first\r\nsecond", 'a"b'],
]);
const rectangle = [["", "a\tb", '"quoted"'], ["line\nnext", "", ""], [""]];
assert.deepEqual(parseClipboard(serializeClipboard(rectangle)), rectangle);
assert.throws(() => parseClipboard('"unfinished'), /未闭合/);
assert.throws(() => parseClipboard('"closed"tail'), /引号/);
assert.throws(() => parseClipboard(Array(201).fill("x").join("\n")), /200 行/);
assert.equal(
  parseClipboard(Array(200).fill("x").join("\n") + "\n").length,
  200,
);
assert.throws(() => parseClipboard(Array(129).fill("x").join("\t")), /128 列/);

const points = [
  { id: 10, name: "温度", sig_id: 12, enum_name: "TEMP", internal_type: "U16", data_type: "U16", byte_length: 2, unit: "℃" },
  { id: 11, name: "温度", sig_id: 18, enum_name: "TEMP_SECOND", internal_type: "S32", data_type: "S32", byte_length: 4, unit: "℃" },
  { id: 12, name: "设备名称", sig_id: null, enum_name: "DEVICE_NAME", internal_type: "STRING", data_type: "STRING", byte_length: 64 },
];
function fixture(kind) {
  return {
    revision: 1, board_key: "DSP", storage: "native", kind,
    definition: definitions[kind], rows: [],
    options: {
      native_groups: [{ code: "LOCAL", name: "本机" }, { code: "SECOND", name: "第二组" }],
      process_points: points,
      endpoints: [{ code: "UPP_SERVICE", name: "UPP 转发", protocol: "UPP" }],
    },
  };
}
const process = fixture("process"), forward = fixture("forward");
const values = {
  name: "温度点", group_key: "LOCAL", sig_id: 12, enum_name: "TEMP",
  internal_type: "U16", element_count: 1, default_value: "8", min_value: "0", max_value: "100", boot_restore: false,
};
const row = { ...values, group_name: "本机", resolved_sig_id: 12, data_type: "U16", byte_length: 2, unit: "℃", edit_values: values };
assert.equal(fieldForColumn(process, "resolved_sig_id"), "sig_id");
assert.equal(fieldForColumn(process, "byte_length"), undefined);
assert.equal(parseCell(process, "name", "  中文 名称  ", values), "  中文 名称  ");
assert.equal(parseCell(process, "sig_id", "", values), null);
assert.equal(parseCell(process, "sig_id", "0x20", values), 32);
for (const invalid of ["NaN", "Infinity", "-Infinity", "no", "9007199254740993"])
  assert.throws(() => parseCell(process, "sig_id", invalid, values), /有效数字/);
for (const yes of ["是", "true", "TRUE", "1"])
  assert.equal(parseCell(process, "boot_restore", yes, values), true);
for (const no of ["否", "false", "FALSE", "0"])
  assert.equal(parseCell(process, "boot_restore", no, values), false);
assert.throws(() => parseCell(process, "boot_restore", "", values), /请输入/);
assert.throws(() => parseCell(process, "internal_type", "", values), /只能选择/);
assert.equal(parseCell(process, "internal_type", " S32 ", values), "S32");
assert.throws(() => parseCell(process, "internal_type", "S64", values), /只能选择/);
assert.equal(parseCell(process, "group_key", "第二组", values), "SECOND");
assert.equal(parseCell(process, "group_key", "LOCAL", values), "LOCAL");
assert.throws(() => parseCell(process, "group_key", "MISSING", values), /未匹配/);
assert.throws(() => parseCell(process, "byte_length", "99", values), /不可直接编辑/);
assert.equal(displayCell(process, row, "default_value", values), "8");
assert.equal(displayCell(process, row, "default_value", { default_value: null }), "—");
assert.equal(displayCell(process, row, "data_type", { internal_type: "U8" }), "U8");
assert.equal(displayCell(process, row, "byte_length", { internal_type: "U8" }), "1");
assert.equal(displayCell(process, row, "byte_length", { element_count: 12 }), "24");
assert.equal(displayCell(process, row, "byte_length", { element_count: 0 }), "待计算");
assert.equal(displayCell(process, row, "group_name", { group_key: "SECOND" }), "第二组");
assert.equal(displayCell(process, row, "resolved_sig_id", { sig_id: null }), "—");
assert.equal(displayCell(process, row, "resolved_sig_id", { sig_id: 42 }), "42");
assert.equal(row.default_value, "8", "draft projection never mutates the snapshot");
for (const key of ["group_name", "data_type", "min_value"])
  assert.equal(displayCell(process, row, key, { name: "改名" }), String(row[key]), "hidden editor fields retain their snapshot values");
const mapping = { process_point_id: 10, endpoint_key: "UPP_SERVICE", name: "温度转发", address: 6, upp_model: 3, wire_type: "U16", wire_length: 2, scale: 1, byte_order: 0, conversion: "identity" };
const boundRow = { ...mapping, signal_name: "温度", resolved_sig_id: 12, data_type: "U16", byte_length: 2, enum_name: "TEMP", unit: "℃", effective_address: 6, effective_type: "U16", effective_length: 2, edit_values: mapping };
assert.throws(() => parseCell(forward, "process_point_id", "温度", mapping), /同名/);
assert.equal(parseCell(forward, "process_point_id", "温度 · 18", mapping), 11);
assert.equal(parseCell(forward, "process_point_id", "11", mapping), 11);
assert.throws(() => parseCell(forward, "process_point_id", "99", mapping), /未匹配/);
assert.equal(parseCell(forward, "endpoint_key", "UPP 转发", mapping), "UPP_SERVICE");
assert.equal(parseCell(forward, "endpoint_key", "UPP_SERVICE", mapping), "UPP_SERVICE");
assert.throws(() => parseCell(forward, "endpoint_key", "REMOVED_ENDPOINT", mapping), /未匹配/);
assert.equal(parseCell(forward, "scale", "0.025", mapping), 0.025);
assert.equal(parseCell(forward, "byte_order", "2", mapping), 2);
assert.equal(displayCell(forward, boundRow, "resolved_sig_id", { process_point_id: 11 }), "18");
assert.equal(displayCell(forward, boundRow, "data_type", { process_point_id: 11 }), "S32");
assert.equal(displayCell(forward, boundRow, "byte_length", { process_point_id: 11 }), "4");
assert.equal(displayCell(forward, boundRow, "effective_address", { address: 128 }), "128");
assert.equal(displayCell(forward, boundRow, "upp_model", { upp_model: 4 }), "4");
assert.equal(displayCell(forward, boundRow, "effective_type", { wire_type: "S32" }), "S32");
assert.equal(displayCell(forward, boundRow, "effective_length", { wire_length: 4 }), "4");
assert.equal(displayCell(forward, boundRow, "data_type", { process_point_id: 999 }), "待计算");
assert.equal(pointDataType(forward, { process_point_id: 999 }, boundRow), undefined);
assert.equal(pointDataType(forward, { name: "未改变关联" }, boundRow), "U16");
const stringValues = { ...values, internal_type: "STRING", element_count: 64, default_value: "Factory name", min_value: null, max_value: null };
const stringRow = { ...row, ...stringValues, data_type: "STRING", byte_length: 64, edit_values: stringValues };
assert.equal(isStringType(" string "), true);
assert.equal(isStringType(null), false);
assert.equal(isStringType("U16"), false);
assert.equal(pointDataType(process, stringValues), "STRING");
assert.equal(pointIsString(process, { name: "改名" }, stringRow), true);
assert.equal(pointIsString(process, { ...stringValues, internal_type: "U16" }), false);
assert.equal(pointIsString(process, { ...values, internal_type: " string " }), true);
for (const column of ["min_value", "max_value"]) {
  assert.equal(displayCell(process, stringRow, column, stringValues), "—");
  assert.equal(displayCell(process, stringRow, column, { name: "改名" }), "—");
  assert.equal(displayCell(process, row, column, { internal_type: "STRING", [column]: "7" }), "—");
  assert.throws(() => parseCell(process, column, "12", stringValues), /字符串类型不设置上下限/);
  for (const empty of [null, "", "  "])
    assert.equal(parseCell(process, column, empty, stringValues), null);
}
assert.equal(displayCell(process, stringRow, "default_value", stringValues), "Factory name");
assert.equal(displayCell(process, stringRow, "byte_length", stringValues), "64");
assert.equal(displayCell(process, stringRow, "byte_length", { element_count: 32 }), "32");
assert.equal(parseCell(process, "default_value", "  保留字符串默认值  ", stringValues), "  保留字符串默认值  ");
assert.equal(pointDataType(forward, { process_point_id: 12 }, boundRow), "STRING");
assert.equal(displayCell(forward, boundRow, "signal_name", { process_point_id: 12 }), "设备名称");
assert.equal(displayCell(forward, boundRow, "byte_length", { process_point_id: 12 }), "64");
assert.equal(displayCell(forward, boundRow, "min_value", { process_point_id: 12 }), "—");
console.log("Point grid clipboard parsing, native references, explicit ranges, string bounds and draft projections passed.");
