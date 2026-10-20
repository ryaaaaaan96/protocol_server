// New board-specific fields and rules must work through JSON/JS only.
import fs from "node:fs";
import path from "node:path";
import { genericFixture } from "./generic-boards.mjs";

const boardKey = "SENSOR_MATRIX_47";
const processScript = `export function behavior(context, parameters) {
  if (context.action === "normalize") {
    const values = {...context.fields};
    delete values.calibration_gain;
    if (Object.hasOwn(context.fields, "calibration_gain")) {
      values.metadata = {...context.row.metadata, calibration_gain:Number(context.fields.calibration_gain)};
    }
    return {values};
  }
  if (context.action === "project") return context.rows.map(row => {
    const gain = row.metadata.calibration_gain ?? parameters.default_gain;
    return {id:row.id, values:{
      calibration_gain:gain,
      calibrated_label:row.name + " × " + gain,
      source_count:context.rows.length
    }};
  });
  if (context.action === "reconcile") return context.rows.map(row => ({id:row.id,values:{}}));
  if (context.action === "validate") return context.rows.flatMap(row => {
    const gain = row.metadata.calibration_gain ?? parameters.default_gain;
    return Number.isInteger(gain) && gain >= 1 && gain <= 10 ? [] : [{
      id:row.id, level:"error", code:"calibration_gain",
      message:"校准系数必须是 1～10 的整数"
    }];
  });
  throw new Error("Unexpected behavior action: " + context.action);
}
`;
const collectScript = `export function behavior(context, parameters) {
  if (context.action === "normalize") {
    if (context.source.source_count !== parameters.expected_source_count) throw new Error("Receiver needs the complete source table");
    const values = {...context.fields};
    delete values.receiver_profile;
    if (Object.hasOwn(context.fields, "receiver_profile")) {
      values.metadata = {...context.row.metadata, receiver_profile:String(context.fields.receiver_profile).trim()};
    }
    return {values};
  }
  if (context.action === "project") {
    const sources = new Map(context.sources.map(row => [row.id, row]));
    return context.rows.map(row => ({
      id:row.id, values:{
        receiver_profile:row.metadata.receiver_profile ?? parameters.default_profile,
        source_gain:sources.get(row.process_point_id).calibration_gain,
        source_count:sources.get(row.process_point_id).source_count
      }
    }));
  }
  if (context.action === "reconcile") return context.rows.map(row => ({id:row.id,values:{}}));
  if (context.action === "validate") return [];
  throw new Error("Unexpected behavior action: " + context.action);
}
`;
const forwardScript = `export function behavior(context, parameters) {
  if (context.action === "normalize") {
    if (context.source.source_count !== parameters.expected_source_count) throw new Error("Forwarding needs the complete source table");
    if (Object.hasOwn(context.fields, "upp_model")) throw new Error("UPP 模型号由源校准系数推导，不可单独编辑");
    return {values:{...context.fields}};
  }
  const sources = new Map(context.sources.map(row => [row.id, row]));
  if (context.action === "project") return context.rows.map(row => ({
    id:row.id, values:{
      mapped_gain:sources.get(row.process_point_id).calibration_gain,
      source_count:sources.get(row.process_point_id).source_count
    }
  }));
  if (context.action === "reconcile") return context.rows.map(row => ({
    id:row.id, values:{upp_model:parameters.model_base + sources.get(row.process_point_id).calibration_gain}
  }));
  if (context.action === "validate") return [];
  throw new Error("Unexpected behavior action: " + context.action);
}
`;

export function tableBehaviorFixture(manifest, directory) {
  genericFixture(manifest, directory);
  const board = manifest.topology.board_types[0];
  board.code = boardKey;
  board.model_code = "MATRIX_MODEL_47";
  board.name = "矩阵传感板";
  manifest.topology.root.type = boardKey;
  manifest.workspace.boards = {[boardKey]:manifest.workspace.boards.CONTROL_X};
  manifest.workbook = null;
  manifest.workbook_boards = [boardKey];
  const addBehavior = (filename, behavior, fields, editable, script) => {
    const file = path.join(directory, "UPM", `${filename}.json`);
    const definition = JSON.parse(fs.readFileSync(file, "utf8"));
    definition.behavior = {engine:"javascript", script_file:`${filename}-behavior.js`, ...behavior};
    Object.assign(definition.fields, fields);
    definition.columns.push(...Object.keys(fields));
    definition.editor.push(...editable);
    for (const field of editable) definition.inline[field] = field;
    fs.writeFileSync(file, JSON.stringify(definition));
    fs.writeFileSync(path.join(directory, "UPM", `${filename}-behavior.js`), script);
  };
  addBehavior("process", {
    parameters:{default_gain:1},
    editable_fields:["calibration_gain"],
    metadata_fields:["calibration_gain"],
    project_fields:["calibration_gain", "calibrated_label", "source_count"],
    owned_fields:[],
  }, {
    calibration_gain:{label:"校准系数", type:"number", default:1},
    calibrated_label:{label:"校准显示"},
    source_count:{label:"同板处理点数", type:"number"},
  }, ["calibration_gain"], processScript);
  addBehavior("collect", {
    parameters:{default_profile:"standard", expected_source_count:2},
    editable_fields:["receiver_profile"],
    metadata_fields:["receiver_profile"],
    project_fields:["receiver_profile", "source_gain", "source_count"],
    owned_fields:[],
  }, {
    receiver_profile:{label:"接收策略", default:"standard"},
    source_gain:{label:"源校准系数", type:"number"},
    source_count:{label:"同板处理点数", type:"number"},
  }, ["receiver_profile"], collectScript);
  addBehavior("transmit", {
    parameters:{model_base:100, expected_source_count:2},
    editable_fields:[],
    metadata_fields:[],
    project_fields:["mapped_gain", "source_count"],
    owned_fields:["upp_model"],
  }, {
    mapped_gain:{label:"源校准系数", type:"number"},
    source_count:{label:"同板处理点数", type:"number"},
  }, [], forwardScript);
  const forwardFile = path.join(directory, "UPM/transmit.json");
  const forward = JSON.parse(fs.readFileSync(forwardFile, "utf8"));
  forward.editor = forward.editor.filter(field => field !== "upp_model");
  delete forward.inline.upp_model;
  fs.writeFileSync(forwardFile, JSON.stringify(forward));
}

export async function checkTableBehavior({client, equal, ok, fixtureKey, projectConfigs}) {
  const key = fixtureKey("table_behavior");
  const project = await client.call("/projects", "POST", {config_key:key});
  const url = `/projects/${project.id}`, base = `${url}/boards/${boardKey}/point-tables`;
  const scriptFile = path.join(projectConfigs, key, "UPM/process-behavior.js");
  const original = fs.readFileSync(scriptFile, "utf8");
  const graph = () => client.call(`${url}/topology`);
  const read = kind => client.call(`${base}/${kind}`);
  const history = async () => (await client.call(`${url}/sql`, "POST", {
    sql:"SELECT entity_type,record_id,action,batch_id,before_data,after_data FROM history.events WHERE kind='point' ORDER BY id",
  })).rows;
  const preview = async (kind, values, id = null, who = client) => who.call(`${base}/${kind}/preview`, "POST", {
    revision:(await graph()).revision, operation:id ? "update" : "create", id, values,
  });
  const commit = pending => client.call(`${url}/changes/${pending.id}/commit`, "POST", {});
  const edit = async (kind, values, id = null) => {
    const pending = await preview(kind, values, id);
    ok(pending.allowed, JSON.stringify(pending.errors));
    return (await commit(pending)).record;
  };
  const snapshot = async () => {
    const current = await graph();
    return JSON.stringify({
      revision:current.revision,
      process:current.process_points,
      collect:current.collect_points,
      transmit:current.transmit_points,
      events:await history(),
    });
  };
  const rejectedUpdate = async (kind, values, id) => {
    const before = await snapshot();
    const pending = await client.raw(`${base}/${kind}/preview`, "POST", {
      revision:(await graph()).revision, operation:"update", id, values,
    });
    ok(pending.status === 400 || pending.status === 409 || (pending.status === 200 && pending.data.allowed === false),
      JSON.stringify(pending));
    equal(await snapshot(), before);
    return pending;
  };
  try {
    const initial = await graph();
    equal(initial.process_points.length, 0);
    equal(initial.validation.errors, 0);
    const point = await edit("process", {
      name:"母线电压", enum_name:"MATRIX_BUS_VOLTAGE", group_key:"G_DSP",
      sig_id:47, internal_type:"U16", element_count:1, calibration_gain:2,
    });
    // The second source has no mappings. Every source projection must still see
    // it when normalizing or displaying a mapping for the first source.
    await edit("process", {
      name:"独立测点", enum_name:"MATRIX_UNMAPPED", group_key:"G_DSP",
      sig_id:48, internal_type:"U16", element_count:1, calibration_gain:7,
    });
    equal((await graph()).process_points.find(row => row.id === point.id).metadata.calibration_gain, 2);
    let projected = (await read("process")).rows.find(row => row.id === point.id);
    equal(projected.calibration_gain, 2);
    equal(projected.calibrated_label, "母线电压 × 2");
    equal(projected.edit_values.calibration_gain, 2);
    equal(projected.source_count, 2);
    ok((await read("process")).definition.fields.calibration_gain.label === "校准系数");
    const collected = await edit("collect", {
      process_point_id:point.id, endpoint_key:"E_DSP_UPP", upp_model:7,
      address:6, wire_type:"U16", wire_length:2, poll_interval:35,
      receiver_profile:"  fast  ",
    });
    equal((await read("collect")).rows.find(row => row.id === collected.id).receiver_profile, "fast");
    equal((await read("collect")).rows.find(row => row.id === collected.id).source_gain, 2);
    equal((await read("collect")).rows.find(row => row.id === collected.id).source_count, 2);
    equal((await graph()).collect_points.find(row => row.id === collected.id).metadata.receiver_profile, "fast");
    const forwarded = await edit("forward", {
      process_point_id:point.id, endpoint_key:"E_UPP_SERVICE", address:6,
      wire_type:"U16", wire_length:2,
    });
    equal(forwarded.upp_model, 102);
    equal((await graph()).transmit_points.find(row => row.id === forwarded.id).upp_model, 102);
    equal((await read("forward")).rows.find(row => row.id === forwarded.id).mapped_gain, 2);
    equal((await read("forward")).rows.find(row => row.id === forwarded.id).source_count, 2);

    // Preview and commit include the source metadata plus the linked output field.
    const before = await snapshot(), count = (await history()).length;
    const pending = await preview("process", {calibration_gain:3}, point.id);
    ok(pending.allowed, JSON.stringify(pending.errors));
    equal(pending.impact.count, 2);
    equal(await snapshot(), before);
    await commit(pending);
    equal((await graph()).transmit_points.find(row => row.id === forwarded.id).upp_model, 103);
    equal((await read("forward")).rows.find(row => row.id === forwarded.id).mapped_gain, 3);
    const receiver = (await graph()).collect_points.find(row => row.id === collected.id);
    equal(receiver.poll_interval, 35);
    equal(receiver.metadata.receiver_profile, "fast");
    equal((await read("collect")).rows.find(row => row.id === collected.id).source_gain, 3);
    const events = (await history()).slice(count);
    equal(events.length, 2);
    equal(new Set(events.map(row => row.batch_id)).size, 1);
    equal(events.find(row => row.entity_type === "process").after_data.metadata.calibration_gain, 3);
    equal(events.find(row => row.entity_type === "transmit").after_data.upp_model, 103);
    await rejectedUpdate("process", {calibration_gain:-1}, point.id);
    await rejectedUpdate("process", {metadata:{calibration_gain:9}}, point.id);
    await rejectedUpdate("process", {calibrated_label:"伪造显示"}, point.id);
    await rejectedUpdate("forward", {upp_model:400}, forwarded.id);

    // Changing only JavaScript or parameters invalidates the frozen preview.
    const stale = await preview("process", {calibration_gain:4}, point.id);
    ok(stale.allowed);
    const stable = await snapshot();
    fs.writeFileSync(scriptFile, `${original}\n// rule edited after preview\n`);
    equal((await client.raw(`${url}/changes/${stale.id}/commit`, "POST", {})).status, 409);
    equal(await snapshot(), stable);
    fs.writeFileSync(scriptFile, original);
    const definitionFile = path.join(projectConfigs, key, "UPM/process.json");
    const definition = fs.readFileSync(definitionFile, "utf8");
    const parameterPreview = await preview("process", {calibration_gain:4}, point.id);
    const changed = JSON.parse(definition);
    changed.behavior.parameters.default_gain = 5;
    try {
      fs.writeFileSync(definitionFile, JSON.stringify(changed));
      equal((await client.raw(`${url}/changes/${parameterPreview.id}/commit`, "POST", {})).status, 409);
      equal(await snapshot(), stable);
    } finally {
      fs.writeFileSync(definitionFile, definition);
    }

    // The host owns IDs, immutable source evidence and all undeclared fields.
    for (const illegal of [
      'return {values:{id:1}};',
      'return {values:{metadata:{source_cells:{values:{A:"forged"}}}}};',
      'return {values:{metadata:{not_declared:"forged"}}};',
      'throw new Error("script failure");',
    ]) {
      fs.writeFileSync(scriptFile, original.replace("const values = {...context.fields};", illegal + "\n    const values = {...context.fields};"));
      await rejectedUpdate("process", {calibration_gain:4}, point.id);
    }
    fs.writeFileSync(scriptFile, original.replace(
      'if (context.action === "reconcile") return context.rows.map(row => ({id:row.id,values:{}}));',
      'if (context.action === "reconcile") return [{id:99999999,values:{metadata:{calibration_gain:4}}}];',
    ));
    await rejectedUpdate("process", {calibration_gain:4}, point.id);
    fs.writeFileSync(scriptFile, original);

    // A validator failure already present before the edit still blocks writes;
    // it cannot disappear through the "new errors only" comparison.
    fs.writeFileSync(scriptFile, original.replace(
      'if (context.action === "validate") return context.rows.flatMap(row => {',
      'if (context.action === "validate") throw new Error("validator unavailable");\n'
        + '  if (context.action === "validate") return context.rows.flatMap(row => {',
    ));
    ok((await graph()).validation.issues.some(issue => issue.code === "script_runtime"));
    await rejectedUpdate("process", {calibration_gain:4}, point.id);
    equal((await client.call(`${url}/generate`)).blocked, true);
    fs.writeFileSync(scriptFile, original);

    const final = await graph();
    equal(final.process_points.find(row => row.id === point.id).metadata.calibration_gain, 3);
    equal(final.validation.errors, 0);
    equal((await client.call(`${url}/generate`)).blocked, false);
    equal((await read("process")).rows.find(row => row.id === point.id).calibrated_label, "母线电压 × 3");

    // Owned fields become stale after a JSON rule change; reads never persist it.
    {
      const forwardFile = path.join(projectConfigs, key, "UPM/transmit.json");
      const definitionBefore = fs.readFileSync(forwardFile, "utf8");
      const changedRule = JSON.parse(definitionBefore);
      changedRule.behavior.parameters.model_base = 110;
      const recalculate = async () => {
        const pending = await client.call(`${base}/forward/preview`, "POST", {
          revision:(await graph()).revision, operation:"recalculate", values:{},
        });
        ok(pending.allowed, JSON.stringify(pending.errors));
        return pending;
      };
      try {
        const storedBefore = await snapshot();
        fs.writeFileSync(forwardFile, JSON.stringify(changedRule));
        const generated = await client.call(`${url}/generate`);
        equal(generated.blocked, true);
        ok(generated.validation.issues.some(issue => issue.code === "behavior_stale"));
        equal(await snapshot(), storedBefore);
        const reviewed = await recalculate();
        equal(reviewed.impact.count, 1);
        equal(await snapshot(), storedBefore);
        await commit(reviewed);
        equal((await graph()).transmit_points.find(row => row.id === forwarded.id).upp_model, 113);
        equal((await client.call(`${url}/generate`)).blocked, false);
      } finally {
        fs.writeFileSync(forwardFile, definitionBefore);
      }
      const restored = await recalculate();
      equal(restored.impact.count, 1);
      await commit(restored);
      equal((await graph()).transmit_points.find(row => row.id === forwarded.id).upp_model, 103);
    }

    // Newly configured source fields also feed layout scripts without Rust changes.
    await edit("forward", {address:20}, forwarded.id);
    const forwardDefinitionFile = path.join(projectConfigs, key, "UPM/transmit.json");
    const forwardScriptFile = path.join(projectConfigs, key, "UPM/transmit-behavior.js");
    const originalForwardDefinition = fs.readFileSync(forwardDefinitionFile, "utf8");
    const originalForwardScript = fs.readFileSync(forwardScriptFile, "utf8");
    const calculated = JSON.parse(originalForwardDefinition);
    calculated.calculation = {engine:"javascript", script_file:"transmit-behavior.js", parameters:{}};
    calculated.editor = calculated.editor.filter(field => !["address", "wire_length"].includes(field));
    for (const [column, field] of Object.entries(calculated.inline)) {
      if (["address", "wire_length"].includes(field)) delete calculated.inline[column];
    }
    try {
      fs.writeFileSync(forwardScriptFile, `${originalForwardScript}
export default function calculate(points) {
  return points.map(point => {
    if (Object.hasOwn(point.source, "display_order")
        || ["address", "wire_length", "display_order"].some(key => Object.hasOwn(point.fields, key))) {
      throw Error("Layout input must exclude display order and previous calculated values");
    }
    if (!Object.hasOwn(point.fields, "metadata")) throw Error("Missing custom field storage input");
    return {id:point.id, address:point.source.calibration_gain * 2, wire_length:2};
  });
}
`);
      fs.writeFileSync(forwardDefinitionFile, JSON.stringify(calculated));
      const unchanged = await snapshot();
      equal((await client.call(`${url}/generate`)).blocked, true);
      const recalculated = await client.call(`${base}/forward/preview`, "POST", {
        revision:(await graph()).revision, operation:"recalculate", values:{},
      });
      ok(recalculated.allowed, JSON.stringify(recalculated.errors));
      equal(recalculated.impact.count, 1);
      equal(await snapshot(), unchanged);
      await commit(recalculated);
      equal((await graph()).transmit_points.find(row => row.id === forwarded.id).address, 6);
      await edit("process", {calibration_gain:4}, point.id);
      const linked = (await graph()).transmit_points.find(row => row.id === forwarded.id);
      equal(linked.upp_model, 104);
      equal(linked.address, 8);
      equal(linked.wire_length, 2);
      // A forward layout rule must not rewrite the independent receiver address.
      await edit("collect", {poll_interval:45}, collected.id);
      const independent = (await graph()).collect_points.find(row => row.id === collected.id);
      equal(independent.poll_interval, 45);
      equal(independent.address, 6);
      equal(independent.metadata.receiver_profile, "fast");
      equal((await graph()).transmit_points.find(row => row.id === forwarded.id).address, 8);
      equal((await client.call(`${url}/generate`)).blocked, false);
    } finally {
      fs.writeFileSync(forwardDefinitionFile, originalForwardDefinition);
      fs.writeFileSync(forwardScriptFile, originalForwardScript);
    }
    console.log("PASS: JSON/JS-only new board fields across process/collect/forward, projections, atomic cascades/history, frozen previews and rollback");
  } finally {
    fs.writeFileSync(scriptFile, original);
  }
}
