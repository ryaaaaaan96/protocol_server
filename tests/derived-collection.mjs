import fs from "node:fs";
import path from "node:path";

export async function checkDerivedCollection({client,url,graph,equal,ok,projectConfigs,key}) {
  const base=`${url}/boards/UPM_DEMO/point-tables`;
  const initial=await graph();
  equal(initial.project_config.version,3);
  equal(initial.project_config.roots.map(root=>root.type).sort().join(","),"CSU,UPM_DEMO");
  equal(initial.project_config.mounts.filter(link=>link.child==="UPM").map(link=>link.parent).sort().join(","),"CSU,UPM_DEMO");
  ok(initial.project_config.mounts.every(link=>link.child!=="UPM_DEMO"));
  const invalid=structuredClone(initial.project_config);
  invalid.mounts.find(link=>link.parent==="UPM_DEMO").quantity++;
  const rejected=await client.call(`${url}/changes/preview`,"POST",{revision:initial.revision,entity:"project_config",operation:"update",values:invalid});
  equal(rejected.allowed,false);ok(rejected.errors.some(issue=>issue.message.includes("数量不一致")));
  equal(JSON.stringify(await graph()),JSON.stringify(initial));
  const stored=()=>JSON.stringify([initial.process_points,initial.collect_points,initial.transmit_points]);
  const baseline=stored();
  const schema=await client.call(`${url}/point-tables/schema`);
  equal(schema.workspace.boards.UPM_DEMO.tables.join(","),"collect");
  const data=await client.call(`${base}/collect`);
  equal(data.derived,true);equal(data.storage,"derived");equal(data.rows.length,3646);
  equal(initial.derived_collections.UPM_DEMO.rows.length,3646);
  equal(data.rows.filter(r=>r.source_device_code==="LOCAL").length,86);
  equal(data.rows.filter(r=>r.source_device_code==="DSP8").length,445);
  ok(data.rows.every(r=>r.dev_id===1 && r.poll_interval===1000 && r.can_edit===false));
  const source=initial.project_config.board_types.find(b=>b.code==="UPM");
  const records=initial.transmit_points.filter(r=>r.board_key==="UPM"&&r.endpoint_key==="MODBUS_SERVICE");
  const indexed=new Map(data.rows.map(r=>[`${r.source_id}:${r.source_device_code}`,r]));
  for(const record of records){
    const point=initial.process_points.find(p=>p.id===record.process_point_id);
    const group=source.point_groups.find(g=>g.code===point.group_key);
    for(const device of group.devices){
      const row=indexed.get(`${record.id}:${device.code}`);ok(row);
      equal(row.address,record.address+device.modbus_base);
      equal(row.register_count,Math.ceil(record.wire_length/2));
      equal(row.wire_type,record.wire_type);equal(row.scale,record.scale);
    }
  }
  equal((await client.raw(`${base}/process`)).status,400);
  const denied=await client.raw(`${base}/collect/preview`,"POST",{revision:initial.revision,operation:"create",values:{address:0}});
  ok(denied.status===400 || denied.data.allowed===false);
  const unchanged=await graph();equal(JSON.stringify([unchanged.process_points,unchanged.collect_points,unchanged.transmit_points]),baseline);
  const localHolding=records.find(r=>r.register_type==="HOLDING"&&initial.process_points.find(p=>p.id===r.process_point_id)?.group_key==="LOCAL");
  const dspHolding=records.find(r=>r.register_type==="HOLDING"&&initial.process_points.find(p=>p.id===r.process_point_id)?.group_key==="DSP");
  ok(localHolding);ok(dspHolding);
  const collision=await client.call(`${url}/boards/UPM/point-tables/forward/preview`,"POST",{revision:(await graph()).revision,operation:"update",id:localHolding.id,values:{address:dspHolding.address+50000}});
  equal(collision.allowed,false);ok(collision.errors.some(issue=>issue.code==="derived_mapping"));
  const sourceRow=records.find(r=>initial.process_points.find(p=>p.id===r.process_point_id)?.group_key==="LOCAL");
  const change=async address=>{
    const pending=await client.call(`${url}/boards/UPM/point-tables/forward/preview`,"POST",{revision:(await graph()).revision,operation:"update",id:sourceRow.id,values:{address}});
    ok(pending.allowed,JSON.stringify(pending.errors));await client.call(`${url}/changes/${pending.id}/commit`,"POST",{});
  };
  await change(62000);
  equal((await client.call(`${base}/collect`)).rows.find(r=>r.source_id===sourceRow.id).address,62000);
  await change(sourceRow.address);
  const definitionFile=path.join(projectConfigs,key,"upm-demo/collect.json");
  const original=fs.readFileSync(definitionFile,"utf8");const revision=(await graph()).revision;
  try {
    const definition=JSON.parse(original);definition.mapping.parameters.upm_dev_id=7;
    fs.writeFileSync(definitionFile,JSON.stringify(definition));
    ok((await client.call(`${base}/collect`)).rows.every(r=>r.dev_id===7));
    equal((await graph()).revision,revision);
  } finally {fs.writeFileSync(definitionFile,original);}
  const scriptFile=path.join(projectConfigs,key,"upm-demo/collect.js"),script=fs.readFileSync(scriptFile,"utf8");
  try {
    fs.writeFileSync(scriptFile,"export default () => [];");
    equal((await client.raw(`${base}/collect`)).status,400);
    const generated=await client.call(`${url}/generate`);equal(generated.blocked,true);
    ok(generated.validation.issues.some(issue=>issue.code==="derived_mapping"));
  } finally {fs.writeFileSync(scriptFile,script);}
  const generated=await client.call(`${url}/generate`);equal(generated.blocked,false);
  const projected=JSON.parse(generated.files["board_types/UPM_DEMO/collect.json"]);
  equal(projected.points.length,3646);equal(projected.mapping.script,script);
  const final=await graph();
  ok(final.process_points.every(p=>p.board_key!=="UPM_DEMO"));
  ok(final.collect_points.every(p=>p.board_key!=="UPM_DEMO"));
  console.log("PASS: upm-demo full Modbus mapping, 3646 instances, live JS/JSON, readonly API, source edits and frozen generation");
}
