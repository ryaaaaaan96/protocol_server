// Real HTTP checks for DSP's worksheet suggestions and category-owned UPP models.
export async function checkDspTransmitRules({ client, engineer, engineerId, equal, ok, fixtureKey }) {
  const project = await client.call("/projects", "POST", { config_key: fixtureKey("dsp_rules") });
  const url = `/projects/${project.id}`;
  const table = `${url}/boards/DSP/point-tables`;
  const graph = () => client.call(`${url}/topology`);
  const read = kind => client.call(`${table}/${kind}`);
  const history = async () => (await client.call(`${url}/sql`, "POST", {
    sql: "SELECT record_id,entity_type,action,batch_id,before_data,after_data FROM history.events WHERE kind='point' ORDER BY id",
  })).rows;
  const preview = async (kind, values, id = null, who = client) => who.call(`${table}/${kind}/preview`, "POST", {
    revision: (await graph()).revision, operation: id ? "update" : "create", id, values,
  });
  const commit = (proposal, who = client) => who.call(`${url}/changes/${proposal.id}/commit`, "POST", {});
  const edit = async (kind, values, id = null, who = client) => {
    const proposal = await preview(kind, values, id, who);
    ok(proposal.allowed, JSON.stringify(proposal.errors));
    return (await commit(proposal, who)).record;
  };
  const reject = async (kind, values, id = null) => {
    const before = JSON.stringify(await graph()), priorHistory = JSON.stringify(await history());
    const response = await client.raw(`${table}/${kind}/preview`, "POST", {
      revision: (await graph()).revision, operation: id ? "update" : "create", id, values,
    });
    ok((response.status === 200 && response.data.allowed === false) || [400, 409].includes(response.status), JSON.stringify(response));
    equal(JSON.stringify(await graph()), before);
    equal(JSON.stringify(await history()), priorHistory);
    return response;
  };
  const conflict = async (proposal, who = client) => {
    const before = JSON.stringify(await graph()), priorHistory = JSON.stringify(await history());
    const response = await who.raw(`${url}/changes/${proposal.id}/commit`, "POST", {});
    equal(response.status, 409);
    equal(response.data.code, "REVISION_CONFLICT");
    equal(JSON.stringify(await graph()), before);
    equal(JSON.stringify(await history()), priorHistory);
  };
  const scope = grants => client.call(`${url}/members`, "PUT", {
    user_id: engineerId, role: "engineer", edit_scope: "scoped", grants,
  });
  await client.call(`${url}/members`, "PUT", { user_id: engineerId, role: "engineer" });

  const first = await edit("process", {
    name: "规则电压", variable_name: "RuleVoltage", sheet_type: "Sys_F32", element_count: 1,
    display_digits: 2, category: "控制参数设置", access: "RW",
  });
  const second = await edit("process", {
    name: "规则电流", variable_name: "RuleCurrent", sheet_type: "Sys_F32", element_count: 1,
    display_digits: 3, category: "任务级标定量", access: "RO",
  });
  const uncategorized = await edit("process", {
    name: "尚未分类", variable_name: "Uncategorized", sheet_type: "Sys_U16", element_count: 1,
  });
  await reject("forward", { process_point_id: uncategorized.id, address: 6 });

  // Creating a mapping only requires its source and chosen address. The
  // model is authoritative; the representation starts from worksheet advice.
  const firstMapping = await edit("forward", { process_point_id: first.id, address: 4000 });
  equal(firstMapping.name, first.name);
  equal(firstMapping.enabled, true);
  equal(firstMapping.upp_model, 102);
  equal(firstMapping.wire_type, "S32");
  equal(firstMapping.wire_length, 4);
  equal(firstMapping.scale, 0.01);
  equal(firstMapping.conversion, "fixed_point");
  const secondMapping = await edit("forward", { process_point_id: first.id, address: 4010 });
  const otherMapping = await edit("forward", { process_point_id: second.id, address: 4000 });
  equal(otherMapping.upp_model, 103);
  equal(otherMapping.scale, 0.001);

  const forwarded = await read("forward");
  const row = forwarded.rows.find(row => row.id === firstMapping.id);
  equal(row.category, "控制参数设置");
  equal(row.variable_name, "RuleVoltage");
  equal(row.sheet_type, "Sys_F32");
  equal(row.recommended_wire_type, "S32");
  equal(row.recommended_wire_length, 4);
  equal(row.recommended_scale, 0.01);
  equal(row.recommended_conversion, "fixed_point");
  equal(forwarded.definition.columns[forwarded.definition.columns.indexOf("category") + 1], "upp_model");
  ok(!forwarded.definition.editor.includes("upp_model"));
  for (const removed of ["name", "enabled", "byte_length", "sheet_type", "conversion", "byte_order"]) ok(!forwarded.definition.columns.includes(removed));
  for (const removed of ["name", "enabled", "conversion", "byte_order"]) ok(!forwarded.definition.editor.includes(removed));
  equal(forwarded.definition.fields.effective_address.label, "UPP偏移地址");
  equal(forwarded.definition.fields.effective_length.label, "UPP协议字节数");
  const internal = await read("process");
  equal(forwarded.definition.fields.signal_name.label, internal.definition.fields.name.label);
  equal(forwarded.definition.fields.variable_name.label, internal.definition.fields.variable_name.label);
  ok(!internal.definition.columns.includes("sheet_data_type"));
  ok(!internal.definition.columns.includes("sheet_upp_model"));
  equal(internal.rows.find(row => row.id === first.id).sheet_upp_model, 102);
  equal(internal.rows.find(row => row.id === first.id).sheet_data_type, "S32");

  // Older clients may send the matching model; they cannot choose a different one.
  const legacyCompatible = await edit("forward", { upp_model: 102, enabled: true, name: "旧客户端独立转发名称", conversion: "identity", byte_order: 2 }, firstMapping.id);
  equal(legacyCompatible.name, first.name);
  equal(legacyCompatible.conversion, "fixed_point");
  equal(legacyCompatible.byte_order, 0);
  await reject("forward", { upp_model: 103 }, firstMapping.id);
  await reject("forward", { process_point_id: first.id, address: 5000, upp_model: 1 });
  await reject("forward", { enabled: false }, firstMapping.id);
  await reject("forward", { process_point_id: first.id, address: 5000, enabled: false });
  await reject("process", { category: "" }, first.id);

  // Multiple mappings share the current internal data name in the table and
  // generated protocol; stale legacy mapping labels never override it.
  const renamed = "规则电压：内部统一名称";
  await edit("process", { name: renamed }, first.id);
  const renamedMappings = (await read("forward")).rows.filter(row => row.process_point_id === first.id);
  equal(renamedMappings.length, 2);
  for (const mapping of renamedMappings) {
    equal(mapping.signal_name, renamed);
    equal(mapping.name, renamed);
  }
  const generated = await client.call(`${url}/generate`);
  equal(generated.blocked, false);
  const xml = Object.entries(generated.files).find(([name]) => name.endsWith("DSP/UPP_SERVICE.xml"))[1];
  equal(xml.split(`DataName="${renamed}"`).length - 1, 2);
  const json = JSON.parse(Object.entries(generated.files).find(([name]) => name.endsWith("DSP/transmit.json"))[1]);
  ok(json.points.filter(row => row.process_point_id === first.id).every(row => row.name === renamed));

  // A classification edit cascades to every mapping, with the whole operation
  // rejected if the unchanged offsets collide in the destination model.
  await reject("process", { category: "任务级标定量" }, first.id);
  await edit("forward", { address: 4100 }, otherMapping.id);
  const beforeCategory = await graph(), countBeforeCategory = (await history()).length;
  const category = await preview("process", { category: "任务级标定量" }, first.id);
  ok(category.allowed, JSON.stringify(category.errors));
  equal(category.impact.count, 3);
  equal(JSON.stringify(await graph()), JSON.stringify(beforeCategory));
  equal((await history()).length, countBeforeCategory);
  await commit(category);
  const changed = await graph();
  for (const id of [firstMapping.id, secondMapping.id]) {
    const mapping = changed.transmit_points.find(row => row.id === id);
    const original = beforeCategory.transmit_points.find(row => row.id === id);
    equal(mapping.upp_model, 103);
    for (const key of ["process_point_id", "address", "wire_type", "wire_length", "scale", "conversion"])
      equal(mapping[key], original[key]);
  }
  const events = (await history()).slice(countBeforeCategory);
  equal(events.length, 3);
  equal(new Set(events.map(event => event.batch_id)).size, 1);
  equal(events.filter(event => event.entity_type === "process").length, 1);
  equal(events.filter(event => event.entity_type === "transmit").length, 2);
  for (const event of events.filter(event => event.entity_type === "transmit")) {
    equal(event.before_data.upp_model, 102);
    equal(event.after_data.upp_model, 103);
  }

  // Legal deviations remain editable and produce a visible preview warning.
  const override = await preview("forward", { wire_type: "F32", scale: 1 }, firstMapping.id);
  ok(override.allowed, JSON.stringify(override.errors));
  ok(override.warnings?.some(warning => warning.field === "wire_type" && warning.recommended_wire_type === "S32" && warning.actual_wire_type === "F32"), JSON.stringify(override.warnings));
  await commit(override);
  equal((await graph()).transmit_points.find(row => row.id === firstMapping.id).wire_type, "F32");
  equal((await graph()).transmit_points.find(row => row.id === firstMapping.id).conversion, "identity");
  await reject("forward", { wire_type: "U16", wire_length: 2, conversion: "identity", scale: 1 }, firstMapping.id);
  const unrelated = await preview("process", { notes: "不会重复提示其他映射的覆盖" }, second.id);
  ok(unrelated.allowed);
  equal(unrelated.warnings?.length || 0, 0);

  // The default bundle follows both scalar types and array length.
  const array = await edit("process", {
    name: "数组数据", variable_name: "RuleArray", sheet_type: "Sys_U16", element_count: 3,
    category: "任务级观测量", display_digits: 3,
  });
  const arrayMapping = await edit("forward", { process_point_id: array.id, address: 5000 });
  equal(arrayMapping.wire_type, "STRING");
  equal(arrayMapping.wire_length, 6);
  equal(arrayMapping.scale, 1);
  equal(arrayMapping.conversion, "array_bytes");
  await reject("forward", { wire_type: "U16", wire_length: 2, conversion: "identity" }, arrayMapping.id);

  // Cascading a model is a protocol edit as well as an internal edit. Scope
  // changes between preview and commit must still revoke the whole operation.
  await scope([{ board_key: "DSP", scope: "internal" }]);
  ok((await preview("process", { notes: "仅内部权限仍可改备注" }, first.id, engineer)).allowed);
  let denied = await engineer.raw(`${table}/process/preview`, "POST", {
    revision: (await graph()).revision, operation: "update", id: first.id, values: { category: "中断级观测量" },
  });
  equal(denied.status, 403);
  await scope([{ board_key: "DSP", scope: "board" }]);
  const authorized = await preview("process", { category: "中断级观测量" }, first.id, engineer);
  ok(authorized.allowed);
  await scope([{ board_key: "DSP", scope: "internal" }]);
  const beforeDenied = JSON.stringify(await graph()), historyBeforeDenied = JSON.stringify(await history());
  denied = await engineer.raw(`${url}/changes/${authorized.id}/commit`, "POST", {});
  equal(denied.status, 403);
  equal(JSON.stringify(await graph()), beforeDenied);
  equal(JSON.stringify(await history()), historyBeforeDenied);
  await scope([{ board_key: "DSP", scope: "board" }]);

  // New references and changed categories must not silently enlarge or alter
  // a previously reviewed set of derived effects during optimistic merging.
  const staleCreate = await preview("forward", { process_point_id: first.id, address: 4020 });
  ok(staleCreate.allowed);
  await edit("process", { category: "中断级观测量" }, first.id, engineer);
  await conflict(staleCreate);

  const staleCategory = await preview("process", { category: "任务级观测量" }, first.id);
  ok(staleCategory.allowed);
  await edit("forward", { process_point_id: second.id }, secondMapping.id, engineer);
  await conflict(staleCategory);
  await edit("forward", { process_point_id: first.id }, secondMapping.id);

  const staleBeforeNewReference = await preview("process", { category: "任务级观测量" }, first.id);
  ok(staleBeforeNewReference.allowed);
  await edit("forward", { process_point_id: first.id, address: 4020 }, null, engineer);
  await conflict(staleBeforeNewReference);

  const staleRelink = await preview("forward", { process_point_id: second.id }, secondMapping.id);
  ok(staleRelink.allowed);
  await edit("process", { category: "控制参数设置" }, second.id, engineer);
  await conflict(staleRelink);

  // Unrelated metadata remains mergeable even when a classification operation
  // contains derived changes to several mapping records.
  const mergeable = await preview("process", { category: "任务级观测量" }, first.id);
  ok(mergeable.allowed);
  await edit("process", { notes: "应保留的并发备注" }, first.id, engineer);
  equal((await commit(mergeable)).merged, true);
  const final = await graph();
  equal(final.process_points.find(row => row.id === first.id).notes, "应保留的并发备注");
  ok(final.transmit_points.filter(row => row.process_point_id === first.id).every(row => row.upp_model === 99));
  equal(final.transmit_points.find(row => row.id === firstMapping.id).wire_type, "F32");
  console.log("PASS: DSP derived names, mandatory mappings, suggested wire types, category models, atomic overlaps, scoped cascades and concurrent reference guards");
}
