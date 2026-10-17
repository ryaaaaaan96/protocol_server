// Real API checks in integration.mjs's disposable database.
export async function checkStringRanges({ client, engineer, viewer, engineerId, viewerId, equal, ok }) {
  const project = await client.call("/projects", "POST", { name: "String defaults without numeric bounds" });
  const url = `/projects/${project.id}`;
  for (const [user_id, role] of [[engineerId, "engineer"], [viewerId, "viewer"]]) await client.call(`${url}/members`, "PUT", { user_id, role });
  const graph = () => client.call(`${url}/topology`);
  const commit = preview => client.call(`${url}/changes/${preview.id}/commit`, "POST", {});
  const preview = async (entity, values, id = null) => client.call(`${url}/changes/preview`, "POST", {
    revision: (await graph()).revision, operation: id ? "update" : "create", entity, values, id,
  });
  const edit = async (entity, values, id = null) => {
    const p = await preview(entity, values, id);
    ok(p.allowed, JSON.stringify(p.errors));
    return (await commit(p)).record;
  };
  const model = await edit("board_models", { code: "STRING_TEST", name: "String board" });
  const group = await edit("signal_groups", { model_id: model.id, code: "LOCAL", name: "Local" });
  const number = await edit("data_items", { name: "Numeric source", data_type: "U16", byte_length: 2, default_value: "3", min_value: "0", max_value: "99" });
  const text = await edit("data_items", { name: "Text source", data_type: "STRING", byte_length: 2, default_value: "OK" });
  equal(text.min_value, "");
  equal(text.max_value, "");
  const signals = [];
  for (let i = 0; i < 3; i++) signals.push(await edit("signals", {
    group_id: group.id, data_item_id: number.id, name: `Signal ${i}`, enum_name: `STRING_SIG_${i}`, sig_id: i + 1,
    ...(i === 2 ? { internal_type: "U16" } : {}),
  }));
  for (const signal of signals) await edit("signal_ranges", { signal_id: signal.id, default_value: "3", min_value: "1", max_value: "80" });
  const inheritedNumber = await edit("signals", { group_id: group.id, data_item_id: number.id, name: "Numeric inherited bounds", enum_name: "STRING_SHARED_NUMERIC", sig_id: 4, internal_type: "U16" });
  const table = `${url}/board-models/${model.id}/point-tables/process`;
  const read = () => client.call(table);
  const pointPreview = async (id, values) => client.call(`${table}/preview`, "POST", { revision: (await graph()).revision, operation: "update", id, values });

  // Changing the effective type clears only this signal's stored numeric overrides.
  const before = await read();
  const changeType = await pointPreview(signals[0].id, { internal_type: "STRING", default_value: "AB" });
  ok(changeType.allowed, JSON.stringify(changeType.errors));
  ok(changeType.impact.changes.some(change => change.entity === "signal_ranges" && change.after?.min_value === null));
  equal(JSON.stringify((await read()).rows), JSON.stringify(before.rows));
  await commit(changeType);
  let row = (await read()).rows.find(row => row.id === signals[0].id);
  equal(row.data_type, "STRING");
  equal(row.default_value, "AB");
  equal(row.byte_length, 2);
  equal(row.min_value, "");
  equal(row.max_value, "");
  equal(row.edit_values.min_value, null);
  equal(row.range_inherited, "");
  equal((await read()).rows.find(row => row.id === signals[1].id).min_value, "1");
  const rejectedTypeChange = await pointPreview(signals[1].id, { internal_type: "STRING", min_value: "0" });
  equal(rejectedTypeChange.allowed, false);
  equal((await read()).rows.find(row => row.id === signals[1].id).data_type, "U16");
  equal((await read()).rows.find(row => row.id === signals[1].id).edit_values.min_value, "1");

  // Neither single-cell, raw range, shared-definition nor batch APIs bypass the rule.
  for (const values of [{ min_value: "0" }, { max_value: "10" }]) {
    const p = await pointPreview(signals[0].id, values);
    equal(p.allowed, false);
    ok(p.errors.some(error => error.code === "string_bounds" && error.field === Object.keys(values)[0]));
  }
  const range = (await graph()).signal_ranges.find(row => row.signal_id === signals[0].id);
  equal((await preview("signal_ranges", { min_value: "0" }, range.id)).allowed, false);
  equal((await preview("data_items", { min_value: "0" }, text.id)).allowed, false);
  equal((await preview("data_items", { name: "Invalid text", data_type: "STRING", byte_length: 2, max_value: "99" })).allowed, false);
  const priorBatch = await read();
  const batch = await client.call(`${table}/batch/preview`, "POST", {
    revision: priorBatch.revision, operation: "update", rows: [
      { row: 1, id: signals[1].id, values: { name: "Must not save" } },
      { row: 2, id: signals[0].id, values: { max_value: "5" } },
    ],
  });
  equal(batch.allowed, false);
  ok(batch.errors.some(error => error.row === 2 && error.field === "max_value" && error.code === "string_bounds"));
  equal(JSON.stringify((await read()).rows), JSON.stringify(priorBatch.rows));
  equal((await graph()).revision, priorBatch.revision);

  const tooLong = await pointPreview(signals[0].id, { default_value: "ABC" });
  equal(tooLong.allowed, false);
  ok(tooLong.errors.some(error => error.code === "string_length"));
  const clear = await pointPreview(signals[0].id, { default_value: "XY", min_value: null, max_value: "" });
  ok(clear.allowed, JSON.stringify(clear.errors));
  await commit(clear);
  equal((await read()).rows.find(row => row.id === signals[0].id).default_value, "XY");

  // Reverting to a numeric type inherits numeric defaults without reviving overrides.
  await edit("signals", { internal_type: null }, signals[0].id);
  const restoreDefault = await pointPreview(signals[0].id, { default_value: null });
  ok(restoreDefault.allowed, JSON.stringify(restoreDefault.errors));
  await commit(restoreDefault);
  row = (await read()).rows.find(row => row.id === signals[0].id);
  equal(row.data_type, "U16");
  equal(row.min_value, "0");
  equal(row.max_value, "99");

  // A shared definition change also clears derived STRING ranges, while an explicit
  // numeric type override keeps its own bounds. No other signal is silently cleared.
  const sharedType = await preview("data_items", { data_type: "STRING" }, number.id);
  ok(sharedType.allowed, JSON.stringify(sharedType.errors));
  await commit(sharedType);
  const sharedRows = (await read()).rows;
  equal(sharedRows.find(row => row.id === signals[1].id).min_value, "");
  equal(sharedRows.find(row => row.id === signals[1].id).edit_values.max_value, null);
  equal(sharedRows.find(row => row.id === signals[2].id).data_type, "U16");
  equal(sharedRows.find(row => row.id === signals[2].id).min_value, "1");
  equal(sharedRows.find(row => row.id === signals[2].id).max_value, "80");
  equal(sharedRows.find(row => row.id === inheritedNumber.id).min_value, "0");
  equal(sharedRows.find(row => row.id === inheritedNumber.id).max_value, "99");
  equal(sharedRows.find(row => row.id === inheritedNumber.id).edit_values.min_value, "0");
  equal(sharedRows.find(row => row.id === inheritedNumber.id).edit_values.max_value, "99");
  const item = (await graph()).data_items.find(item => item.id === number.id);
  equal(item.min_value, "");
  equal(item.max_value, "");
  await edit("signals", { internal_type: null, data_item_id: text.id }, signals[2].id);
  equal((await read()).rows.find(row => row.id === signals[2].id).min_value, "");

  const sql = await engineer.call(`${url}/sql`, "POST", { sql: `SELECT min_value,max_value FROM v_signals WHERE id=${signals[1].id}` });
  equal(sql.rows[0].min_value, "");
  equal(sql.rows[0].max_value, "");
  equal((await viewer.call(table)).rows.find(row => row.id === signals[1].id).min_value, "");
  equal((await viewer.raw(`${table}/preview`, "POST", { revision: (await graph()).revision, operation: "update", id: signals[1].id, values: { default_value: "A" } })).status, 403);
  console.log("PASS: STRING bounds rejected across write paths, defaults/length retained, type/reference changes clear only affected ranges, shared numeric overrides preserved and SQL/readers agree");
}
