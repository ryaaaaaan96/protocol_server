import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { exportProject } from "../scripts/export-project.mjs";

export async function checkUpmPoints({client,engineer,engineerId,viewer,viewerId,equal,ok,fixtureKey,projectConfigs,testEnv}) {
  const project=await client.call("/projects","POST",{config_key:fixtureKey("upm")});
  const url=`/projects/${project.id}`,table=`${url}/boards/UPM/point-tables`;
  const graph=()=>client.call(`${url}/topology`);
  const commit=p=>client.call(`${url}/changes/${p.id}/commit`,"POST",{});
  const preview=async(kind,values,id,who=client,extra={})=>who.raw(`${table}/${kind}/preview`,"POST",{
    revision:(await graph()).revision,operation:id?"update":"create",id,values,...extra,
  });
  const edit=async(kind,values,id)=>{
    const p=await preview(kind,values,id);equal(p.status,200);ok(p.data.allowed,JSON.stringify(p.data.errors));
    return (await commit(p.data)).record;
  };
  const before=await graph();
  equal(before.schema_version,6);
  equal(before.validation.errors,0);
  equal(before.process_points.filter(p=>p.board_key==="UPM").length,606);
  equal(before.collect_points.length,445);
  equal(before.process_points.filter(p=>p.board_key==="DSP").length,552);
  const dsp=JSON.stringify(before.process_points.filter(p=>p.board_key==="DSP"));
  const upm=before.project_config.board_types.find(b=>b.code==="UPM");
  equal(upm.point_groups.find(g=>g.code==="DSP").devices.length,8);
  equal(upm.point_groups.find(g=>g.code==="DSP").devices.at(-1).modbus_base,57000);
  const process=await client.call(`${table}/process`),collect=await client.call(`${table}/collect`),forward=await client.call(`${table}/forward`);
  equal(collect.rows.length,445);
  ok(collect.rows.every(r=>r.group_key==="DSP"));
  ok(process.rows.filter(r=>r.group_key==="LOCAL").every(r=>r.collection_count===0));
  equal(process.rows.find(r=>r.enum_name==="LOCAL_SIG_32058").internal_type,"U16");
  const alias=process.rows.find(r=>r.enum_name==="LOCAL_SIG_DSP_ON_LINE_NUM");
  equal(forward.rows.filter(r=>r.process_point_id===alias.id).length,3);
  equal(forward.rows.filter(r=>r.endpoint_key==="UPP_SERVICE").length,29);
  ok(forward.rows.some(r=>r.group_key==="DSP" && r.device_addresses.includes("DSP1: 50000") && r.device_addresses.includes("DSP8: 57000")));
  ok(forward.rows.filter(r=>r.endpoint_key==="MODBUS_SERVICE").every(r=>r.register_count===Math.ceil(r.wire_length/2)));
  const polling=collect.rows.find(r=>r.acquisition_mode==="poll" && r.poll_interval===3);
  const first=await preview("collect",{poll_interval:7},polling.id);
  equal(first.status,200);ok(first.data.allowed,JSON.stringify(first.data.errors));
  equal((await client.call(`${table}/collect`)).rows.find(r=>r.id===polling.id).poll_interval,3);
  await commit(first.data);
  equal((await client.call(`${table}/collect`)).rows.find(r=>r.id===polling.id).poll_interval,7);
  const history=(await client.call(`${url}/sql`,"POST",{sql:"SELECT entity_type,after_data FROM history.events WHERE kind='point' AND entity_type='collect' ORDER BY id DESC LIMIT 1"})).rows;
  equal(history[0].entity_type,"collect");equal(history[0].after_data.poll_interval,7);
  const stable=JSON.stringify(await graph());
  const invalid=await preview("collect",{process_point_id:alias.id,endpoint_key:"DSP_UPP",upp_model:1,address:100,wire_type:"U16",wire_length:2});
  equal(invalid.data.allowed,false);equal(JSON.stringify(await graph()),stable);
  const another=forward.rows.find(r=>r.group_key==="DSP" && r.endpoint_key==="MODBUS_SERVICE" && r.address>30);
  const overlap=await preview("forward",{address:0},another.id);
  equal(overlap.data.allowed,false);
  equal(JSON.stringify(await graph()),stable);

  await client.call(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer",edit_scope:"scoped",
    grants:[{board_key:"UPM",scope:"protocol",endpoint_key:"MODBUS_SERVICE"}]});
  equal((await preview("collect",{poll_interval:8},polling.id,engineer)).status,403);
  await client.call(`${url}/members`,"PUT",{user_id:viewerId,role:"viewer"});
  equal((await preview("collect",{poll_interval:8},polling.id,viewer)).status,403);
  await client.call(`${url}/members`,"PUT",{user_id:engineerId,role:"engineer",edit_scope:"scoped",
    grants:[{board_key:"UPM",scope:"protocol",endpoint_key:"DSP_UPP"}]});
  const allowed=await preview("collect",{poll_interval:8},polling.id,engineer);
  equal(allowed.status,200);ok(allowed.data.allowed);

  const baseline=await graph();
  const old=await client.call(`${table}/collect`);
  const expected=old.rows.find(r=>r.id===polling.id).edit_values;
  const pending=await preview("collect",{poll_interval:9},polling.id);
  await edit("collect",{scan_priority:1},polling.id);
  await commit(pending.data); // disjoint fields merge
  const conflict=await preview("collect",{poll_interval:10},polling.id,client,{revision:baseline.revision,expected});
  equal(conflict.status,409);
  const batch=await client.call(`${table}/collect/batch/preview`,"POST",{
    revision:(await graph()).revision,operation:"update",
    rows:[{row:1,id:polling.id,values:{poll_interval:11,set_priority:null}}],
  });
  ok(batch.allowed,JSON.stringify(batch.errors));await commit(batch);
  equal((await client.call(`${table}/collect`)).rows.find(r=>r.id===polling.id).poll_interval,11);
  equal(JSON.stringify((await graph()).process_points.filter(p=>p.board_key==="DSP")),dsp);

  const form=new FormData();
  form.append("file",new Blob([fs.readFileSync(path.join(projectConfigs,fixtureKey("upm"),"sources/DC-UPS测点数据表.xlsx"))]),"upm.xlsx");
  const imported=await client.call(`${url}/imports/preview?board=UPM`,"POST",form);
  equal(imported.import_scope,"upm");equal(imported.collect_count,445);equal(imported.local_count,161);
  await client.call(`${url}/imports/${imported.id}/commit`,"POST",{replace:true});
  equal(JSON.stringify((await graph()).process_points.filter(p=>p.board_key==="DSP")),dsp);
  equal((await graph()).validation.errors,0);
  const current=JSON.stringify(await graph());
  execFileSync("target/debug/protocol-server",["import-upm",fixtureKey("upm")],{env:testEnv,stdio:"pipe"});
  equal(JSON.stringify(await graph()),current,"repeated CLI import must preserve edits and revisions");
  console.log("PASS: UPM workbook import, editing, permissions and concurrent merge");

  const upgrade=await client.call("/projects","POST",{config_key:fixtureKey("dsp_native")});
  const upgradeBefore=await client.call(`/projects/${upgrade.id}/topology`);
  const manifest=JSON.parse(fs.readFileSync(path.join(projectConfigs,fixtureKey("upm"),"project.json"),"utf8"));
  manifest.key=fixtureKey("dsp_native"); manifest.name=manifest.key;
  fs.writeFileSync(path.join(projectConfigs,manifest.key,"project.json"),JSON.stringify(manifest));
  execFileSync("target/debug/protocol-server",["import-upm",manifest.key],{env:testEnv,stdio:"pipe"});
  const upgraded=await client.call(`/projects/${upgrade.id}/topology`);
  equal(upgraded.collect_points.length,445);
  equal(upgraded.validation.errors,0);
  equal(JSON.stringify(upgraded.process_points.filter(p=>p.board_key==="DSP")),JSON.stringify(upgradeBefore.process_points));
  equal(JSON.stringify(upgraded.transmit_points.filter(p=>p.board_key==="DSP")),JSON.stringify(upgradeBefore.transmit_points));
  console.log("PASS: additive UPM initialization preserves existing DSP rows");

  const exportParent=fs.mkdtempSync(path.join(projectConfigs,".export-upm-"));
  try {
    const exported=await exportProject(fixtureKey("upm"),exportParent,testEnv);
    const folder=exported.directory || path.join(exportParent,fixtureKey("upm"));
    const form=new FormData();
    const walk=(directory,relative="")=>{
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
        const name=relative?`${relative}/${entry.name}`:entry.name,filename=path.join(directory,entry.name);
        if(entry.isDirectory())walk(filename,name);
        else form.append("files",new Blob([fs.readFileSync(filename)]),`upm-export/${name}`);
      }
    };
    walk(folder);
    const restoredPreview=await client.rawUnlocked("/project-folders/preview","POST",form);
    equal(restoredPreview.status,200);ok(restoredPreview.data.replace_data);
    const restored=await client.rawUnlocked("/project-folders/commit","POST",{token:restoredPreview.data.token});
    equal(restored.status,200);
    const restoredGraph=await graph();
    equal(restoredGraph.collect_points.length,445);
    equal(restoredGraph.validation.errors,0);
    equal(restoredGraph.transmit_points.length,JSON.parse(current).transmit_points.length);
    const ids=new Set(restoredGraph.process_points.filter(p=>p.board_key==="UPM").map(p=>p.id));
    ok(restoredGraph.collect_points.every(c=>ids.has(c.process_point_id)));
  } finally { fs.rmSync(exportParent,{recursive:true,force:true}); }
  console.log("PASS: UPM shared device templates, workbook import, collection editing, history, permissions, Modbus addresses and concurrent conflicts");
}
