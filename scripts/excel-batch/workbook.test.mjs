import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { columns, readRows, writeTemplate, withDefinitionDefaults } from "./workbook.mjs";

async function fixture(t, headers, rows) {
  const dir = await mkdtemp(join(tmpdir(), "point-excel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "points.xlsx");
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("process");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  await book.xlsx.writeFile(file);
  return { file, book, sheet };
}
const headers = ["group_key", "internal_type", "name", "enum_name", "sig_id"];
test("column keys, row numbers, booleans, ranges and blanks survive Excel", async t => {
  const { file } = await fixture(t, [...headers, "boot_restore", "min_value", "flags"], [
    ["LOCAL", "U16", "电压", "VOLTAGE", "0x10", "否", 0, 0], [],
    ["LOCAL", "U16", "电流", "CURRENT", 17, "true", "MIN_CURRENT"],
  ]);
  const rows = await readRows(file, "process");
  assert.deepEqual(rows.map(r => r.row), [2, 4]);
  assert.equal(rows[0].values.sig_id, 16);
  assert.equal(rows[0].values.boot_restore, false);
  assert.equal(rows[0].values.min_value, "0");
  assert.equal(rows[0].values.flags, "0");
  assert.equal(rows[1].values.boot_restore, true);
  assert.equal(Object.hasOwn(rows[1].values, "flags"), false);
});
test("formulas, invalid booleans, missing fields and unsafe numbers identify row", async t => {
  for (const extra of [{ formula: "1+1", result: 2 }, "perhaps", Number.MAX_SAFE_INTEGER + 1]) {
    const { file } = await fixture(t, [...headers, "boot_restore"], [["LOCAL", "U16", "V", "VOLTAGE", 1, extra]]);
    await assert.rejects(readRows(file, "process"), /第 2 行/);
  }
  const { file } = await fixture(t, headers, [["LOCAL", "U16", null, "VOLTAGE", 1]]);
  await assert.rejects(readRows(file, "process"), /name：缺少必填值/);
});
test("rejects unknown, duplicate and missing headers, unlabeled cells and oversized batches", async t => {
  for (const bad of [[...headers, "readonly"], [...headers, "name"], headers.filter(key => key !== "internal_type")]) {
    const { file } = await fixture(t, bad, []);
    await assert.rejects(readRows(file, "process"), /表头/);
  }
  const { file } = await fixture(t, headers, [["LOCAL", "U16", "V", "VOLTAGE", 1, "orphan"]]);
  await assert.rejects(readRows(file, "process"), /没有表头/);
  const large = await fixture(t, headers, Array.from({ length: 201 }, (_, i) => ["LOCAL", "U16", "V", `V_${i}`, i + 1]));
  await assert.rejects(readRows(large.file, "process"), /201 行/);
});
test("templates cover each table without overwriting existing files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "point-template-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const kind of ["process", "forward"]) {
    const file = join(dir, `${kind}.xlsx`);
    await writeTemplate(file, kind);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(file);
    const actualHeaders = book.getWorksheet(kind).getRow(1).values.slice(1);
    assert.deepEqual(actualHeaders, columns[kind]);
    if (kind === "process") {
      assert.equal(actualHeaders.includes("sig_id"), false);
      assert.equal(actualHeaders.includes("enum_name"), false);
      assert.equal(actualHeaders.includes("internal_type"), false);
      for (const derived of ["type_length", "byte_length", "precision", "sheet_data_type", "sheet_upp_model"]) {
        assert.equal(actualHeaders.includes(derived), false);
      }
    }
    if (kind === "forward") {
      for (const derived of ["upp_model", "name", "enabled", "conversion", "byte_order"]) assert.equal(actualHeaders.includes(derived), false);
    }
    await assert.rejects(writeTemplate(file, kind), { code: "EEXIST" });
    await assert.rejects(readRows(file, kind), /当前 0 行/);
    await assert.rejects(readRows(file, kind, "missing"), /找不到工作表/);
  }
});

test("DSP sheet fields preserve variable casing, formatted ranges and metadata", async t => {
  const values = {
    name: "DSP 电压", variable_name: "ParamVoltage", sheet_type: "Sys_F32",
    enum_table: "0：关闭\n1：开启", display_digits: 4, element_count: 1,
    default_value: "0.0000", max_value: "100.0000", min_value: "-17.0000", unit: "V",
    access: "RW", ram: "N", flash: "Y", eeprom: "N", calibration: "Y",
    structure: "Params", cpu: "CPU2", upload_level: "1：上传至UPM", category: "控制参数设置", notes: "首行\n第二行",
  };
  const { file } = await fixture(t, columns.process, [columns.process.map(key => values[key])]);
  const [row] = await readRows(file, "process");
  assert.deepEqual(row, { row: 2, values });
  assert.equal(Object.hasOwn(row.values, "sig_id"), false);
  assert.equal(Object.hasOwn(row.values, "group_key"), false);
});

test("DSP validation identifies invalid worksheet values without imposing them on forwarding", async t => {
  const base = { name: "DSP 电压", variable_name: "ParamVoltage", sheet_type: "Sys_F32" };
  for (const [key, value] of Object.entries({
    variable_name: "17Voltage", sheet_type: "F32", display_digits: 9,
    access: "WO", ram: "true", flash: "1", eeprom: "NO", calibration: "YES",
    cpu: "CPU3", upload_level: "1", category: "未定义分类",
  })) {
    const values = { ...base, [key]: value };
    const { file } = await fixture(t, Object.keys(values), [Object.values(values)]);
    await assert.rejects(readRows(file, "process"), /第 2 行/);
  }
  const { file } = await fixture(t, Object.keys(base), [["DSP 电压", null, "Sys_F32"]]);
  await assert.rejects(readRows(file, "process"), /variable_name 或 enum_name：缺少必填值/);
  const derived = await fixture(t, [...Object.keys(base), "precision"], [[...Object.values(base), 0.01]]);
  await assert.rejects(readRows(derived.file, "process"), /不属于 process 可写字段/);
});

test("native forwarding keeps stable references and fractional scale", async t => {
  const { file, book, sheet } = await fixture(t,
    ["process_point_id", "endpoint_key", "name", "upp_model", "address", "wire_type", "wire_length", "scale", "conversion", "access"],
    [[11, "UPP_SERVICE", "电压转发", 1, 14, "S32", 4, 0.01, "fixed_point", "WO"]]);
  sheet.name = "forward";
  await book.xlsx.writeFile(file);
  const [row] = await readRows(file, "forward");
  assert.equal(row.values.process_point_id, 11);
  assert.equal(row.values.endpoint_key, "UPP_SERVICE");
  assert.equal(row.values.scale, 0.01);
  assert.equal(row.values.address, 14);
  assert.equal(row.values.access, "WO");
});

test("DSP forwarding only requires its source, endpoint and address", async t => {
  const { file, book, sheet } = await fixture(t,
    ["process_point_id", "endpoint_key", "address"],
    [[11, "UPP_SERVICE", 14]]);
  sheet.name = "forward";
  await book.xlsx.writeFile(file);
  const [row] = await readRows(file, "forward");
  assert.deepEqual(row.values, { process_point_id: 11, endpoint_key: "UPP_SERVICE", address: 14 });
});

test("server definition defaults apply only to missing editable fields and preserve aliases", () => {
  const rows = [{ row: 2, values: { name: "V", variable_name: "Voltage", sheet_type: "Sys_F32", access: "RO", notes: null } }];
  const definition = {
    editor: ["name", "variable_name", "sheet_type", "access", "cpu", "notes", "display_digits", "category"],
    fields: {
      sheet_type: { default: "Sys_U16" }, access: { default: "RW" }, cpu: { default: "CPU1" },
      notes: { default: "备注" }, display_digits: { default: 0 }, category: { default: "" },
      flags: { default: "hidden" }, type_length: { default: 2 },
    },
  };
  const [prepared] = withDefinitionDefaults(rows, definition);
  assert.deepEqual(prepared.values, { ...rows[0].values, cpu: "CPU1", display_digits: 0, category: "" });
  assert.equal(Object.hasOwn(rows[0].values, "cpu"), false);
  assert.equal(Object.hasOwn(prepared.values, "flags"), false);
  assert.equal(Object.hasOwn(prepared.values, "type_length"), false);

  definition.fields.variable_name = { default: "NewVariable" };
  const legacy = [{ row: 3, values: { name: "Legacy", enum_name: "LEGACY", internal_type: "U8" } }];
  const [legacyPrepared] = withDefinitionDefaults(legacy, definition);
  assert.equal(Object.hasOwn(legacyPrepared.values, "variable_name"), false);
  assert.equal(Object.hasOwn(legacyPrepared.values, "sheet_type"), false);
  assert.equal(legacyPrepared.values.internal_type, "U8");
  assert.equal(legacyPrepared.values.access, "RW");

  const oldDefinition = { editor: ["enum_name", "internal_type"], fields: { enum_name: { default: "OLD" }, internal_type: { default: "U8" } } };
  assert.deepEqual(withDefinitionDefaults(rows, oldDefinition), rows);
});
