import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(new URL("../scripts/excel-batch/package.json",import.meta.url));
const ExcelJS=require("exceljs");

export async function checkPointExport({client,viewer,viewerId,engineer,equal,ok,fixtureKey,base}) {
  const project=await client.call("/projects","POST",{config_key:fixtureKey("upm_address")});
  const url=`/projects/${project.id}`;
  const edit=async(kind,values)=>{
    const graph=await client.call(`${url}/topology?workspace=true`);
    const preview=await client.call(`${url}/boards/UPM/point-tables/${kind}/preview`,"POST",{revision:graph.revision,operation:"create",values});
    ok(preview.allowed,JSON.stringify(preview.errors));
    return (await client.call(`${url}/changes/${preview.id}/commit`,"POST",{})).record;
  };
  const point=await edit("process",{group_key:"DSP",name:"=1+1",enum_name:"EXPORT_VALUE",sig_id:12,internal_type:"U16",element_count:1});
  await edit("forward",{process_point_id:point.id,endpoint_key:"MODBUS_SERVICE",address:6,wire_type:"U16",wire_length:2,register_type:"HOLDING",scale:1,access:"RO"});
  const before=await client.call(`${url}/topology`);
  const file=async(who,path,body)=>{
    const response=await fetch(`${base}${url}${path}`,{method:body?"POST":"GET",headers:{Cookie:who.cookie,"X-Requested-With":"protocol-studio",...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,type:response.headers.get("content-type"),name:response.headers.get("content-disposition"),bytes:Buffer.from(await response.arrayBuffer())};
  };
  equal((await file(viewer,"/export.xlsx")).status,403);
  equal((await file(engineer,"/export")).status,403);
  await client.call(`${url}/members`,"PUT",{user_id:viewerId,role:"viewer"});
  const exported=await file(viewer,"/export");equal(exported.status,200);
  const snapshot=JSON.parse(exported.bytes.toString());
  equal(snapshot.revision,before.revision);
  equal(snapshot.process_points.length,before.process_points.length);
  equal(snapshot.transmit_points.length,before.transmit_points.length);
  equal(snapshot.process_points.find(row=>row.id===point.id).name,"=1+1");
  const excel=await file(viewer,"/export.xlsx");equal(excel.status,200);ok(excel.name.endsWith(".xlsx"));ok(excel.type.includes("spreadsheetml.sheet"));
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(excel.bytes);
  const sheet=workbook.worksheets.find(sheet=>sheet.name.startsWith("UPM-DSP-转发点表")&&sheet.getRow(1).values.includes("设备实例"));
  ok(sheet,"project workbook includes expanded forwarding table");
  equal(sheet.rowCount,9);
  const headers=sheet.getRow(1).values;
  const address=headers.indexOf("协议地址 / 偏移"),device=headers.indexOf("设备实例"),name=headers.indexOf("内部点");
  equal(sheet.getCell(2,address).value,50006);
  equal(sheet.getCell(9,address).value,57006);
  equal(sheet.getCell(9,device).value,"DSP8");
  equal(sheet.getCell(2,name).value,"=1+1");
  const current={title:"当前/表格",columns:[{key:"name",label:"名称"},{key:"address",label:"地址"}],rows:[{name:"=1+1",address:57006}],context:{revision:before.revision}};
  const view=await file(viewer,"/export-table",current);equal(view.status,200);
  const viewBook=new ExcelJS.Workbook();await viewBook.xlsx.load(view.bytes);
  equal(viewBook.worksheets[0].getCell(2,1).value,"=1+1");
  equal(viewBook.worksheets[0].getCell(2,2).value,57006);
  equal((await file(engineer,"/export-table",current)).status,403);
  equal((await file(viewer,"/export-table",{...current,rows:[{name:{nested:true}}]})).status,400);
  equal(JSON.stringify((await client.call(`${url}/topology`)).process_points),JSON.stringify(before.process_points));
  equal((await client.call(`${url}/topology?workspace=true`)).revision,before.revision);
  assert.equal((await client.call(`${url}/edit-lock`)).locked,false,"exports do not acquire an editing lease");
  console.log("PASS: project JSON/XLSX snapshot, expanded protocol addresses, readonly exports, literal formula text, validation and project isolation");
}
