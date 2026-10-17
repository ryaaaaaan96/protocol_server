// Invoked by integration.mjs against its disposable database and real HTTP server.
export async function checkPointEditing({ client, engineer, viewer, engineerId, viewerId, equal, ok }) {
  const project = await client.call("/projects", "POST", { name: "Point editing and merging" });
  const url = `/projects/${project.id}`;
  for (const [user_id, role] of [[engineerId, "engineer"], [viewerId, "viewer"]]) {
    await client.call(`${url}/members`, "PUT", { user_id, role });
  }
  const graph = () => client.call(`${url}/topology`);
  const preview = async (entity, values, id = null, who = client) => who.call(`${url}/changes/preview`, "POST", {
    revision: (await graph()).revision, entity, values, id, operation: id ? "update" : "create",
  });
  const commit = (p, who = client) => who.call(`${url}/changes/${p.id}/commit`, "POST", {});
  const edit = async (entity, values, id = null) => {
    const p = await preview(entity, values, id);
    ok(p.allowed, JSON.stringify(p.errors));
    return (await commit(p)).record;
  };
  const model = await edit("board_models", { name: "Sort test", code: "ORDER_PROTOCOL" });
  const disabled = await edit("board_models", { name: "Disabled sort", code: "ORDER_DISABLED" });
  const group = await edit("signal_groups", { model_id: model.id, name: "Signals", code: "MAIN" });
  const secondGroup = await edit("signal_groups", { model_id: model.id, name: "Other signals", code: "OTHER" });
  const item = await edit("data_items", { name: "Test U16", data_type: "U16", byte_length: 2 });
  const signals = [];
  for (let i = 0; i < 3; i++) signals.push(await edit("signals", {
    group_id: group.id, data_item_id: item.id, name: `Signal ${i}`, enum_name: `MERGE_SIG_${i}`, sig_id: 100 + i,
  }));
  const outside = await edit("signals", { group_id: secondGroup.id, data_item_id: item.id, name: "Outside", enum_name: "OUTSIDE_SIG", sig_id: 200 });
  const table = `${url}/board-models/${model.id}/point-tables`;
  const read = (kind = "process") => client.call(`${table}/${kind}`);
  const ids = signals.map(s => s.id);
  const order = async (ordered, kind = "process", who = client, base = table, extra = {}) => who.call(`${base}/${kind}/reorder/preview`, "POST", {
    revision: (await graph()).revision, ids: ordered, ...extra,
  });
  for (const ordered of [[ids[0], ids[0]], ids.slice(0, 2), [ids[0], ids[1], outside.id], ids, [999999, ids[1]]]) {
    equal((await order(ordered)).allowed, false);
  }
  equal((await order([...ids].reverse(), "process", client, `${url}/board-models/${disabled.id}/point-tables`)).allowed, false);
  equal((await viewer.raw(`${table}/process/reorder/preview`, "POST", { revision: (await graph()).revision, ids: [...ids].reverse() })).status, 403);
  const beforeOrder = await read();
  const reorder = await order([...ids].reverse());
  ok(reorder.allowed, JSON.stringify(reorder.errors));
  ok(reorder.impact.changes.some(c => c.after?.display_order != null));
  equal(JSON.stringify((await read()).rows), JSON.stringify(beforeOrder.rows));
  await commit(reorder);
  const ordered = await read();
  equal(JSON.stringify(ordered.rows.filter(r => r.group_id === group.id).map(r => r.id)), JSON.stringify([...ids].reverse()));
  for (const row of ordered.rows) equal(row.resolved_sig_id, beforeOrder.rows.find(r => r.id === row.id).resolved_sig_id);
  const audit = (await client.call(`${url}/audit`)).find(a => a.entity === `point_order:${model.id}`);
  equal(JSON.stringify(audit.before_data.record.ids), JSON.stringify(ids));
  equal(JSON.stringify(audit.after_data.record.ids), JSON.stringify([...ids].reverse()));

  // Separate users prepare from the same base revision. The integration harness
  // obtains successive editing leases while these requests race, so stale drafts
  // still exercise three-way merging across editing sessions.
  const race = async (a, b) => Promise.all([
    client.raw(`${url}/changes/${a.id}/commit`, "POST", {}),
    engineer.raw(`${url}/changes/${b.id}/commit`, "POST", {}),
  ]);
  const a = await preview("signals", { name: "Renamed by A" }, ids[0]);
  const b = await preview("signals", { flags: "1" }, ids[0], engineer);
  const revision = (await graph()).revision;
  const independent = await race(a, b);
  ok(independent.every(r => r.status === 200), JSON.stringify(independent));
  equal(independent.filter(r => r.data.merged).length, 1);
  const merged = await graph();
  equal(merged.revision, revision + 2);
  equal(merged.signals.find(s => s.id === ids[0]).name, "Renamed by A");
  equal(merged.signals.find(s => s.id === ids[0]).flags, "1");
  const separateA = await preview("signals", { name: "Separate A" }, ids[1]);
  const separateB = await preview("signals", { name: "Separate B" }, ids[2], engineer);
  ok((await race(separateA, separateB)).every(r => r.status === 200));

  const collisionA = await preview("signals", { name: "Winner A" }, ids[0]);
  const collisionB = await preview("signals", { name: "Winner B" }, ids[0], engineer);
  const collisionRevision = (await graph()).revision;
  const auditCount = (await client.call(`${url}/audit`)).length;
  const collision = await race(collisionA, collisionB);
  equal(collision.map(r => r.status).sort().join(","), "200,409");
  equal(collision.find(r => r.status === 409).data.code, "REVISION_CONFLICT");
  const winner = collision.findIndex(r => r.status === 200);
  equal((await graph()).signals.find(s => s.id === ids[0]).name, winner === 0 ? "Winner A" : "Winner B");
  equal((await graph()).revision, collisionRevision + 1);
  equal((await client.call(`${url}/audit`)).length, auditCount + 1);

  const orderA = await order(ids);
  const orderB = await order([ids[1], ids[2], ids[0]], "process", engineer);
  equal((await race(orderA, orderB)).map(r => r.status).sort().join(","), "200,409");

  // Staleness before preview can merge changed fields using their original values.
  const old = await read();
  const oldRow = old.rows.find(r => r.id === ids[0]);
  await edit("signals", { name: "Newer unrelated signal" }, ids[1]);
  const rebasedPreview = await engineer.call(`${table}/process/preview`, "POST", {
    revision: old.revision, operation: "update", id: ids[0], values: { flags: "2" }, expected: oldRow.edit_values,
  });
  equal(rebasedPreview.allowed, true);
  equal(rebasedPreview.merged, true);
  await commit(rebasedPreview, engineer);
  const rejectedPreview = await engineer.raw(`${table}/process/preview`, "POST", {
    revision: old.revision, operation: "update", id: ids[0], values: { flags: "3" }, expected: oldRow.edit_values,
  });
  equal(rejectedPreview.status, 409);
  equal(rejectedPreview.data.code, "REVISION_CONFLICT");

  // A process update may create its first range row. Preview rollback consumes
  // a sequence ID, but the logical signal/range identity must still match.
  const rangePreview = await client.call(`${table}/process/preview`, "POST", {
    revision: (await graph()).revision, operation: "update", id: ids[1], values: { min_value: "1" },
  });
  ok(rangePreview.allowed);
  await commit(rangePreview);
  equal((await read()).rows.find(r => r.id === ids[1]).min_value, "1");

  // Disjoint fields can still violate a domain constraint after merging.
  await edit("signal_ranges", { signal_id: ids[0], min_value: "0", max_value: "100" });
  const range = (await graph()).signal_ranges.find(r => r.signal_id === ids[0]);
  const lower = await preview("signal_ranges", { min_value: "10" }, range.id);
  const upper = await preview("signal_ranges", { max_value: "5" }, range.id, engineer);
  ok(lower.allowed && upper.allowed);
  await commit(upper, engineer);
  const invalidMerge = await client.raw(`${url}/changes/${lower.id}/commit`, "POST", {});
  equal(invalidMerge.status, 409);
  equal(invalidMerge.data.code, "REVISION_CONFLICT");
  equal((await graph()).signal_ranges.find(r => r.id === range.id).min_value, "0");
  equal((await graph()).signal_ranges.find(r => r.id === range.id).max_value, "5");

  // Protocol order propagates to every endpoint sharing that contract.
  const contract = await edit("protocol_contracts", { name: "Sort UPP", code: "SORT_UPP", protocol: "UPP" });
  const context = await edit("device_contexts", { model_id: model.id, group_id: group.id, name: "Local", code: "LOCAL", dev_id: 1, kind: "local" });
  const reused = await edit("device_contexts", { model_id: model.id, group_id: group.id, name: "Proxy", code: "PROXY", dev_id: 2, kind: "proxy" });
  const groupEdit = await preview("signals", { flags: "4" }, ids[0]);
  ok(groupEdit.allowed);
  equal(groupEdit.impact.affected_contexts.map(c => c.id).sort().join(","), [context.id, reused.id].sort().join(","));
  const fields = [];
  for (let i = 0; i < 3; i++) fields.push(await edit("protocol_fields", {
    contract_id: contract.id, data_item_id: item.id, name: `Field ${i}`, ordinal: i, model: 99,
    ...(i === 0 ? { address_mode: "manual", address: 6 } : {}),
  }));
  const endpoints = [], bindings = [];
  for (let i = 0; i < 2; i++) {
    const endpoint = await edit("endpoints", { model_id: model.id, contract_id: contract.id, name: `Endpoint ${i}`, code: `EP_${i}`, role: "server", transport: "CAN", port: `CAN_PORT${i+1}` });
    endpoints.push(endpoint);
    const rows = [];
    for (let j = 0; j < 3; j++) rows.push(await edit("signal_bindings", { endpoint_id: endpoint.id, context_id: context.id, field_id: fields[j].id, signal_id: ids[j] }));
    bindings.push(rows);
  }
  const forward = await read("forward");
  equal(forward.definition.ordering.mode, "protocol");
  const proposal = [bindings[0][0].id, bindings[0][2].id, bindings[0][1].id];
  const protocolOrder = await order(proposal, "forward");
  ok(protocolOrder.allowed, JSON.stringify(protocolOrder.errors));
  ok(protocolOrder.impact.changes.some(c => c.entity === "v_bindings" && c.after?.endpoint_id === endpoints[1].id));
  equal((await read("forward")).rows.find(r => r.field_id === fields[1].id).effective_address, 8);
  await commit(protocolOrder);
  const afterProtocol = await read("forward");
  for (const endpoint of endpoints) {
    equal(afterProtocol.rows.find(r => r.endpoint_id === endpoint.id && r.field_id === fields[1].id).effective_address, 10);
    equal(afterProtocol.rows.find(r => r.endpoint_id === endpoint.id && r.field_id === fields[2].id).effective_address, 8);
  }
  equal((await order([proposal[1], proposal[0], proposal[2]], "forward")).allowed, false);
  await edit("protocol_fields", { contract_id: contract.id, data_item_id: item.id, name: "Unbound", ordinal: 3, model: 99 });
  equal((await order(bindings[0].map(r => r.id), "forward")).allowed, false);
  console.log("PASS: persisted ordering, group/anchor rules, shared protocol addresses, concurrent merge/conflict rollback, stale preview and semantic validation");
}
