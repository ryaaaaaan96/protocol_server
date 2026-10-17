import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { readRows, writeTemplate } from "./workbook.mjs";

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
const headers = ["group_id", "data_item_id", "name", "enum_name", "sig_id"];
test("column keys, row numbers, booleans, ranges and blanks survive Excel", async t => {
  const { file } = await fixture(t, [...headers, "boot_restore", "min_value", "flags"], [
    ["1", 2, "电压", "VOLTAGE", "0x10", "否", 0, 0], [],
    [1, 2, "电流", "CURRENT", 17, "true", "MIN_CURRENT"],
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
    const { file } = await fixture(t, [...headers, "boot_restore"], [[1, 2, "V", "VOLTAGE", 1, extra]]);
    await assert.rejects(readRows(file, "process"), /第 2 行/);
  }
  const { file } = await fixture(t, headers, [[1, 2, null, "VOLTAGE", 1]]);
  await assert.rejects(readRows(file, "process"), /name：缺少必填值/);
});
test("rejects unknown, duplicate and missing headers, unlabeled cells and oversized batches", async t => {
  for (const bad of [[...headers, "readonly"], [...headers, "name"], headers.slice(1)]) {
    const { file } = await fixture(t, bad, []);
    await assert.rejects(readRows(file, "process"), /表头/);
  }
  const { file } = await fixture(t, headers, [[1, 2, "V", "VOLTAGE", 1, "orphan"]]);
  await assert.rejects(readRows(file, "process"), /没有表头/);
  const large = await fixture(t, headers, Array.from({ length: 201 }, (_, i) => [1, 2, "V", `V_${i}`, i + 1]));
  await assert.rejects(readRows(large.file, "process"), /201 行/);
});
test("templates cover each table without overwriting existing files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "point-template-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const kind of ["process", "collect", "forward"]) {
    const file = join(dir, `${kind}.xlsx`);
    await writeTemplate(file, kind);
    await assert.rejects(writeTemplate(file, kind), { code: "EEXIST" });
    await assert.rejects(readRows(file, kind), /当前 0 行/);
    await assert.rejects(readRows(file, kind, "missing"), /找不到工作表/);
  }
});
