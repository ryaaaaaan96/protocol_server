// Exercise sheet projections and editable metadata through the real preview/commit path.
export async function checkDspSheet({ client, engineer, url, read, graph, preview, commit, edit, rejectEdit, history, equal, ok }) {
  const table = await read();
  const columns = ["name", "variable_name", "sheet_type", "enum_table", "display_digits", "type_length",
    "element_count", "byte_length", "default_value", "max_value", "min_value", "unit", "access", "ram",
    "flash", "eeprom", "calibration", "structure", "cpu", "precision", "sheet_data_type", "upload_level",
    "category", "sheet_upp_model", "notes"];
  equal(JSON.stringify(table.definition.columns), JSON.stringify(columns));
  ok(!table.definition.editor.some(key => ["sig_id", "enum_name", "internal_type"].includes(key)));
  ok(!Object.keys(table.definition.fields).some(key => key.includes("sig_id")));
  for (const row of table.rows) {
    columns.forEach((key, index) => {
      const source = row.metadata.source_cells.values[String.fromCharCode(65 + index)] || "";
      equal(String(row[key] ?? ""), source);
    });
    for (const key of table.definition.editor) equal(row.edit_values[key], row[key]);
  }
  const point = table.rows[0];
  const mappingBefore = JSON.stringify((await graph()).transmit_points);
  const sourceBefore = JSON.stringify(point.metadata.source_cells);
  const changed = await edit("process", { variable_name: "SheetProductType" }, point.id);
  equal(changed.id, point.id);
  equal(changed.enum_name, "SHEET_PRODUCT_TYPE");
  equal((await read()).rows[0].variable_name, "SheetProductType");
  equal(JSON.stringify((await graph()).transmit_points), mappingBefore);
  await edit("process", { variable_name: point.variable_name }, point.id);

  // Two separate metadata leaves merge; the same metadata leaf conflicts.
  const first = await preview("process", { enum_table: "0: 停止\n1: 运行" }, point.id);
  const second = await preview("process", { structure: "SHEET_TEST_STR" }, point.id, engineer);
  ok(first.allowed && second.allowed);
  await commit(first);
  equal((await commit(second, engineer)).merged, true);
  let current = (await read()).rows[0];
  equal(current.enum_table, "0: 停止\n1: 运行");
  equal(current.structure, "SHEET_TEST_STR");
  equal(JSON.stringify(current.metadata.source_cells), sourceBefore);
  const winner = await preview("process", { display_digits: 2 }, point.id);
  const loser = await preview("process", { display_digits: 4 }, point.id, engineer);
  await commit(winner);
  const countBefore = (await history()).length;
  equal((await engineer.raw(`${url}/changes/${loser.id}/commit`, "POST", {})).status, 409);
  equal((await history()).length, countBefore);
  current = (await read()).rows[0];
  equal(current.display_digits, 2);
  equal(String(current.precision), "0.01");
  equal(current.sheet_data_type, "STRING");
  equal(JSON.stringify((await graph()).transmit_points), mappingBefore);
  const latest = (await history()).at(-1);
  equal(latest.after_data.metadata.display_digits, 2);

  // A stale cell draft compares projected edit values, then merges unrelated edits.
  const snapshot = await read();
  const expected = snapshot.rows[0].edit_values;
  await edit("process", { cpu: point.cpu === "CPU1" ? "CPU2" : "CPU1" }, point.id);
  const stale = await client.call(`${url}/boards/DSP/point-tables/process/batch/preview`, "POST", {
    revision: snapshot.revision, operation: "update",
    rows: [{ row: 1, id: point.id, expected, values: { calibration: point.calibration === "Y" ? "N" : "Y" } }],
  });
  ok(stale.allowed);
  await commit(stale);
  const conflict = await client.raw(`${url}/boards/DSP/point-tables/process/batch/preview`, "POST", {
    revision: snapshot.revision, operation: "update",
    rows: [{ row: 1, id: point.id, expected, values: { calibration: point.calibration } }],
  });
  equal(conflict.status, 409);

  for (const fields of [
    { metadata: {} }, { type_length: 8 }, { precision: "2" }, { sheet_data_type: "U32" },
    { sheet_upp_model: 2 }, { display_digits: -1 }, { display_digits: 9 }, { display_digits: 1.5 },
    { access: "INVALID" }, { ram: "YES" }, { cpu: "CPU3" }, { category: "未知分类" },
    { variable_name: "invalid name" }, { sheet_type: "INVALID" },
    { variable_name: "SheetProductType", enum_name: "OTHER_VARIABLE" },
    { sheet_type: "Sys_U16", internal_type: "F32" },
  ]) await rejectEdit("process", point.id, fields);
  await edit("process", Object.fromEntries(["enum_table", "structure", "display_digits", "cpu", "calibration"]
    .map(key => [key, point[key]])), point.id);
  equal(JSON.stringify((await read()).rows[0].metadata.source_cells), sourceBefore);
  equal(JSON.stringify((await graph()).transmit_points), mappingBefore);
  console.log("PASS: DSP sheet 552 × 25 values, variable references, editable metadata, history, disjoint merge and conflicting drafts");
}
