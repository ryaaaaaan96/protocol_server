// Real API and Excel client checks; called by integration.mjs in its disposable database.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export async function checkPointBatch({ client, engineer, viewer, engineerId, viewerId, password, equal, ok }) {
  const project = await client.call("/projects", "POST", { name: "Atomic point batches" });
  const url = `/projects/${project.id}`;
  for (const [user_id, role] of [[engineerId, "engineer"], [viewerId, "viewer"]]) await client.call(`${url}/members`, "PUT", { user_id, role });
  const graph = () => client.call(`${url}/topology`);
  const commit = (p, who = client) => who.call(`${url}/changes/${p.id}/commit`, "POST", {});
  const edit = async (entity, values, id = null) => {
    const p = await client.call(`${url}/changes/preview`, "POST", { revision: (await graph()).revision, entity, values, id, operation: id ? "update" : "create" });
    ok(p.allowed, JSON.stringify(p.errors));
    return (await commit(p)).record;
  };
  const model = await edit("board_models", { name: "Batch board", code: "BATCH" });
  const otherModel = await edit("board_models", { name: "Other board", code: "OTHER" });
  const group = await edit("signal_groups", { model_id: model.id, name: "DSP", code: "DSP" });
  const otherGroup = await edit("signal_groups", { model_id: otherModel.id, name: "Other", code: "OTHER" });
  const item = await edit("data_items", { name: "Batch U16", data_type: "U16", byte_length: 2 });
  const table = `${url}/board-models/${model.id}/point-tables`;
  const point = (id, extra = {}) => ({ group_id: group.id, data_item_id: item.id, name: `Point ${id}`, enum_name: `BATCH_${id}`, sig_id: id, ...extra });
  const batch = async (rows, kind = "process", who = client) => who.call(`${table}/${kind}/batch/preview`, "POST", { revision: (await graph()).revision, rows });
  const create = (id, extra = {}, row = 2) => ({ row, values: point(id, extra) });
  const initial = await graph(), auditBefore = (await client.call(`${url}/audit`)).length;
  for (const rows of [[], Array.from({ length: 201 }, (_, i) => create(i + 1, {}, i + 2)), [create(1), create(2)], [create(1, {}, 0)]]) equal((await batch(rows)).allowed, false);
  equal((await viewer.raw(`${table}/process/batch/preview`, "POST", { revision: initial.revision, rows: [create(1)] })).status, 403);
  const badFields = await batch([create(1, { name: "", sig_id: "bad", hacked: true }), create(2, { process_enabled: "false" }, 9)]);
  equal(badFields.allowed, false);
  ok(badFields.errors.some(e => e.row === 2 && e.field === "sig_id"));
  ok(badFields.errors.some(e => e.row === 9 && e.field === "process_enabled"));
  const duplicates = await batch([create(1), create(1, {}, 7), create(3, { group_id: otherGroup.id }, 11)]);
  equal(duplicates.allowed, false);
  ok(duplicates.errors.some(e => e.row === 7));
  ok(duplicates.errors.some(e => e.row === 11));
  const invalidRange = await batch([create(1, { min_value: "10", max_value: "5" }, 5)]);
  equal(invalidRange.allowed, false);
  ok(invalidRange.errors.some(e => e.row === 5 && e.code === "range_order"));
  const p = await batch([create(1, { default_value: "3", min_value: "0", max_value: "10", boot_restore: true }), create(2, {}, 7)]);
  ok(p.allowed, JSON.stringify(p.errors));
  equal((await graph()).signals.length, 0);
  equal((await graph()).signal_ranges.length, 0);
  equal((await graph()).revision, initial.revision);
  equal((await client.call(`${url}/audit`)).length, auditBefore);
  equal((await engineer.raw(`${url}/changes/${p.id}/commit`, "POST", {})).status, 400);
  const first = await commit(p);
  equal(first.record.count, 2);
  equal(first.record.rows[1].row, 7);
  equal(first.revision, initial.revision + 1);
  equal((await graph()).signal_ranges.length, 1);
  equal((await client.call(`${url}/audit`)).length, auditBefore + 1);
  const audit = (await client.call(`${url}/audit`)).find(a => a.entity === `point_batch:${model.id}`);
  equal(audit.after_data.record.rows.length, 2);
  equal((await client.raw(`${url}/changes/${p.id}/commit`, "POST", {})).status, 400);
  equal((await batch([create(1)])).allowed, false);

  const a = await batch([create(10)]), b = await batch([create(11)], "process", engineer);
  const race = await Promise.all([client.raw(`${url}/changes/${a.id}/commit`, "POST", {}), engineer.raw(`${url}/changes/${b.id}/commit`, "POST", {})]);
  ok(race.every(r => r.status === 200), JSON.stringify(race));
  equal(race.filter(r => r.data.merged).length, 1);
  const winner = await batch([create(20)]), loser = await batch([create(21), create(20, {}, 4)], "process", engineer);
  await commit(winner);
  const beforeConflict = await graph(), beforeAudit = (await client.call(`${url}/audit`)).length;
  const rejected = await engineer.raw(`${url}/changes/${loser.id}/commit`, "POST", {});
  equal(rejected.status, 409);
  equal(rejected.data.code, "REVISION_CONFLICT");
  ok(rejected.data.errors.some(e => e.row === 4));
  equal((await graph()).signals.length, beforeConflict.signals.length);
  equal((await graph()).revision, beforeConflict.revision);
  equal((await client.call(`${url}/audit`)).length, beforeAudit);
  ok(!(await graph()).signals.some(s => s.sig_id === 21));
  const referencedChange = await batch([create(30)]);
  await edit("data_items", { unit: "V" }, item.id);
  equal((await client.raw(`${url}/changes/${referencedChange.id}/commit`, "POST", {})).status, 409);
  const stale = await client.raw(`${table}/process/batch/preview`, "POST", { revision: initial.revision, rows: [create(30)] });
  equal(stale.status, 409);

  const context = await edit("device_contexts", { model_id: model.id, group_id: group.id, name: "DSP", code: "DSP", dev_id: 2, kind: "local" });
  const contract = await edit("protocol_contracts", { name: "Batch UPP", code: "BATCH_UPP", protocol: "UPP" });
  const fields = [];
  for (let i = 0; i < 2; i++) fields.push(await edit("protocol_fields", { contract_id: contract.id, data_item_id: item.id, name: `F${i}`, ordinal: i, model: 9 }));
  const signals = (await graph()).signals.slice(0, 2);
  const endpoints = {};
  for (const [kind, role] of [["collect", "client"], ["forward", "server"]]) {
    endpoints[kind] = await edit("endpoints", { model_id: model.id, contract_id: contract.id, name: kind, code: kind.toUpperCase(), role, transport: "CAN", port: "CAN_PORT1" });
    const mapping = signals.map((signal, i) => ({ row: i + 2, values: { endpoint_id: endpoints[kind].id, context_id: context.id, signal_id: signal.id, field_id: fields[i].id, ...(kind === "collect" ? { poll_interval: 20 } : {}) } }));
    const bindingPreview = await batch(mapping, kind);
    ok(bindingPreview.allowed, JSON.stringify(bindingPreview.errors));
    equal((await commit(bindingPreview)).record.count, 2);
    equal((await client.call(`${table}/${kind}`)).rows.length, 2);
    equal((await batch(mapping, kind)).allowed, false);
    equal((await batch(mapping, kind === "collect" ? "forward" : "collect")).allowed, false);
  }
  const laterField = await edit("protocol_fields", { contract_id: contract.id, data_item_id: item.id, name: "Later field", ordinal: 2, model: 9 });
  const layoutPreview = await batch([{ row: 12, values: { endpoint_id: endpoints.forward.id, context_id: context.id, signal_id: signals[0].id, field_id: laterField.id } }], "forward");
  ok(layoutPreview.allowed, JSON.stringify(layoutPreview.errors));
  // Moving an earlier field changes this new mapping's address without editing the
  // referenced field itself, so it must invalidate the reviewed batch.
  await edit("protocol_fields", { address_mode: "manual", address: 10 }, fields[0].id);
  const beforeLayoutCommit = await graph();
  const layoutConflict = await client.raw(`${url}/changes/${layoutPreview.id}/commit`, "POST", {});
  equal(layoutConflict.status, 409);
  equal(layoutConflict.data.code, "REVISION_CONFLICT");
  equal((await graph()).signal_bindings.length, beforeLayoutCommit.signal_bindings.length);
  // A different project's reference IDs must not escape the existing ownership/RLS checks.
  const foreign = await client.call("/projects", "POST", { name: "Foreign batch target" });
  equal((await client.call(`/projects/${foreign.id}/board-models/${model.id}/point-tables/process/batch/preview`, "POST", { revision: 1, rows: [create(40)] })).allowed, false);

  // Spreadsheet drafts update multiple existing rows with one revision/audit entry.
  // Values are patches: saving a cell must not resend and overwrite other fields.
  const read = (kind = "process") => client.call(`${table}/${kind}`);
  const updates = (snapshot, patches) => patches.map(([id, values], i) => {
    const original = snapshot.rows.find(row => row.id === id);
    const expected = { ...original.edit_values };
    for (const key of Object.keys(values)) {
      if (!Object.hasOwn(expected, key)) expected[key] = snapshot.definition.fields[key]?.default ?? null;
    }
    return { row: i + 1, id, values, expected };
  });
  const updateBatch = (snapshot, patches, kind = "process", who = client) => who.call(`${table}/${kind}/batch/preview`, "POST", {
    revision: snapshot.revision, operation: "update", rows: updates(snapshot, patches),
  });
  const originalTable = await read();
  const updatePatches = [[signals[0].id, { name: "Edited in a cell" }], [signals[1].id, { min_value: "0", max_value: "20", default_value: "4", boot_restore: true }]];
  const updateRequest = { revision: originalTable.revision, operation: "update", rows: updates(originalTable, updatePatches) };
  equal((await viewer.raw(`${table}/process/batch/preview`, "POST", updateRequest)).status, 403);
  for (const rows of [
    [{ row: 1, values: { name: "Missing ID" } }],
    [{ row: 1, id: signals[0].id, values: {} }],
    [{ row: 1, id: signals[0].id, values: { name: "First" } }, { row: 2, id: signals[0].id, values: { name: "Second" } }],
  ]) equal((await client.call(`${table}/process/batch/preview`, "POST", { ...updateRequest, rows })).allowed, false);
  const readOnly = await updateBatch(originalTable, [[signals[0].id, { effective_address: 4 }]]);
  equal(readOnly.allowed, false);
  ok(readOnly.errors.some(error => error.row === 1 && error.field === "effective_address"));
  const auditBeforeUpdate = (await client.call(`${url}/audit`)).length;
  const updatePreview = await updateBatch(originalTable, updatePatches);
  ok(updatePreview.allowed, JSON.stringify(updatePreview.errors));
  equal(JSON.stringify((await read()).rows), JSON.stringify(originalTable.rows));
  equal((await graph()).revision, originalTable.revision);
  equal((await client.call(`${url}/audit`)).length, auditBeforeUpdate);
  const savedUpdates = await commit(updatePreview);
  equal(savedUpdates.record.count, 2);
  equal(savedUpdates.revision, originalTable.revision + 1);
  const updatedTable = await read();
  equal(updatedTable.rows.find(row => row.id === signals[0].id).name, "Edited in a cell");
  equal(updatedTable.rows.find(row => row.id === signals[1].id).default_value, "4");
  equal(updatedTable.rows.find(row => row.id === signals[1].id).edit_values.boot_restore, true);
  const updateAudit = await client.call(`${url}/audit`);
  equal(updateAudit.length, auditBeforeUpdate + 1);
  const cellAudit = updateAudit.find(row => row.entity === `point_batch:${model.id}` && row.action === "topology.update");
  equal(cellAudit.before_data.record.rows.length, 2);
  equal(cellAudit.before_data.record.rows[0].record.name, originalTable.rows.find(row => row.id === signals[0].id).name);
  equal(cellAudit.after_data.record.rows[0].record.name, "Edited in a cell");

  const badUpdate = await updateBatch(updatedTable, [[signals[0].id, { name: "Must roll back" }], [signals[1].id, { min_value: "30" }]]);
  equal(badUpdate.allowed, false);
  ok(badUpdate.errors.some(error => error.row === 2 && error.code === "range_order"));
  equal((await read()).rows.find(row => row.id === signals[0].id).name, "Edited in a cell");
  equal((await graph()).revision, updatedTable.revision);
  const wrongBoard = await client.call(`${url}/board-models/${otherModel.id}/point-tables/process/batch/preview`, "POST", {
    revision: updatedTable.revision, operation: "update", rows: updates(updatedTable, [[signals[0].id, { name: "Wrong board" }]]),
  });
  equal(wrongBoard.allowed, false);
  ok(wrongBoard.errors.some(error => error.row === 1));
  const foreignUpdate = await client.call(`/projects/${foreign.id}/board-models/${model.id}/point-tables/process/batch/preview`, "POST", {
    revision: 1, operation: "update", rows: updates(updatedTable, [[signals[0].id, { name: "Foreign project" }]]),
  });
  equal(foreignUpdate.allowed, false);

  // Another member may change different cells while the draft/preview stays open.
  const mergeDraft = await read();
  const independentUpdate = await updateBatch(mergeDraft, [[signals[0].id, { flags: "8" }], [signals[1].id, { name: "Independent second row" }]], "process", engineer);
  ok(independentUpdate.allowed, JSON.stringify(independentUpdate.errors));
  await edit("signals", { name: "Concurrent untouched field" }, signals[0].id);
  equal((await commit(independentUpdate, engineer)).merged, true);
  equal((await read()).rows.find(row => row.id === signals[0].id).name, "Concurrent untouched field");
  equal((await read()).rows.find(row => row.id === signals[0].id).flags, "8");
  const staleDraft = await read();
  await edit("signals", { name: "A newer second row" }, signals[1].id);
  const staleUpdate = await updateBatch(staleDraft, [[signals[0].id, { flags: "16" }]], "process", engineer);
  equal(staleUpdate.merged, true);
  await commit(staleUpdate, engineer);
  const staleCollision = await engineer.raw(`${table}/process/batch/preview`, "POST", {
    revision: staleDraft.revision, operation: "update", rows: updates(staleDraft, [[signals[0].id, { flags: "32" }]]),
  });
  equal(staleCollision.status, 409);
  equal(staleCollision.data.code, "REVISION_CONFLICT");

  const collisionDraft = await read();
  const collisionUpdate = await updateBatch(collisionDraft, [[signals[0].id, { flags: "32" }], [signals[1].id, { name: "Must remain unsaved" }]], "process", engineer);
  await edit("signals", { flags: "64" }, signals[0].id);
  const beforeRejected = await read(), auditBeforeRejected = (await client.call(`${url}/audit`)).length;
  const updateConflict = await engineer.raw(`${url}/changes/${collisionUpdate.id}/commit`, "POST", {});
  equal(updateConflict.status, 409);
  equal(updateConflict.data.code, "REVISION_CONFLICT");
  equal(JSON.stringify((await read()).rows), JSON.stringify(beforeRejected.rows));
  equal((await graph()).revision, beforeRejected.revision);
  equal((await client.call(`${url}/audit`)).length, auditBeforeRejected);

  // Whole-batch validation also runs after merging individually valid range changes.
  const rangeDraft = await read();
  const rangeUpdate = await updateBatch(rangeDraft, [[signals[0].id, { name: "Range rollback" }], [signals[1].id, { min_value: "10", default_value: "10" }]], "process", engineer);
  ok(rangeUpdate.allowed, JSON.stringify(rangeUpdate.errors));
  const range = (await graph()).signal_ranges.find(row => row.signal_id === signals[1].id);
  await edit("signal_ranges", { max_value: "5" }, range.id);
  const rangeConflict = await engineer.raw(`${url}/changes/${rangeUpdate.id}/commit`, "POST", {});
  equal(rangeConflict.status, 409);
  equal(rangeConflict.data.code, "REVISION_CONFLICT");
  equal((await read()).rows.find(row => row.id === signals[0].id).name, beforeRejected.rows.find(row => row.id === signals[0].id).name);
  equal((await read()).rows.find(row => row.id === signals[1].id).min_value, "0");

  const collectDraft = await read("collect");
  const collectUpdate = await updateBatch(collectDraft, collectDraft.rows.map((row, i) => [row.id, { poll_interval: 100 + i }]), "collect");
  ok(collectUpdate.allowed, JSON.stringify(collectUpdate.errors));
  equal((await commit(collectUpdate)).record.count, 2);
  equal((await read("collect")).rows.map(row => row.poll_interval).sort().join(","), "100,101");

  // The actual CLI reads/writes XLSX; dry runs leave data untouched, a committed batch
  // is atomic, and rerunning the same file cannot duplicate records.
  const { default: ExcelJS } = await import("../scripts/excel-batch/node_modules/exceljs/excel.js");
  const { writeTemplate } = await import("../scripts/excel-batch/workbook.mjs");
  const directory = fs.mkdtempSync(path.resolve(".runtime/batch-test-"));
  try {
    const file = path.join(directory, "points.xlsx");
    await writeTemplate(file, "process");
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(file);
    const sheet = book.getWorksheet("process");
    const header = sheet.getRow(1).values.slice(1);
    for (const id of [50, 51]) sheet.addRow(header.map(key => point(id)[key] ?? null));
    await book.xlsx.writeFile(file);
    const run = (args, login = false) => spawnSync(process.execPath, ["scripts/excel-batch/index.mjs", "--url", "http://127.0.0.1:18081", "--project", String(project.id), "--model", String(model.id), ...args], {
      env: { ...process.env, PROTOCOL_SESSION: login ? "" : client.cookie.split("=")[1], PROTOCOL_USERNAME: "test_admin", PROTOCOL_PASSWORD: password }, encoding: "utf8", timeout: 90000,
    });
    const refs = path.join(directory, "refs.json");
    const lookup = run(["--references", refs], true);
    equal(lookup.status, 0);
    ok(JSON.parse(fs.readFileSync(refs)).options.groups.some(g => g.id === group.id));
    const beforeCli = await graph();
    const dryRun = run(["--file", file]);
    equal(dryRun.status, 0);
    ok(dryRun.stdout.includes("业务数据未保存"), dryRun.stderr);
    equal((await graph()).revision, beforeCli.revision);
    const report = path.join(directory, "result.json");
    const submitted = run(["--file", file, "--commit", "--report", report]);
    equal(submitted.status, 0);
    ok(submitted.stdout.includes("添加成功：2 行"), submitted.stderr);
    equal(JSON.parse(fs.readFileSync(report)).record.count, 2);
    equal((await graph()).revision, beforeCli.revision + 1);
    const replay = run(["--file", file, "--commit"]);
    equal(replay.status, 1);
    ok(replay.stderr.includes("第 2 行"));
    equal((await graph()).revision, beforeCli.revision + 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log("PASS: point batch append/update, atomic ranges/bindings, row errors, audit, permissions/isolation, cell merge/conflict rollback and real Excel CLI");
}
