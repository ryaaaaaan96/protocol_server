// Exercise the documented Node.js Excel uploader against the disposable API.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "../scripts/excel-batch/node_modules/exceljs/excel.js";
const execute = promisify(execFile);

export async function checkExcelBatch({client, equal, ok}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"protocol-excel-http-"));
  try {
    const project = await client.call("/projects","POST",{config_key:"excel"});
    const url = `/projects/${project.id}`;
    const cli = async args => (await execute(process.execPath,["scripts/excel-batch/index.mjs",...args],{
      env:{...process.env,PROTOCOL_SESSION:client.cookie.split("=")[1]},timeout:60000,
    })).stdout;
    const common = ["--url","http://127.0.0.1:18081","--project",String(project.id),"--board","DSP"];
    const populate = async (filename,kind,values) => {
      await cli(["--kind",kind,"--template",filename]);
      const book=new ExcelJS.Workbook();await book.xlsx.readFile(filename);
      const sheet=book.getWorksheet(kind);
      sheet.getRow(1).eachCell((cell,column)=>{if(Object.hasOwn(values,cell.value))sheet.getCell(2,column).value=values[cell.value];});
      await book.xlsx.writeFile(filename);
    };
    const processFile=path.join(temporary,"process.xlsx"), processReport=path.join(temporary,"process-report.json");
    await populate(processFile,"process",{group_key:"LOCAL",name:"Excel电压",enum_name:"EXCEL_VOLTAGE",internal_type:"F32",element_count:1,unit:"V",min_value:"0",max_value:"1000",default_value:"0"});
    ok((await cli([...common,"--kind","process","--file",processFile])).includes("仅完成预览"));
    equal((await client.call(`${url}/topology`)).process_points.length,0);
    ok((await cli([...common,"--kind","process","--file",processFile,"--commit","--report",processReport])).includes("添加成功"));
    const processResult=JSON.parse(await fs.readFile(processReport,"utf8"));
    const point=processResult.record.rows[0].record;
    equal(point.internal_type,"F32");equal(point.byte_length,4);equal(point.group_key,"LOCAL");
    const references=path.join(temporary,"references.json");
    await cli([...common,"--kind","forward","--references",references]);
    const refs=JSON.parse(await fs.readFile(references,"utf8"));
    equal(refs.board_key,"DSP");equal(refs.options.process_points[0].id,point.id);equal(refs.options.endpoints[0].code,"UPP_SERVICE");
    const forwardFile=path.join(temporary,"forward.xlsx"),forwardReport=path.join(temporary,"forward-report.json");
    await populate(forwardFile,"forward",{process_point_id:point.id,endpoint_key:"UPP_SERVICE",name:"Excel转发电压",upp_model:10,address:6,wire_type:"S32",wire_length:4,scale:0.01,access:"RO",byte_order:0,conversion:"fixed_point",enabled:true});
    ok((await cli([...common,"--kind","forward","--file",forwardFile,"--commit","--report",forwardReport])).includes("添加成功"));
    const result=JSON.parse(await fs.readFile(forwardReport,"utf8"));
    equal(result.record.rows[0].record.scale,0.01);equal(result.record.rows[0].record.access,"RO");
    const graph=await client.call(`${url}/topology`);
    equal(graph.process_points.length,1);equal(graph.transmit_points.length,1);
    equal(graph.transmit_points[0].process_point_id,graph.process_points[0].id);
    equal((await client.call(`${url}/edit-lock`)).locked,false);
    let rejected=false;
    try{await cli([...common,"--kind","process","--file",processFile,"--commit"]);}catch(error){rejected=error.code===1;}
    ok(rejected,"Duplicate Excel points must fail atomically");
    equal((await client.call(`${url}/topology`)).process_points.length,1);
    equal((await client.call(`${url}/edit-lock`)).locked,false);
    console.log("PASS: Node.js Excel preview/commit, JSON board references, decimal scale, explicit conversion and duplicate rollback");
  } finally { await fs.rm(temporary,{recursive:true,force:true}); }
}
