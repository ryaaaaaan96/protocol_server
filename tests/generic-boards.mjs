// A board unknown to Rust: rename all organizational keys in JSON, then use HTTP.
import fs from "node:fs";
import path from "node:path";
import { exportProject } from "../scripts/export-project.mjs";
export function genericFixture(manifest,directory) {
  const board=structuredClone(manifest.topology.board_types.find(b=>b.code==="UPM"));
  board.code="CONTROL_X";board.name="通用控制板";board.model_code="CUSTOM_MODEL";board.point_rules.sheet_layout=false;board.point_rules.value_options={};
  for(const group of board.point_groups)group.code=`G_${group.code}`;
  for(const endpoint of board.point_endpoints){endpoint.code=`E_${endpoint.code}`;endpoint.direction ||= "transmit";}
  manifest.topology={version:2,board_types:[board],root:{type:board.code,quantity:1},mounts:[]};
  manifest.workspace={boards:{CONTROL_X:manifest.workspace.boards.UPM}};
  manifest.workbook_boards=[board.code];
  const filename=path.join(directory,"UPM/workbook.json");
  const mapping=JSON.parse(fs.readFileSync(filename,"utf8"));
  for(const kind of ["process","collect","transmit"]) for(const source of mapping[kind]) {
    source.group=`G_${source.group}`;if(source.endpoint)source.endpoint=`E_${source.endpoint}`;
  }
  fs.writeFileSync(filename,JSON.stringify(mapping));
}
export async function checkGenericBoards({client,equal,ok,fixtureKey,projectConfigs,testEnv}) {
  const key=fixtureKey("generic");
  const project=await client.call("/projects","POST",{config_key:key});
  const url=`/projects/${project.id}`,table=`${url}/boards/CONTROL_X/point-tables`;
  const graph=()=>client.call(`${url}/topology`);
  const before=await graph();equal(before.validation.errors,0);
  equal(before.process_points.length,606);equal(before.collect_points.length,445);equal(before.transmit_points.length,560);
  ok(before.process_points.every(p=>p.board_key==="CONTROL_X"));
  const source=before.process_points.find(p=>p.group_key==="G_DSP");
  const change=await client.call(`${table}/process/preview`,"POST",{revision:before.revision,operation:"update",id:source.id,values:{notes:"JSON 定义的新板卡"}});
  ok(change.allowed,JSON.stringify(change.errors));await client.call(`${url}/changes/${change.id}/commit`,"POST",{});
  equal((await graph()).process_points.find(p=>p.id===source.id).notes,"JSON 定义的新板卡");
  const [first,second]=before.collect_points;
  const conflict=await client.call(`${table}/collect/preview`,"POST",{revision:(await graph()).revision,operation:"update",id:second.id,values:{address:first.address,upp_model:first.upp_model}});
  equal(conflict.allowed,false);ok(conflict.errors.some(e=>e.code==="overlap"));
  const local=before.process_points.find(p=>p.group_key==="G_LOCAL");
  const denied=await client.raw(`${table}/collect/preview`,"POST",{revision:(await graph()).revision,operation:"create",values:{process_point_id:local.id,endpoint_key:"E_DSP_UPP"}});
  ok(denied.status===400 || denied.data.allowed===false);
  const upload=()=>{const form=new FormData();form.append("file",new Blob([fs.readFileSync(path.join(projectConfigs,key,"sources/DC-UPS测点数据表.xlsx"))]),"points.xlsx");return client.call(`${url}/imports/preview?board=CONTROL_X`,"POST",form);};
  const pending=await upload();equal(pending.board_key,"CONTROL_X");equal(pending.collect_count,445);
  const file=path.join(projectConfigs,key,"UPM/workbook.json"),original=fs.readFileSync(file,"utf8");
  const baseline=await graph();
  try {
    const changed=JSON.parse(original);changed.warnings.push("配置已修改");fs.writeFileSync(file,JSON.stringify(changed));
    equal((await client.raw(`${url}/imports/${pending.id}/commit`,"POST",{replace:true})).status,409);
    equal((await graph()).revision,baseline.revision);
  } finally {fs.writeFileSync(file,original);}
  const fresh=await upload();await client.call(`${url}/imports/${fresh.id}/commit`,"POST",{replace:true});
  equal((await graph()).validation.errors,0);
  const generated=await client.call(`${url}/generate`);
  equal(generated.blocked,false);ok(Object.keys(generated.files).some(f=>f.startsWith("board_types/CONTROL_X/")));
  const destination=fs.mkdtempSync(path.join(projectConfigs,".generic-export-"));
  try{const exported=await exportProject(key,destination,{...testEnv,PROJECT_CONFIG_DIR:projectConfigs});equal(exported.migrationVersion,4);}finally{fs.rmSync(destination,{recursive:true,force:true});}
}
