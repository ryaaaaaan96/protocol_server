// Scripted layouts use real transactions, permission checks and immutable previews.
import fs from "node:fs";
import path from "node:path";

export async function checkTableCalculation({client, engineer, engineerId, equal, ok, fixtureKey, projectConfigs}) {
  const key = fixtureKey("dsp_calculation");
  const project = await client.call("/projects", "POST", {config_key:key});
  const url = `/projects/${project.id}`, table = `${url}/boards/DSP/point-tables`;
  const filename = path.join(projectConfigs,key,"DSP/transmit.json");
  const scriptFile = path.join(projectConfigs,key,"DSP/transmit.js");
  const original = fs.readFileSync(filename,"utf8");
  const originalScript = fs.readFileSync(scriptFile,"utf8");
  let definition = JSON.parse(original);
  const write = () => fs.writeFileSync(filename,JSON.stringify(definition));
  const writeScript = body => fs.writeFileSync(scriptFile,`export default function calculate(points, parameters) { ${body} }\n`);
  const graph = () => client.call(`${url}/topology`);
  const history = async () => (await client.call(`${url}/sql`,"POST",{sql:"SELECT record_id,entity_type,action,batch_id,before_data,after_data FROM history.events WHERE kind='point' ORDER BY id"})).rows;
  const proposal = async (kind, values, id = null, who = client, operation = id ? "update" : "create") => who.call(`${table}/${kind}/preview`,"POST",{
    revision:(await graph()).revision,operation,id,values,
  });
  const commit = (preview,who = client) => who.call(`${url}/changes/${preview.id}/commit`,"POST",{});
  const edit = async (kind,values,id = null,who = client) => {
    const preview = await proposal(kind,values,id,who);
    ok(preview.allowed,JSON.stringify(preview.errors));
    return (await commit(preview,who)).record;
  };
  const recalculate = () => proposal("forward",{},null,client,"recalculate");
  const reject = async (kind,values,id = null) => {
    const before = JSON.stringify(await graph()), events = JSON.stringify(await history());
    const preview = await proposal(kind,values,id);
    equal(preview.allowed,false);
    equal(JSON.stringify(await graph()),before);
    equal(JSON.stringify(await history()),events);
  };
  await client.call(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer"});
  try {
    const first = await edit("process",{name:"脚本数组",variable_name:"ScriptArray",sheet_type:"Sys_U16",element_count:3,category:"任务级观测量",upload_level:"1：上传至UPM"});
    const second = await edit("process",{name:"脚本标量",variable_name:"ScriptScalar",sheet_type:"Sys_U16",element_count:1,category:"任务级观测量",upload_level:"1：上传至UPM"});
    const a = await edit("forward",{process_point_id:first.id});
    const b = await edit("forward",{process_point_id:second.id});
    equal(a.address,6);equal(a.wire_length,6);equal(b.address,12);equal(b.wire_length,2);
    const data = await client.call(`${table}/forward`);
    equal(data.definition.calculation.engine,"javascript");
    equal(data.definition.calculation.script_file,"transmit.js");
    for (const field of ["address","wire_length"]) ok(!data.definition.editor.includes(field));
    await reject("forward",{address:50},a.id);
    await reject("forward",{wire_length:10},a.id);

    const before = await graph(), count = (await history()).length;
    const resize = await proposal("process",{element_count:5},first.id);
    ok(resize.allowed,JSON.stringify(resize.errors));equal(resize.impact.count,3);
    equal(JSON.stringify(await graph()),JSON.stringify(before));
    await commit(resize);
    let current = await graph();
    equal(current.transmit_points.find(row=>row.id===a.id).wire_length,10);
    equal(current.transmit_points.find(row=>row.id===b.id).address,16);
    const events = (await history()).slice(count);
    equal(events.length,3);equal(new Set(events.map(row=>row.batch_id)).size,1);

    // Display order never feeds the protocol calculation.
    const forward = await client.call(`${table}/forward`);
    const ids = forward.rows.map(row=>row.id);
    const reorder = await client.call(`${table}/forward/reorder/preview`,"POST",{revision:current.revision,ids:[...ids].reverse(),expected:ids});
    ok(reorder.allowed);await commit(reorder);
    current = await graph();
    equal(current.transmit_points.find(row=>row.id===b.id).address,16);
    const noop = await recalculate();ok(noop.allowed);equal(noop.impact.count,0);

    // Upload priority and category edits use the script's stable source ordering.
    await edit("process",{upload_level:"3：CSU进行轮询"},second.id);
    current = await graph();
    equal(current.transmit_points.find(row=>row.id===b.id).address,6);
    equal(current.transmit_points.find(row=>row.id===a.id).address,8);
    await edit("process",{category:"中断级观测量"},second.id);
    current = await graph();
    equal(current.transmit_points.find(row=>row.id===b.id).upp_model,100);
    equal(current.transmit_points.find(row=>row.id===b.id).address,6);
    equal(current.transmit_points.find(row=>row.id===a.id).address,6);

    // Batch operations calculate once after all rows and return final values.
    const batch = await client.call(`${table}/forward/batch/preview`,"POST",{
      revision:current.revision,rows:[{row:2,values:{process_point_id:first.id}},{row:3,values:{process_point_id:second.id}}],
    });
    ok(batch.allowed,JSON.stringify(batch.errors));
    const batchResult = await commit(batch);
    equal(batchResult.record.rows[0].record.address,16);
    equal(batchResult.record.rows[1].record.address,8);

    // JSON changes are live but are not hidden database writes.
    const stale = await proposal("process",{notes:"旧脚本预览"},first.id);
    ok(stale.allowed);
    const prior = JSON.stringify(await graph());
    definition.calculation.parameters.header_bytes = 20;write();
    equal(JSON.stringify(await graph()),prior);
    const denied = await client.raw(`${url}/changes/${stale.id}/commit`,"POST",{});
    equal(denied.status,409);ok(denied.data.error.includes("脚本"));
    equal(JSON.stringify(await graph()),prior);
    equal((await client.call(`${url}/generate`)).blocked,true);
    const refresh = await recalculate();ok(refresh.allowed);equal(refresh.impact.count,4);
    await commit(refresh);
    equal((await client.call(`${url}/generate`)).blocked,false);
    current = await graph();
    equal(current.transmit_points.find(row=>row.id===a.id).address,20);
    equal(current.transmit_points.find(row=>row.id===b.id).address,20);

    // Editing only the referenced JS file also invalidates a reviewed preview.
    const oldSource = await proposal("process",{notes:"JS 文件旧预览"},first.id);
    ok(oldSource.allowed);
    fs.writeFileSync(scriptFile,`${originalScript}\n// Changed after preview\n`);
    const sourceBefore = JSON.stringify(await graph());
    equal((await client.raw(`${url}/changes/${oldSource.id}/commit`,"POST",{})).status,409);
    equal(JSON.stringify(await graph()),sourceBefore);
    fs.writeFileSync(scriptFile,originalScript);

    // A later source change cannot enlarge the effects in a reviewed layout.
    const staleResize = await proposal("process",{element_count:6},first.id);
    ok(staleResize.allowed);
    await edit("forward",{process_point_id:first.id},null,engineer);
    const snapshot = JSON.stringify(await graph());
    equal((await client.raw(`${url}/changes/${staleResize.id}/commit`,"POST",{})).status,409);
    equal(JSON.stringify(await graph()),snapshot);
    // Unrelated metadata still merges with derived changes on other fields.
    const mergeable = await proposal("process",{element_count:6},first.id);
    ok(mergeable.allowed);
    await edit("process",{notes:"保留并发备注"},first.id,engineer);
    equal((await commit(mergeable)).merged,true);
    equal((await graph()).process_points.find(row=>row.id===first.id).notes,"保留并发备注");

    // Scoped users cannot move the protocol addresses with internal-only grants.
    await client.call(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer",edit_scope:"scoped",grants:[{board_key:"DSP",scope:"internal"}]});
    const scopedBefore = JSON.stringify(await graph());
    equal((await engineer.raw(`${table}/process/preview`,"POST",{revision:(await graph()).revision,operation:"update",id:first.id,values:{element_count:7}})).status,403);
    equal(JSON.stringify(await graph()),scopedBefore);
    await client.call(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer"});

    // Exceptions cannot weaken backend type, bounds, output or overlap validation.
    const good = JSON.parse(JSON.stringify(definition));
    for (const script of ["while (true) {}", "return points.map(p => ({id:p.id,address:6,wire_length:2}));", "return [];"]) {
      writeScript(script);
      await reject("process",{notes:"不应保存"},first.id);
    }
    fs.writeFileSync(scriptFile,originalScript);
    definition = JSON.parse(JSON.stringify(good));
    definition.calculation.parameters.type_bytes.U16 = 3;write();
    await reject("process",{notes:"非法协议长度"},first.id);
    definition = JSON.parse(JSON.stringify(good));
    definition.calculation.parameters.fixed_offsets["脚本标量"] = 65535;write();
    await reject("process",{notes:"越界固定地址"},first.id);
    definition = JSON.parse(JSON.stringify(good));write();

    // A new calculation algorithm needs only a JS file change.
    writeScript('return points.map(p => ({id:p.id,address:100+p.id*20,wire_length:p.wire_type === "STRING" ? p.byte_length : parameters.type_bytes[p.wire_type]}));');
    const custom = await recalculate();ok(custom.allowed,JSON.stringify(custom.errors));await commit(custom);
    current = await graph();
    for (const row of current.transmit_points) equal(row.address,100+row.id*20);
    // Deletion also recomputes the remaining rows with the current script.
    const removed = await proposal("forward",{},b.id,client,"delete");ok(removed.allowed);await commit(removed);
    ok(!(await graph()).transmit_points.some(row=>row.id===b.id));
    console.log("PASS: table scripts, atomic cascades, JSON reload, stale-rule guards, history, permissions, batch results and rollback");
  } finally {
    fs.writeFileSync(filename,original);
    fs.writeFileSync(scriptFile,originalScript);
  }
}
