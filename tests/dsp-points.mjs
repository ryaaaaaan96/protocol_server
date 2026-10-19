// Native DSP point checks against integration.mjs's disposable PostgreSQL server.
// Database URLs are provided by the harness and are never printed or read from .env.
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { exportProject } from "../scripts/export-project.mjs";

function folderFiles(directory) {
  const files = new Map();
  const visit = (relative = "") => {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(filename);
      else files.set(filename, readFileSync(path.join(directory, filename)));
    }
  };
  visit();
  return files;
}

function fingerprint(files) {
  const hash = createHash("sha256");
  for (const [name, bytes] of files) hash.update(name).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
}

function folderForm(files) {
  const form = new FormData();
  for (const [name, bytes] of files) form.append("files", new Blob([bytes]), `DSP-export/${name}`);
  return form;
}

export async function checkDspPoints({ client, engineer, viewer, engineerId, viewerId, equal, ok, migrationUrl, appUrl, testEnv, projectConfigs, fixtureKey }) {
  const { default: pg } = await import(fileURLToPath(new URL("../.runtime/db-tools/node_modules/pg/lib/index.js", import.meta.url)));
  const project = await client.call("/projects", "POST", { config_key: fixtureKey("dsp_native"), name: "DSP native" });
  const platform = new pg.Client({ connectionString: String(migrationUrl) });
  let databaseName;
  await platform.connect();
  try { databaseName=(await platform.query("SELECT database_name FROM projects WHERE id=$1",[project.id])).rows[0].database_name; }
  finally { await platform.end(); }
  const inspectionUrl=new URL(migrationUrl),runtimeUrl=new URL(appUrl);
  inspectionUrl.pathname=runtimeUrl.pathname=`/${databaseName}`;
  const inspection = new pg.Client({ connectionString: inspectionUrl.toString() });
  const runtime = new pg.Client({ connectionString: runtimeUrl.toString() });
  await inspection.connect();
  try {
    await runtime.connect();
    const url = `/projects/${project.id}`;
    for (const [user_id, role] of [[engineerId, "engineer"], [viewerId, "viewer"]]) {
      await client.call(`${url}/members`, "PUT", { user_id, role });
    }
    const graph = () => client.call(`${url}/topology`);
    const initial = await graph();
    const board = initial.project_config.board_types.find(row => row.code === "DSP");
    ok(board, "DSP organization is defined only by project JSON");
    const table = `${url}/boards/DSP/point-tables`;
    const read = (kind = "process", who = client) => who.call(`${table}/${kind}`);
    const commit = (proposal, who = client) => who.call(`${url}/changes/${proposal.id}/commit`, "POST", {});
    const preview = async (kind, values, id = null, who = client, extra = {}) => who.call(`${table}/${kind}/preview`, "POST", {
      revision: (await graph()).revision, operation: id ? "update" : "create", id, values, ...extra,
    });
    const edit = async (kind, values, id = null, who = client) => {
      const proposal = await preview(kind, values, id, who);
      ok(proposal.allowed, JSON.stringify(proposal.errors));
      return (await commit(proposal, who)).record;
    };
    const history = async () => (await inspection.query("SELECT * FROM history.events WHERE kind='point' AND project_id=$1 ORDER BY id", [project.id])).rows;
    const historyCount = async () => (await inspection.query("SELECT count(*)::int AS count FROM history.events WHERE kind='point' AND project_id=$1", [project.id])).rows[0].count;
    const reject = response => ok(
      (response.status === 200 && response.data.allowed === false) || [400, 409].includes(response.status),
      JSON.stringify(response),
    );
    const rejectEdit = async (kind, id, values, operation = "update") => reject(await client.raw(`${table}/${kind}/preview`, "POST", {
      revision: (await graph()).revision, operation, id, values,
    }));

    const internal = await read();
    const forwarded = await read("forward");
    equal(internal.rows.length, 552);
    equal(forwarded.rows.length, 445);
    equal(initial.process_points.length, 552);
    equal(initial.transmit_points.length, 445);
    ok(!Object.hasOwn(initial,"signals"));
    ok(!Object.hasOwn(initial,"board_models"));
    for (const who of [client, engineer, viewer]) {
      const listed = await who.call("/projects");
      equal(listed.find(row => row.id === project.id).point_count, 552);
      ok(!Object.keys(listed.find(row => row.id === project.id)).some(key => key.startsWith("edit_owner_") || key === "edit_expires_at"));
      const overview = await who.call(`${url}/overview`);
      ok(!Object.keys(overview.project).some(key => key.startsWith("edit_owner_") || key === "edit_expires_at"));
      equal(overview.stats.total, 552);
      equal(overview.stats.signals, 552);
      equal(overview.transmit_count, 445);
      equal(overview.has_configuration, true);
    }
    ok(initial.process_points.every(row => row.board_key === "DSP" && row.sig_id === null));
    ok(initial.transmit_points.every(row => row.board_key === "DSP"));
    const linked = new Set(initial.transmit_points.map(row => row.process_point_id));
    equal(initial.process_points.filter(row => !linked.has(row.id)).length, 107);
    equal(initial.process_points.filter(row => row.internal_type === "F32").length, 345);
    equal(initial.transmit_points.filter(row => row.conversion === "fixed_point").length, 276);
    equal(initial.transmit_points.filter(row => row.conversion === "array_bytes").length, 4);
    const frequency = initial.process_points.find(row => row.enum_name === "GRID_FREQUENCY");
    const precharge = initial.process_points.find(row => row.enum_name === "RECT_PRECHARGE_THRESH");
    ok(frequency && precharge);
    const frequencyMapping = initial.transmit_points.find(row => row.process_point_id === frequency.id);
    equal(frequencyMapping.upp_model, 103);
    equal(frequencyMapping.address, 14);
    equal(frequency.internal_type, "F32");
    equal(frequencyMapping.wire_type, "S32");
    equal(initial.transmit_points.find(row => row.process_point_id === precharge.id).address, 22);
    const product = initial.process_points.find(row => row.enum_name === "PARAM_PRODUCT_TYPE");
    equal(product.internal_type, "U16");
    equal(product.element_count, 15);
    equal(product.byte_length, 30);
    ok(!Object.hasOwn(frequencyMapping, "poll_interval"));
    equal((await read("process", viewer)).rows.length, 552);

    // JSON organization and endpoint keys are the only ownership catalog.
    equal(internal.board_key, "DSP");
    ok(!Object.hasOwn(internal, "model_id"));
    equal(internal.options.native_groups[0].code, "LOCAL");
    equal(internal.options.endpoints[0].code, "UPP_SERVICE");
    equal(internal.options.process_points.length, 552);
    equal((await client.raw(`${url}/boards/UPM/point-tables/process`)).status, 400);
    equal((await client.raw(`${table}/collect`)).status, 400);
    equal((await client.raw(`${url}/board-models/1/point-tables/process`)).status, 404);
    await rejectEdit("forward", frequencyMapping.id, { endpoint_key: "MISSING" });
    await rejectEdit("process", frequency.id, { group_key: "MISSING" });
    await rejectEdit("process", frequency.id, { group_id: 1 });
    const permissions = await engineer.call(`${url}/permissions`);
    equal(permissions.catalog.find(entry => entry.board_key === "DSP").endpoints[0].endpoint_key, "UPP_SERVICE");
    const scoped = grants => client.call(`${url}/members`, "PUT", {
      user_id: engineerId, role: "engineer", edit_scope: "scoped", grants,
    });
    const accessFailure = async (kind, id, values) => {
      const response = await engineer.raw(`${table}/${kind}/preview`, "POST", {
        revision: (await graph()).revision, operation: "update", id, values,
      });
      equal(response.status, 403);
    };
    await scoped([{board_key:"DSP",scope:"internal"}]);
    ok((await preview("process", {notes:"internal permitted preview"}, frequency.id, engineer)).allowed);
    await accessFailure("forward", frequencyMapping.id, {name:"protocol forbidden"});
    ok((await read("process",engineer)).rows.every(row=>row.can_edit));
    ok((await read("forward",engineer)).rows.every(row=>!row.can_edit));
    await scoped([{board_key:"DSP",scope:"protocol",endpoint_key:"UPP_SERVICE"}]);
    ok((await preview("forward", {name:"protocol permitted preview"}, frequencyMapping.id, engineer)).allowed);
    await accessFailure("process",frequency.id,{notes:"internal forbidden"});
    ok((await read("forward",engineer)).rows.every(row=>row.can_edit));
    const deniedConfig = await engineer.raw(`${url}/changes/preview`,"POST",{
      revision:(await graph()).revision,entity:"project_config",operation:"update",values:initial.project_config,
    });
    equal(deniedConfig.status,403);
    for(const grants of [
      [{board_key:"MISSING",scope:"board"}],
      [{board_key:"DSP",scope:"protocol",endpoint_key:"MISSING"}],
      [{board_key:"DSP",scope:"internal",endpoint_key:"UPP_SERVICE"}],
      [{board_key:"DSP",scope:"board"},{board_key:"DSP",scope:"board"}],
    ]) equal((await client.raw(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer",edit_scope:"scoped",grants})).status,400);
    await scoped([{board_key:"DSP",scope:"board"}]);
    ok((await read("process",engineer)).rows.every(row=>row.can_edit));
    ok((await read("forward",engineer)).rows.every(row=>row.can_edit));

    // Scoped editors must hold a real project lease; viewers and empty scopes cannot acquire one.
    equal((await engineer.rawUnlocked(`${table}/process/preview`,"POST",{
      revision:(await graph()).revision,operation:"update",id:frequency.id,values:{name:"missing lease"},
    })).status,423);
    equal((await viewer.rawUnlocked(`${url}/edit-lock/acquire`,"POST",{})).status,403);
    const lease=await engineer.rawUnlocked(`${url}/edit-lock/acquire`,"POST",{});
    equal(lease.status,200);equal(lease.data.owned,true);
    equal((await engineer.rawUnlocked(`${url}/edit-lock/renew`,"POST",{})).status,200);
    equal((await client.rawUnlocked(`${url}/edit-lock/acquire`,"POST",{})).status,423);
    equal((await client.rawUnlocked(`${url}/edit-lock/release`,"POST",{})).status,423);
    equal((await engineer.rawUnlocked(`${url}/edit-lock/release`,"POST",{})).status,200);
    await scoped([]);
    equal((await engineer.rawUnlocked(`${url}/edit-lock/acquire`,"POST",{})).status,403);
    await client.call(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer",edit_scope:"all",grants:[]});

    // The SQL workspace is read-only, bounded, and contains only the new business tables.
    equal((await viewer.call(`${url}/sql`,"POST",{sql:"SELECT count(*) AS count FROM points.process_points"})).rows[0].count,552);
    equal((await viewer.call(`${url}/sql`,"POST",{sql:"SELECT count(*) AS count FROM history.events WHERE kind='point'"})).rows[0].count, await historyCount());
    equal((await viewer.call(`${url}/sql`,"POST",{sql:"WITH data AS (SELECT * FROM points.process_points), summary AS (SELECT count(*) AS count FROM data) SELECT * FROM summary"})).rows[0].count,552);
    const sqlRows=await viewer.call(`${url}/sql`,"POST",{sql:"SELECT id FROM points.process_points ORDER BY id"});
    equal(sqlRows.rows.length,500);equal(sqlRows.truncated,true);
    for(const sql of ["DELETE FROM points.process_points","SELECT * FROM users","SELECT * FROM signals",
      "SELECT set_config('app.is_admin','true',true)","SELECT * FROM points.process_points FOR UPDATE",
      "SELECT * FROM meta.project_state", "SELECT * FROM meta.previews",
      "WITH project_state AS (SELECT * FROM project_state) SELECT * FROM project_state",
      "WITH early AS (SELECT * FROM previews), previews AS (SELECT 1) SELECT * FROM early",
      "SELECT 1; DELETE FROM points.process_points"]){
      equal((await viewer.raw(`${url}/sql`,"POST",{sql})).status,400);
    }
    const beforeConfig=JSON.stringify(await graph());
    const missingGroup=structuredClone(initial.project_config);
    missingGroup.board_types.find(board=>board.code==="DSP").point_groups=[{code:"OTHER",name:"Other"}];
    reject(await client.raw(`${url}/changes/preview`,"POST",{revision:(await graph()).revision,entity:"project_config",operation:"update",values:missingGroup}));
    equal(JSON.stringify(await graph()),beforeConfig);

    // A preview runs a rollback-only simulation. Neither business rows nor the
    // append-only history are written until the real commit succeeds.
    const baselineCount = await historyCount();
    const hiddenLegacyGroup = await client.raw(`${url}/changes/preview`, "POST", {
      revision: (await graph()).revision, entity: "signal_groups", operation: "create",
      values: { board_key: "DSP", name: "Removed legacy entity", code: "SHADOW" },
    });
    reject(hiddenLegacyGroup);
    equal(await historyCount(), baselineCount);
    const rename = await preview("process", { name: "电网频率：DSP 原生点" }, frequency.id);
    ok(rename.allowed, JSON.stringify(rename.errors));
    equal(await historyCount(), baselineCount);
    equal((await read()).rows.find(row => row.id === frequency.id).name, frequency.name);
    await commit(rename);
    equal(await historyCount(), baselineCount + 1);
    const renameHistory = (await history()).at(-1);
    equal(renameHistory.entity_type, "process");
    equal(Number(renameHistory.record_id), frequency.id);
    equal(renameHistory.action, "update");
    equal(renameHistory.before_data.name, frequency.name);
    equal(renameHistory.after_data.name, "电网频率：DSP 原生点");
    ok(renameHistory.batch_id && renameHistory.actor_name && renameHistory.config_snapshot);

    // One source point may have multiple independent wire mappings. Renaming
    // its enum does not rewrite or invalidate their stable point IDs.
    const mappingValues = {
      process_point_id: frequency.id, endpoint_key: "UPP_SERVICE", name: "频率备用映射",
      upp_model: 103, address: 2000, wire_type: "S32", wire_length: 4,
      scale: frequencyMapping.scale, access: "RO", byte_order: 0,
      conversion: "fixed_point", enabled: true,
    };
    const secondMapping = await edit("forward", mappingValues);
    ok(secondMapping.id);
    await edit("process", { enum_name: "GRID_FREQUENCY_RENAMED" }, frequency.id);
    let after = await graph();
    equal(after.transmit_points.filter(row => row.process_point_id === frequency.id).length, 2);
    equal(after.process_points.find(row => row.id === frequency.id).enum_name, "GRID_FREQUENCY_RENAMED");
    equal((await read("forward")).rows.filter(row => row.process_point_id === frequency.id).length, 2);

    const beforeInvalid = JSON.stringify(after.process_points);
    const beforeInvalidTransmit = JSON.stringify(after.transmit_points);
    const beforeInvalidHistory = await historyCount();
    await rejectEdit("forward", secondMapping.id, { conversion: "identity" });
    await rejectEdit("forward", secondMapping.id, { address: 14 });
    await rejectEdit("forward", secondMapping.id, { address: 65535 });
    await rejectEdit("forward", secondMapping.id, { wire_length: 2 });
    await rejectEdit("process", frequency.id, {}, "delete");
    after = await graph();
    equal(JSON.stringify(after.process_points), beforeInvalid);
    equal(JSON.stringify(after.transmit_points), beforeInvalidTransmit);
    equal(await historyCount(), beforeInvalidHistory);

    // Independent fields merge from the same base version; a second write to
    // the same field conflicts and must not produce any history or revision.
    const first = await preview("process", { name: "频率：修改名称" }, frequency.id);
    const second = await preview("process", { unit: "Hz (DSP)" }, frequency.id, engineer);
    ok(first.allowed && second.allowed);
    await commit(first);
    const merged = await commit(second, engineer);
    equal(merged.merged, true);
    after = await graph();
    equal(after.process_points.find(row => row.id === frequency.id).name, "频率：修改名称");
    equal(after.process_points.find(row => row.id === frequency.id).unit, "Hz (DSP)");
    const winner = await preview("process", { name: "频率：已保存" }, frequency.id);
    const loser = await preview("process", { name: "频率：不应覆盖" }, frequency.id, engineer);
    ok(winner.allowed && loser.allowed);
    await commit(winner);
    const countBeforeConflict = await historyCount();
    const revisionBeforeConflict = (await graph()).revision;
    const conflict = await engineer.raw(`${url}/changes/${loser.id}/commit`, "POST", {});
    equal(conflict.status, 409);
    equal(conflict.data.code, "REVISION_CONFLICT");
    equal(await historyCount(), countBeforeConflict);
    equal((await graph()).revision, revisionBeforeConflict);
    equal((await read()).rows.find(row => row.id === frequency.id).name, "频率：已保存");

    // A failed batch rolls back even earlier valid items. A successful batch
    // emits one history batch ID for all changed point records.
    const beforeBatch = await read();
    const failedBatch = await client.raw(`${table}/process/batch/preview`, "POST", {
      revision: beforeBatch.revision, operation: "update", rows: [
        { row: 1, id: frequency.id, values: { name: "Must roll back" } },
        { row: 2, id: precharge.id, values: { min_value: "100", max_value: "1" } },
      ],
    });
    reject(failedBatch);
    equal(JSON.stringify((await read()).rows), JSON.stringify(beforeBatch.rows));
    equal(await historyCount(), countBeforeConflict);
    const batch = await client.call(`${table}/process/batch/preview`, "POST", {
      revision: (await graph()).revision, operation: "update", rows: [
        { row: 1, id: frequency.id, values: { notes: "Batch note A" } },
        { row: 2, id: precharge.id, values: { notes: "Batch note B" } },
      ],
    });
    ok(batch.allowed, JSON.stringify(batch.errors));
    await commit(batch);
    const batchHistory = (await history()).slice(-2);
    equal(batchHistory.length, 2);
    equal(batchHistory[0].batch_id, batchHistory[1].batch_id);
    equal(await historyCount(), countBeforeConflict + 2);

    // Native batch creation has no legacy group/data-item/binding keys. Numeric
    // and boolean updates must use JSON values, matching the single-point API.
    const createdBatch = await client.call(`${table}/process/batch/preview`, "POST", {
      revision: (await graph()).revision, operation: "create", rows: [
        { row: 1, values: { name: "批量原生点 A", enum_name: "NATIVE_BATCH_A", internal_type: "U16", element_count: 1, byte_length: 2 } },
        { row: 2, values: { name: "批量原生点 B", enum_name: "NATIVE_BATCH_B", internal_type: "U16", element_count: 1, byte_length: 2 } },
      ],
    });
    ok(createdBatch.allowed, JSON.stringify(createdBatch.errors));
    const batchCreated = (await commit(createdBatch)).record.rows.map(row => row.record);
    equal(batchCreated.length, 2);
    const resized = await client.call(`${table}/process/batch/preview`, "POST", {
      revision: (await graph()).revision, operation: "update", rows: [
        { row: 1, id: batchCreated[0].id, values: { element_count: 2, byte_length: 4, manual_restore: true } },
      ],
    });
    ok(resized.allowed, JSON.stringify(resized.errors));
    await commit(resized);
    const resizedPoint = (await graph()).process_points.find(row => row.id === batchCreated[0].id);
    equal(resizedPoint.element_count, 2);
    equal(resizedPoint.byte_length, 4);
    equal(resizedPoint.manual_restore, true);
    const addedForwards = await client.call(`${table}/forward/batch/preview`, "POST", {
      revision: (await graph()).revision, operation: "create", rows: [
        { row: 1, values: { ...mappingValues, name: "批量转发 A", address: 3000 } },
        { row: 2, values: { ...mappingValues, name: "批量转发 B", address: 3004 } },
      ],
    });
    ok(addedForwards.allowed, JSON.stringify(addedForwards.errors));
    const forwardCreated = (await commit(addedForwards)).record.rows.map(row => row.record);
    equal(forwardCreated.length, 2);
    const numericMappingUpdate = await client.call(`${table}/forward/batch/preview`, "POST", {
      revision: (await graph()).revision, operation: "update", rows: [
        { row: 1, id: forwardCreated[0].id, values: { upp_model: 104, address: 3100, wire_length: 4, scale: 0.01, byte_order: 1, enabled: false } },
      ],
    });
    ok(numericMappingUpdate.allowed, JSON.stringify(numericMappingUpdate.errors));
    await commit(numericMappingUpdate);
    const numericMapping = (await graph()).transmit_points.find(row => row.id === forwardCreated[0].id);
    equal(numericMapping.upp_model, 104);
    equal(numericMapping.address, 3100);
    equal(numericMapping.scale, 0.01);
    equal(numericMapping.byte_order, 1);
    equal(numericMapping.enabled, false);
    for (const [kind, records] of [["forward", forwardCreated], ["process", batchCreated]]) {
      for (const record of records) {
        const removal = await preview(kind, {}, record.id, client, { operation: "delete" });
        ok(removal.allowed, JSON.stringify(removal.errors));
        await commit(removal);
      }
    }

    // Table drag changes display order, never the explicitly imported offsets.
    const beforeOrder = await read("forward");
    equal(beforeOrder.definition.ordering.mode, "display");
    const groupKey = row => JSON.stringify(beforeOrder.definition.ordering.group_by.map(key => row[key]));
    const selected = beforeOrder.rows.find(row => row.id === frequencyMapping.id);
    const group = beforeOrder.rows.filter(row => groupKey(row) === groupKey(selected));
    ok(group.length >= 2);
    const ids = group.map(row => row.id).reverse();
    const reorder = await client.call(`${table}/forward/reorder/preview`, "POST", { revision: beforeOrder.revision, ids });
    ok(reorder.allowed, JSON.stringify(reorder.errors));
    equal(JSON.stringify((await read("forward")).rows), JSON.stringify(beforeOrder.rows));
    await commit(reorder);
    const afterOrder = await read("forward");
    equal(JSON.stringify(afterOrder.rows.filter(row => groupKey(row) === groupKey(selected)).map(row => row.id)), JSON.stringify(ids));
    for (const row of afterOrder.rows) {
      const before = beforeOrder.rows.find(old => old.id === row.id);
      equal(row.effective_address, before.effective_address);
      equal(row.process_point_id, before.process_point_id);
    }

    const temporary = await edit("process", {
      name: "临时未引用点", enum_name: "TEMP_HISTORY_POINT", group_key: "LOCAL",
      internal_type: "U16", element_count: 1, byte_length: 2,
      default_value: "0", min_value: "0", max_value: "100", process_enabled: true,
    });
    const removal = await preview("process", {}, temporary.id, client, { operation: "delete" });
    ok(removal.allowed, JSON.stringify(removal.errors));
    await commit(removal);
    equal((await read()).rows.length, 552);
    const deletedHistory = (await history()).filter(row => row.entity_type === "process" && Number(row.record_id) === temporary.id);
    equal(deletedHistory.map(row => row.action).join(","), "insert,delete");
    equal(deletedHistory[1].before_data.enum_name, "TEMP_HISTORY_POINT");
    equal(deletedHistory[1].after_data, null);

    // Permissions apply through the same point API; cross-project IDs cannot
    // bypass ownership even for an administrator who can open both projects.
    equal((await viewer.raw(`${table}/process/preview`, "POST", {
      revision: (await graph()).revision, operation: "update", id: frequency.id, values: { name: "Forbidden" },
    })).status, 403);
    const otherProject = await client.call("/projects", "POST", { config_key: fixtureKey("dsp_native_other"), name: "DSP isolated" });
    const otherUrl = `/projects/${otherProject.id}`;
    const otherGraph = await client.call(`${otherUrl}/topology`);
    const otherTable = `${otherUrl}/boards/DSP/point-tables/process`;
    const foreignProposal = await client.call(`${otherTable}/preview`, "POST", {
      revision: otherGraph.revision, operation: "create", values: {
        name: "Other project's internal point", enum_name: "ISOLATED_POINT", group_key: "LOCAL",
        internal_type: "U16", byte_length: 2, element_count: 1,
        default_value: "0", min_value: "0", max_value: "100", process_enabled: true,
      },
    });
    ok(foreignProposal.allowed, JSON.stringify(foreignProposal.errors));
    const foreign = (await client.call(`${otherUrl}/changes/${foreignProposal.id}/commit`, "POST", {})).record;
    const listed = await client.call("/projects");
    equal(listed.find(row => row.id === project.id).point_count, 552);
    equal(listed.find(row => row.id === otherProject.id).point_count, 1);
    const isolatedOverview = await client.call(`${otherUrl}/overview`);
    equal(isolatedOverview.stats.total, 1);
    equal(isolatedOverview.stats.signals, 1);
    equal(isolatedOverview.transmit_count, 0);
    ok(!(await viewer.call("/projects")).some(row => row.id === otherProject.id));
    equal((await viewer.raw(`${otherUrl}/overview`)).status, 403);
    // Local IDs can repeat across physical databases: the selected project
    // determines their meaning, and no cross-database point reference exists.
    const sameLocalId=initial.process_points.find(row=>row.id===foreign.id);
    ok(sameLocalId,"independent projects may reuse the same local point ID");
    equal((await graph()).process_points.find(row=>row.id===foreign.id).enum_name, sameLocalId.enum_name);
    equal((await client.call(`${otherUrl}/topology`)).process_points[0].enum_name,"ISOLATED_POINT");
    await rejectEdit("forward", secondMapping.id, { process_point_id: 2147483647, wire_type: "U16", wire_length: 2, conversion: "identity" });
    equal((await viewer.raw(`${otherUrl}/topology`)).status, 403);
    equal((await runtime.query("SELECT count(*)::int AS count FROM points.process_points")).rows[0].count,0);
    await runtime.query("BEGIN");
    try {
      await runtime.query("SELECT set_config('app.user_id',$1,true),set_config('app.project_id',$2,true),set_config('app.access','{\"role\":\"engineer\",\"edit_scope\":\"all\",\"grants\":[]}',true)", [String(viewerId), String(project.id)]);
      equal((await runtime.query("SELECT count(*)::int AS count FROM points.process_points WHERE project_id=$1", [project.id])).rows[0].count, 552);
      equal((await runtime.query("SELECT count(*)::int AS count FROM points.process_points WHERE project_id=$1", [otherProject.id])).rows[0].count, 0);
      equal((await runtime.query("SELECT count(*)::int AS count FROM history.events WHERE kind='point' AND project_id=$1", [otherProject.id])).rows[0].count, 0);
    } finally {
      await runtime.query("ROLLBACK");
    }
    for (const command of ["UPDATE history.events SET actor_name='forged' WHERE project_id=$1", "DELETE FROM history.events WHERE kind='point' AND project_id=$1"]) {
      await runtime.query("BEGIN");
      try {
        await runtime.query("SELECT set_config('app.user_id',$1,true),set_config('app.project_id',$2,true),set_config('app.access','{\"role\":\"engineer\",\"edit_scope\":\"all\",\"grants\":[]}',true)", [String(engineerId), String(project.id)]);
        let rejected = false;
        try { await runtime.query(command, [project.id]); } catch (error) { rejected = error.code === "42501"; }
        ok(rejected, "Runtime role must not modify or delete point history");
      } finally {
        await runtime.query("ROLLBACK");
      }
    }

    const generated = await client.call(`${url}/generate`);
    equal(generated.blocked, false);
    const names = Object.keys(generated.files);
    ok(names.some(name => name.includes("DSP/") && name.endsWith("process.json")), names.join(","));
    ok(names.some(name => name.includes("DSP/") && name.endsWith("transmit.json")), names.join(","));
    const xmlName = names.find(name => name.includes("DSP/") && name.endsWith("UPP_SERVICE.xml"));
    ok(xmlName, names.join(","));
    ok(generated.files[xmlName].includes('OffsetAddr="14"'));
    ok(generated.files[xmlName].includes('OffsetAddr="2000"'));
    const generatedProcess = JSON.parse(generated.files[names.find(name => name.includes("DSP/") && name.endsWith("process.json"))]);
    ok(generatedProcess.points.some(point => point.enum_name === "GRID_FREQUENCY_RENAMED"));
    ok(!names.some(name => name.includes("UPM/") && /(?:process|collect|transmit)\.c$/.test(name)), "DSP import must not manufacture UPM firmware point tables");

    const release = await client.call(`${url}/releases`,"POST",{name:"DSP native snapshot",revision:(await graph()).revision});
    ok(release.id && release.sha256);
    equal((await viewer.call(`${url}/releases`))[0].id,release.id);
    const releaseBefore=(await inspection.query("SELECT snapshot,files FROM history.releases WHERE id=$1",[release.id])).rows[0];
    equal(releaseBefore.snapshot.process_points.length,552);
    ok(!Object.hasOwn(releaseBefore.snapshot,"board_models"));
    for(const sql of ["UPDATE history.releases SET name='forged' WHERE id=$1","DELETE FROM history.releases WHERE id=$1"]){
      await runtime.query("BEGIN");
      try{
        await runtime.query("SELECT set_config('app.user_id',$1,true),set_config('app.project_id',$2,true),set_config('app.access','{\"role\":\"engineer\",\"edit_scope\":\"all\",\"grants\":[]}',true)",[String(engineerId),String(project.id)]);
        let denied=false;try{await runtime.query(sql,[release.id]);}catch{denied=true;}ok(denied,"Release is immutable");
      }finally{await runtime.query("ROLLBACK");}
    }

    // The ordinary XLSX upload must select the native DSP path, rather than
    // running the legacy whole-project importer and creating UPM proxy data.
    const beforeReimport = await graph();
    const beforeReimportHistory = await historyCount();
    const oldHistoryIds = new Set((await history()).map(row => String(row.id)));
    const book = await readFile(new URL("../config/dc-ups/sources/DC-UPS测点数据表.xlsx", import.meta.url));
    const workbookForm = () => {
      const body = new FormData();
      body.append("file", new Blob([book]), "DSP.xlsx");
      return body;
    };
    const ownChange = await preview("process", { notes: "pending admin change" }, frequency.id);
    const otherChange = await preview("process", { notes: "pending engineer change" }, frequency.id, engineer);
    const otherImport = await engineer.call(`${url}/imports/preview`, "POST", workbookForm());
    const form = workbookForm();
    const imported = await client.call(`${url}/imports/preview`, "POST", form);
    ok(imported.id);
    const retainedPreviews = (await inspection.query("SELECT id::text,kind FROM meta.previews WHERE project_id=$1", [project.id])).rows;
    for (const [proposal,kind] of [[ownChange,"change"],[otherChange,"change"],[otherImport,"import"],[imported,"import"]]) {
      ok(retainedPreviews.some(row => row.id === String(proposal.id) && row.kind === kind), "New import preview preserves other kinds and owners");
    }
    equal((await client.raw(`${url}/changes/${imported.id}/commit`, "POST", {})).status, 400);
    equal((await client.raw(`${url}/imports/${ownChange.id}/commit`, "POST", { replace: true })).status, 400);
    equal((await engineer.raw(`${url}/imports/${imported.id}/commit`, "POST", { replace: true })).status, 400);
    equal(await historyCount(), beforeReimportHistory);
    equal(JSON.stringify((await graph()).process_points), JSON.stringify(beforeReimport.process_points));
    await client.call(`${url}/imports/${imported.id}/commit`, "POST", { replace: true });
    const reimported = await graph();
    equal(reimported.process_points.length, 552);
    equal(reimported.transmit_points.length, 445);
    ok(reimported.process_points.every(row => row.sig_id === null && row.board_key === "DSP"));
    for (const key of ["project_config"]) {
      equal(JSON.stringify(reimported[key]), JSON.stringify(beforeReimport[key]));
    }
    const retained = new Set((await history()).map(row => String(row.id)));
    ok([...oldHistoryIds].every(id => retained.has(id)), "Reimport preserves prior point history");
    ok(await historyCount() > beforeReimportHistory);
    equal((await client.call(`${otherUrl}/topology`)).process_points.length, 1);
    equal(JSON.stringify((await inspection.query("SELECT snapshot,files FROM history.releases WHERE id=$1",[release.id])).rows[0]),JSON.stringify(releaseBefore));

    // Export to a separate temporary directory. Upload without the archive
    // preserves current rows; upload with it restores only the named project.
    const exportParent = mkdtempSync(path.join(os.tmpdir(), "protocol-dsp-export-"));
    try {
      const sourceDirectory = path.join(projectConfigs, fixtureKey("dsp_native"));
      const sourceFingerprint = fingerprint(folderFiles(sourceDirectory));
      const exportedGraph = await graph();
      const unrelatedBefore = JSON.stringify(await client.call(`${otherUrl}/topology`));
      const exported = await exportProject(fixtureKey("dsp_native"), exportParent, testEnv);
      equal(fingerprint(folderFiles(sourceDirectory)), sourceFingerprint);
      const dumpFiles = folderFiles(exported.directory);
      equal(dumpFiles.get("project.dump").subarray(0, 5).toString(), "PGDMP");
      const exportPoint = exportedGraph.process_points.find(point => point.enum_name === "GRID_FREQUENCY");
      ok(exportPoint);
      const editedName = "导出后修改，配置覆盖应保留";
      await edit("process", { name: editedName }, exportPoint.id);

      const withoutDump = new Map(dumpFiles);
      withoutDump.delete("project.dump");
      const configManifest = JSON.parse(withoutDump.get("project.json").toString());
      delete configManifest.dump;
      withoutDump.set("project.json", Buffer.from(JSON.stringify(configManifest)));
      const beforeConfigOnly = await graph();
      const configPreview = await client.call("/project-folders/preview", "POST", folderForm(withoutDump));
      equal(configPreview.replace_data, false);
      equal(configPreview.summary.point_count, 552);
      equal(configPreview.summary.signal_count, 552);
      equal(configPreview.summary.transmit_count, 445);
      equal(configPreview.existing_project_id, project.id);
      equal(JSON.stringify(await graph()), JSON.stringify(beforeConfigOnly));
      const configSaved = await client.call("/project-folders/commit", "POST", { token: configPreview.token });
      equal(configSaved.project_id, project.id);
      equal(configSaved.replace_data, false);
      let current = await graph();
      equal(current.process_points.find(point => point.id === exportPoint.id).name, editedName);
      equal(JSON.stringify(current.process_points), JSON.stringify(beforeConfigOnly.process_points));
      equal(JSON.stringify(current.transmit_points), JSON.stringify(beforeConfigOnly.transmit_points));

      const beforeRestore = await graph();
      const historyBeforeRestore = new Set((await history()).map(row => String(row.id)));
      const historyCountBeforeRestore = await historyCount();
      const filesBeforeRestore = fingerprint(folderFiles(sourceDirectory));
      const restorePreview = await client.call("/project-folders/preview", "POST", folderForm(dumpFiles));
      equal(restorePreview.replace_data, true);
      equal(restorePreview.summary.point_count, 552);
      equal(restorePreview.summary.signal_count, 552);
      equal(restorePreview.summary.transmit_count, 445);
      equal(restorePreview.existing_project_id, project.id);
      equal(JSON.stringify(await graph()), JSON.stringify(beforeRestore));
      equal(await historyCount(), historyCountBeforeRestore);
      equal(fingerprint(folderFiles(sourceDirectory)), filesBeforeRestore);
      const restored = await client.call("/project-folders/commit", "POST", { token: restorePreview.token });
      equal(restored.project_id, project.id);
      equal(restored.replace_data, true);
      current = await graph();
      equal(current.process_points.length, 552);
      equal(current.transmit_points.length, 445);
      const restoredPoint = current.process_points.find(point => point.enum_name === exportPoint.enum_name);
      equal(restoredPoint.name, exportPoint.name);
      ok(restoredPoint.id !== exportPoint.id, "Dump import remaps stable record IDs into the destination database");
      const oldPoints = new Map(exportedGraph.process_points.map(point => [point.id, point]));
      const newPoints = new Map(current.process_points.map(point => [point.id, point]));
      const mappingKey = point => JSON.stringify([point.endpoint_key, point.upp_model, point.address]);
      const oldMappings = new Map(exportedGraph.transmit_points.map(point => [mappingKey(point), point]));
      for (const mapping of current.transmit_points) {
        const point = newPoints.get(mapping.process_point_id);
        const oldMapping = oldMappings.get(mappingKey(mapping));
        ok(point && oldMapping, "Every restored mapping references a restored internal point and original address");
        equal(point.enum_name, oldPoints.get(oldMapping.process_point_id).enum_name);
        equal(mapping.wire_type, oldMapping.wire_type);
        equal(mapping.conversion, oldMapping.conversion);
        equal(mapping.scale, oldMapping.scale);
        equal(mapping.project_id, project.id);
        equal(point.project_id, project.id);
      }
      const historyAfterRestore = new Set((await history()).map(row => String(row.id)));
      ok([...historyBeforeRestore].every(id => historyAfterRestore.has(id)), "Dump replacement retains all previous point history");
      ok(await historyCount() > historyCountBeforeRestore);
      equal(JSON.stringify(await client.call(`${otherUrl}/topology`)), unrelatedBefore);

      // A Dump is bound to its exported project key; changing only the folder's
      // manifest must not redirect those rows into another project.
      const wrongProject = new Map(dumpFiles);
      const wrongManifest = JSON.parse(wrongProject.get("project.json").toString());
      wrongManifest.key = fixtureKey("dsp_native_other");
      wrongProject.set("project.json", Buffer.from(JSON.stringify(wrongManifest)));
      const stableGraph = JSON.stringify(await graph());
      const wrongPreview = await client.raw("/project-folders/preview", "POST", folderForm(wrongProject));
      equal(wrongPreview.status, 400);
      equal(JSON.stringify(await graph()), stableGraph);
      equal(JSON.stringify(await client.call(`${otherUrl}/topology`)), unrelatedBefore);
    } finally {
      rmSync(exportParent, { recursive: true, force: true });
    }
    console.log("PASS: native DSP 552 internal/445 transmitted points, source offsets/types, multi-mapping IDs, history, atomic batches, merge conflicts, display-only order, RLS and DSP generation");
  } finally {
    await runtime.end();
    await inspection.end();
  }
}
