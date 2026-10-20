import fs from "node:fs";
import path from "node:path";

// Small native fixtures exercise the complete transaction without importing a workbook.
export async function checkUpmAddresses({client,engineer,engineerId,equal,ok,fixtureKey,projectConfigs}) {
  const key=fixtureKey("upm_address");
  const project=await client.call("/projects","POST",{config_key:key});
  const url=`/projects/${project.id}`, table=`${url}/boards/UPM/point-tables`;
  const graph=()=>client.call(`${url}/topology`);
  const preview=async(kind,values,id,who=client)=>who.raw(`${table}/${kind}/preview`,"POST",{
    revision:(await graph()).revision,operation:id?"update":"create",id,values,
  });
  const commit=(pending,who=client)=>who.raw(`${url}/changes/${pending.id}/commit`,"POST",{});
  const edit=async(kind,values,id)=>{
    const pending=await preview(kind,values,id);equal(pending.status,200);ok(pending.data.allowed,JSON.stringify(pending.data.errors));
    const saved=await commit(pending.data);equal(saved.status,200);return saved.data.record;
  };
  const a=await edit("process",{group_key:"DSP",name:"电压",enum_name:"VOLTAGE",sig_id:1,internal_type:"U16",element_count:1});
  const b=await edit("process",{group_key:"DSP",name:"电流",enum_name:"CURRENT",sig_id:2,internal_type:"U16",element_count:1});
  const collection=await edit("collect",{process_point_id:a.id,endpoint_key:"DSP_UPP",upp_model:99,address:6,wire_type:"U16",wire_length:2,scale:1,access:"RO"});
  const forward=await edit("forward",{process_point_id:a.id,endpoint_key:"MODBUS_SERVICE",address:0,wire_type:"U16",wire_length:2,register_type:"HOLDING",scale:1,access:"RO"});
  await edit("forward",{process_point_id:b.id,endpoint_key:"MODBUS_SERVICE",address:20,wire_type:"U16",wire_length:2,register_type:"HOLDING",scale:1,access:"RO"});
  const initial=await graph();
  const originalCollection=initial.collect_points.find(row=>row.id===collection.id);
  const collect=await client.call(`${table}/collect`);
  equal(collect.rows[0].base_address,0);equal(collect.rows[0].edit_values.base_address,0);
  equal(collect.rows[0].address,6);equal(JSON.stringify(await graph()),JSON.stringify(initial));
  for(const base of [-1,1.5,65536,20]) {
    const rejected=await preview("collect",{base_address:base},collection.id);
    equal(rejected.status,200);equal(rejected.data.allowed,false);
    equal(JSON.stringify(await graph()),JSON.stringify(initial));
  }
  const pending=await preview("collect",{base_address:6},collection.id);
  equal(pending.status,200);ok(pending.data.allowed,JSON.stringify(pending.data.errors));
  equal(pending.data.impact.count,2);
  equal(JSON.stringify(await graph()),JSON.stringify(initial));
  equal((await commit(pending.data)).status,200);
  let current=await graph();
  equal(current.collect_points.find(row=>row.id===collection.id).metadata.base_address,6);
  equal(current.collect_points.find(row=>row.id===collection.id).address,6);
  equal(current.transmit_points.find(row=>row.id===forward.id).address,6);
  equal(current.collect_points.find(row=>row.id===collection.id).poll_interval,originalCollection.poll_interval);
  let display=(await client.call(`${table}/forward`)).rows.find(row=>row.id===forward.id);
  equal(display.instance_rows[0].address,50006);equal(display.instance_rows[7].address,57006);
  let receiver=(await client.call(`${url}/boards/UPM_DEMO/point-tables/collect`)).rows;
  equal(receiver.find(row=>row.source_id===forward.id&&row.source_device_code==="DSP8").address,57006);
  const history=(await client.call(`${url}/sql`,"POST",{sql:"SELECT entity_type,batch_id,after_data FROM history.events WHERE kind='point' ORDER BY id DESC LIMIT 2"})).rows;
  equal(new Set(history.map(row=>row.batch_id)).size,1);
  ok(history.some(row=>row.entity_type==="collect"&&row.after_data.metadata.base_address===6));
  ok(history.some(row=>row.entity_type==="transmit"&&row.after_data.address===6));
  const manual=await preview("forward",{address:10},forward.id);equal(manual.data.allowed,false);
  // Collector-only grants must not change a linked transmitter through the script.
  await client.call(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer",edit_scope:"scoped",grants:[{board_key:"UPM",scope:"protocol",endpoint_key:"DSP_UPP"}]});
  equal((await preview("collect",{base_address:8},collection.id,engineer)).status,403);
  equal((await graph()).collect_points.find(row=>row.id===collection.id).metadata.base_address,6);
  const merged=await preview("collect",{base_address:8},collection.id);
  await edit("forward",{scale:2},forward.id);
  const mergedResult=await commit(merged.data);equal(mergedResult.status,200);equal(mergedResult.data.merged,true);
  current=await graph();equal(current.transmit_points.find(row=>row.id===forward.id).address,8);
  equal(Number(current.transmit_points.find(row=>row.id===forward.id).scale),2);
  const conflict=await preview("collect",{base_address:12},collection.id);
  await edit("collect",{base_address:14},collection.id);
  equal((await commit(conflict.data)).status,409);
  const scriptFile=path.join(projectConfigs,key,"UPM/transmit.js");
  const configFile=path.join(projectConfigs,key,"UPM/transmit.json");
  const script=fs.readFileSync(scriptFile,"utf8"), config=fs.readFileSync(configFile,"utf8");
  try {
    const frozen=await preview("collect",{base_address:15},collection.id);ok(frozen.data.allowed);
    fs.writeFileSync(scriptFile,script+"\n// changed after preview\n");
    equal((await commit(frozen.data)).status,409);fs.writeFileSync(scriptFile,script);
    // Linked rules can be explicitly recalculated after a reviewed rule change.
    fs.writeFileSync(scriptFile,script.replace("return unique[0];","return unique[0] == null ? undefined : unique[0] + 1;"));
    const stale=await client.call(`${url}/generate`);equal(stale.blocked,true);
    ok(stale.validation.issues.some(issue=>issue.code==="behavior_stale"));
    const recalculate=async()=>{
      const pending=await client.call(`${table}/forward/preview`,"POST",{revision:(await graph()).revision,operation:"recalculate",values:{}});
      ok(pending.allowed,JSON.stringify(pending.errors));equal((await commit(pending)).status,200);
    };
    await recalculate();equal((await graph()).transmit_points.find(row=>row.id===forward.id).address,15);
    fs.writeFileSync(scriptFile,script);
    await recalculate();equal((await graph()).transmit_points.find(row=>row.id===forward.id).address,14);
    const before=await graph();
    const changed=JSON.parse(config);
    changed.behavior.parameters.modbus_layouts.DSP={template_base:40000,device_stride:128};
    fs.writeFileSync(configFile,JSON.stringify(changed));
    const changedScript=script.replace("layout.template_base + row.base_address","layout.template_base + row.base_address + 1");
    fs.writeFileSync(scriptFile,changedScript);
    display=(await client.call(`${table}/forward`)).rows.find(row=>row.id===forward.id);
    equal(display.instance_rows[7].address,40911);
    receiver=(await client.call(`${url}/boards/UPM_DEMO/point-tables/collect`)).rows;
    equal(receiver.find(row=>row.source_id===forward.id&&row.source_device_code==="DSP8").address,40911);
    const generated=await client.call(`${url}/generate`);equal(generated.blocked,false);
    const instances=JSON.parse(generated.files["board_types/UPM/transmit-instances.json"]);
    equal(instances.find(row=>row.id===forward.id&&row.device.code==="DSP8").address,40911);
    const definition=JSON.parse(generated.files["board_types/UPM/transmit.json"]).table_definition;
    equal(definition.behavior.script,changedScript);equal(definition.behavior.parameters.modbus_layouts.DSP.device_stride,128);
    const after=await graph();equal(after.revision,before.revision);
    equal(JSON.stringify(after.collect_points),JSON.stringify(before.collect_points));
    equal(JSON.stringify(after.transmit_points),JSON.stringify(before.transmit_points));
    changed.behavior.parameters.modbus_layouts.DSP.device_stride=0;
    fs.writeFileSync(configFile,JSON.stringify(changed));
    const collision=await client.call(`${url}/generate`);equal(collision.blocked,true);
    ok(collision.validation.issues.some(issue=>issue.code==="overlap"));
  } finally {fs.writeFileSync(scriptFile,script);fs.writeFileSync(configFile,config);}
  await edit("collect",{base_address:null},collection.id);
  ok((await graph()).collect_points.find(row=>row.id===collection.id).metadata.base_address==null);
  await edit("forward",{address:16},forward.id);
  equal((await client.call(`${table}/collect`)).rows[0].base_address,16);
  console.log("PASS: persisted collection base, atomic linked history/permissions/merges, independent UPP address, live JS/JSON formulas and shared view/receiver/generation");
}
