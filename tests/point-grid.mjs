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
const schema = JSON.parse(
  await readFile(
    new URL("../config/point-tables.json", import.meta.url),
    "utf8",
  ),
);

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

function fixture(kind) {
  return {
    revision: 1,
    kind,
    definition: { ...schema.tables[kind], fields: schema.fields },
    rows: [],
    options: {
      groups: [
        { id: 1, name: "本机", code: "LOCAL" },
        { id: 2, name: "下级", code: "CHILD" },
      ],
      data: [
        {
          id: 10,
          name: "温度",
          data_type: "U16",
          byte_length: 2,
          default_value: "5",
          min_value: "0",
          max_value: "100",
        },
        {
          id: 11,
          name: "温度",
          data_type: "S32",
          byte_length: 4,
          default_value: "20",
          min_value: "-100",
          max_value: "500",
        },
      ],
      contexts: [
        { id: 20, name: "本机设备", code: "SELF", group_id: 1, dev_id: 0 },
        { id: 21, name: "子设备", code: "CHILD", group_id: 2, dev_id: 2 },
      ],
      signals: [
        { id: 30, name: "本机温度", group_id: 1, sig_id: 12 },
        { id: 31, name: "子设备温度", group_id: 2, sig_id: 18 },
        { id: 32, name: "子设备电流", group_id: 2, sig_id: 19 },
      ],
      endpoints: [
        {
          id: 40,
          name: "采集 A",
          role: "client",
          contract_id: 50,
          transport: "CAN",
          port: "CAN1",
        },
        {
          id: 41,
          name: "采集 B",
          role: "client",
          contract_id: 51,
          transport: "RS485",
          port: "UART1",
        },
        {
          id: 42,
          name: "转发",
          role: "server",
          contract_id: 50,
          transport: "CANFD",
        },
      ],
      fields: [
        {
          id: 60,
          name: "温度字段",
          contract_id: 50,
          protocol: "UPP",
          model: 1,
          effective_address: 6,
          effective_type: "U16",
          effective_length: 2,
        },
        {
          id: 61,
          name: "新温度字段",
          contract_id: 51,
          protocol: "MODBUS",
          effective_address: 128,
          effective_type: "S32",
          effective_length: 4,
        },
      ],
    },
  };
}
const process = fixture("process");
const values = {
  name: "温度点",
  group_id: 1,
  data_item_id: 10,
  sig_id: 12,
  sig_symbol: null,
  internal_type: null,
  default_value: "8",
  min_value: null,
  max_value: null,
  boot_restore: false,
};
const row = {
  ...values,
  group_name: "本机",
  resolved_sig_id: 12,
  data_type: "U16",
  byte_length: 2,
  unit: "℃",
  default_value: "8",
  min_value: "0",
  max_value: "100",
  contexts: "本机设备 [0]",
  edit_values: values,
};
assert.equal(fieldForColumn(process, "resolved_sig_id"), "sig_id");
assert.equal(fieldForColumn(process, "byte_length"), undefined);
assert.equal(
  parseCell(process, "name", "  中文 名称  ", values),
  "  中文 名称  ",
);
assert.equal(parseCell(process, "sig_id", "", values), null);
assert.equal(parseCell(process, "sig_id", "0x20", values), 32);
for (const invalid of [
  "NaN",
  "Infinity",
  "-Infinity",
  "no",
  "9007199254740993",
])
  assert.throws(
    () => parseCell(process, "sig_id", invalid, values),
    /有效数字/,
  );
for (const yes of ["是", "true", "TRUE", "1"])
  assert.equal(parseCell(process, "boot_restore", yes, values), true);
for (const no of ["否", "false", "FALSE", "0"])
  assert.equal(parseCell(process, "boot_restore", no, values), false);
assert.throws(() => parseCell(process, "boot_restore", "", values), /请输入/);
assert.equal(parseCell(process, "internal_type", "", values), null);
assert.equal(parseCell(process, "internal_type", " S32 ", values), "S32");
assert.throws(
  () => parseCell(process, "internal_type", "S64", values),
  /只能选择/,
);
assert.throws(() => parseCell(process, "data_item_id", "温度", values), /同名/);
assert.equal(parseCell(process, "data_item_id", "温度 · S32", values), 11);
assert.equal(parseCell(process, "data_item_id", "11", values), 11);
assert.throws(() => parseCell(process, "data_item_id", "99", values), /未匹配/);
assert.equal(displayCell(process, row, "default_value", { ...values }), "8");
assert.equal(
  displayCell(process, row, "default_value", {
    ...values,
    default_value: null,
  }),
  "5",
);
assert.equal(
  displayCell(process, row, "min_value", { ...values, data_item_id: 11 }),
  "-100",
);
assert.equal(
  displayCell(process, row, "data_type", { ...values, internal_type: "U8" }),
  "U8",
);
assert.equal(
  displayCell(process, row, "data_type", { ...values, data_item_id: 11 }),
  "S32",
);
assert.equal(
  displayCell(process, row, "byte_length", { ...values, internal_type: "U8" }),
  "2",
);
assert.equal(
  displayCell(process, row, "byte_length", { ...values, data_item_id: 11 }),
  "4",
);
assert.equal(
  displayCell(process, row, "unit", { ...values, data_item_id: 11 }),
  "待计算",
);
assert.equal(
  displayCell(process, row, "group_name", { ...values, group_id: 2 }),
  "下级",
);
assert.equal(
  displayCell(process, row, "contexts", { ...values, group_id: 2 }),
  "子设备 [2]",
);
assert.equal(
  displayCell(process, row, "resolved_sig_id", {
    ...values,
    sig_id: null,
    sig_symbol: "PUBLIC_TEMP",
  }),
  "PUBLIC_TEMP（待解析）",
);
assert.equal(
  displayCell(process, row, "resolved_sig_id", { ...values, sig_id: 42 }),
  "42",
);
assert.equal(row.default_value, "8", "display must not mutate the snapshot");
assert.equal(displayCell(process, row, "group_name", { name: "改名" }), "本机");
assert.equal(displayCell(process, row, "data_type", { name: "改名" }), "U16");
assert.equal(displayCell(process, row, "min_value", { name: "改名" }), "0");

const collect = fixture("collect");
const binding = {
  endpoint_id: 40,
  context_id: 21,
  signal_id: 31,
  field_id: 60,
  poll_interval: 5,
};
const boundRow = {
  ...binding,
  signal_name: "子设备温度",
  context_name: "子设备",
  dev_id: 2,
  data_type: "U16",
  resolved_sig_id: 18,
  field_name: "温度字段",
  protocol: "UPP",
  upp_model: 1,
  effective_address: 6,
  edit_values: binding,
};
assert.equal(parseCell(collect, "signal_id", "子设备温度 · 18", binding), 31);
assert.throws(
  () => parseCell(collect, "signal_id", "本机温度", binding),
  /未匹配/,
);
assert.throws(
  () => parseCell(collect, "endpoint_id", "转发", binding),
  /未匹配/,
);
assert.throws(() => parseCell(collect, "field_id", "61", binding), /未匹配/);
assert.equal(
  parseCell(collect, "field_id", "61", { ...binding, endpoint_id: 41 }),
  61,
);
assert.equal(
  displayCell(collect, boundRow, "signal_name", { ...binding, signal_id: 32 }),
  "子设备电流",
);
assert.equal(
  displayCell(collect, boundRow, "resolved_sig_id", {
    ...binding,
    signal_id: 32,
  }),
  "19",
);
assert.equal(
  displayCell(collect, boundRow, "data_type", { ...binding, signal_id: 32 }),
  "待计算",
);
assert.equal(
  displayCell(collect, boundRow, "dev_id", { ...binding, context_id: 20 }),
  "0",
);
assert.equal(
  displayCell(collect, boundRow, "effective_address", {
    ...binding,
    endpoint_id: 41,
  }),
  "待计算",
);
assert.equal(
  displayCell(collect, boundRow, "effective_address", {
    ...binding,
    endpoint_id: 41,
    field_id: 61,
  }),
  "128",
);
assert.equal(
  displayCell(collect, boundRow, "upp_model", {
    ...binding,
    endpoint_id: 41,
    field_id: 61,
  }),
  "—",
);
assert.equal(
  displayCell(collect, boundRow, "protocol", {
    ...binding,
    endpoint_id: 41,
    field_id: 61,
  }),
  "MODBUS",
);
assert.equal(
  displayCell(collect, boundRow, "poll_interval", {
    ...binding,
    poll_interval: 0,
  }),
  "0",
);
for (const column of process.definition.columns)
  assert.equal(
    displayCell(process, row, column, { ...values }),
    row[column] == null
      ? "—"
      : typeof row[column] === "boolean"
        ? row[column]
          ? "是"
          : "否"
        : String(row[column]),
  );
const stringProcess = fixture("process");
stringProcess.options.data.push({
  id: 12,
  name: "设备名称",
  data_type: " STRING ",
  byte_length: 64,
  default_value: "Factory name",
  min_value: "legacy lower",
  max_value: "legacy upper",
});
const stringValues = {
  ...values,
  data_item_id: 12,
  default_value: null,
  min_value: null,
  max_value: null,
};
const stringRow = {
  ...row,
  ...stringValues,
  data_type: "STRING",
  byte_length: 64,
  default_value: "Factory name",
  min_value: "legacy lower",
  max_value: "legacy upper",
  range_inherited: "默认值、下限、上限",
  edit_values: stringValues,
};
assert.equal(isStringType(" string "), true);
assert.equal(isStringType(null), false);
assert.equal(isStringType("U16"), false);
assert.equal(pointDataType(stringProcess, stringValues), "STRING");
assert.equal(pointIsString(stringProcess, { name: "改名" }, stringRow), true);
assert.equal(
  pointIsString(stringProcess, { ...stringValues, internal_type: "U16" }),
  false,
);
assert.equal(
  pointIsString(stringProcess, { ...values, internal_type: " string " }),
  true,
);
assert.equal(
  pointIsString(stringProcess, { data_item_id: 999 }, stringRow),
  false,
);
for (const column of ["min_value", "max_value"]) {
  assert.equal(
    displayCell(stringProcess, stringRow, column, stringValues),
    "—",
  );
  assert.equal(
    displayCell(stringProcess, stringRow, column, { name: "改名" }),
    "—",
  );
  assert.equal(
    displayCell(stringProcess, row, column, {
      ...values,
      internal_type: "STRING",
      [column]: "7",
    }),
    "—",
  );
  assert.throws(
    () => parseCell(stringProcess, column, "12", stringValues),
    /字符串类型不设置上下限/,
  );
  assert.throws(
    () =>
      parseCell(stringProcess, column, "0", {
        ...values,
        internal_type: "STRING",
      }),
    /字符串类型不设置上下限/,
  );
  for (const empty of [null, "", "  "])
    assert.equal(parseCell(stringProcess, column, empty, stringValues), null);
}
assert.equal(
  displayCell(stringProcess, stringRow, "range_inherited", stringValues),
  "默认值",
);
assert.equal(
  displayCell(stringProcess, stringRow, "range_inherited", {
    ...stringValues,
    default_value: "custom",
  }),
  "",
);
assert.equal(
  displayCell(stringProcess, stringRow, "default_value", stringValues),
  "Factory name",
);
assert.equal(
  displayCell(stringProcess, stringRow, "byte_length", stringValues),
  "64",
);
assert.equal(
  parseCell(
    stringProcess,
    "default_value",
    "  保留字符串默认值  ",
    stringValues,
  ),
  "  保留字符串默认值  ",
);
const overrideValues = {
  ...values,
  internal_type: "STRING",
  default_value: null,
};
const overrideRow = {
  ...row,
  internal_type: "STRING",
  data_type: "STRING",
  min_value: null,
  max_value: null,
  range_inherited: "默认值",
  edit_values: overrideValues,
};
assert.equal(
  displayCell(stringProcess, overrideRow, "min_value", {
    ...overrideValues,
    internal_type: "U16",
  }),
  "0",
);
assert.equal(
  displayCell(stringProcess, overrideRow, "max_value", {
    ...overrideValues,
    internal_type: null,
  }),
  "100",
);
assert.equal(
  displayCell(stringProcess, overrideRow, "range_inherited", {
    ...overrideValues,
    internal_type: "U16",
  }),
  "默认值、下限、上限",
);
for (const kind of ["collect", "forward"]) {
  const mapping = fixture(kind);
  mapping.options.signals.push({
    id: 33,
    name: "设备名称",
    group_id: 2,
    sig_id: 20,
    data_type: " string ",
    byte_length: 64,
    default_value: "Factory name",
    min_value: "legacy lower",
    max_value: "legacy upper",
    range_inherited: "默认值、下限、上限",
  });
  const next = { ...binding, signal_id: 33 };
  assert.equal(pointDataType(mapping, next, boundRow), "STRING");
  assert.equal(
    pointIsString(
      mapping,
      { name: "未改变关联" },
      { ...boundRow, data_type: "STRING" },
    ),
    true,
  );
  assert.equal(
    pointIsString(
      mapping,
      { ...binding, signal_id: 32 },
      { ...boundRow, data_type: "STRING" },
    ),
    false,
  );
  assert.equal(displayCell(mapping, boundRow, "min_value", next), "—");
  assert.equal(displayCell(mapping, boundRow, "max_value", next), "—");
  assert.equal(
    displayCell(mapping, boundRow, "range_inherited", next),
    "默认值",
  );
  assert.equal(
    displayCell(mapping, boundRow, "default_value", next),
    "Factory name",
  );
  assert.equal(displayCell(mapping, boundRow, "byte_length", next), "64");
}

console.log(
  "Point grid parsing, relationship choices, and draft projections passed.",
);
