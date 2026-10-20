// Exercise the documented Node.js Excel uploader against the disposable API.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ExcelJS from "../scripts/excel-batch/node_modules/exceljs/excel.js";
const execute = promisify(execFile);

export async function checkExcelBatch({client, equal, ok, fixtureKey}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),"protocol-excel-http-"));
  try {
    const project = await client.call("/projects","POST",{config_key:fixtureKey("excel")});
    const url = `/projects/${project.id}`;
    const cli = async args => (await execute(process.execPath,["scripts/excel-batch/index.mjs",...args],{
      env:{...process.env,PROTOCOL_SESSION:client.cookie.split("=")[1]},timeout:60000,
    })).stdout;
    const common = ["--url",`http://${process.env.TEST_BIND_ADDR || "127.0.0.1:18081"}`,"--project",String(project.id),"--board","DSP"];
    const populate = async (filename,kind,values) => {
      await cli(["--kind",kind,"--template",filename]);
      const book=new ExcelJS.Workbook();await book.xlsx.readFile(filename);
      const sheet=book.getWorksheet(kind);
      sheet.getRow(1).eachCell((cell,column)=>{if(Object.hasOwn(values,cell.value))sheet.getCell(2,column).value=values[cell.value];});
      await book.xlsx.writeFile(filename);
    };
    const processFile=path.join(temporary,"process.xlsx"), processReport=path.join(temporary,"process-report.json");
    await populate(processFile,"process",{name:"Excel电压",variable_name:"ExcelVoltage",sheet_type:"Sys_F32",element_count:1,unit:"V",min_value:"0.0000",max_value:"1000.0000",default_value:"0.0000",display_digits:4,upload_level:"1：上传至UPM",category:"控制参数设置",enum_table:"0：关闭\n1：开启"});
    ok((await cli([...common,"--kind","process","--file",processFile])).includes("仅完成预览"));
    equal((await client.call(`${url}/topology`)).process_points.length,0);
    ok((await cli([...common,"--kind","process","--file",processFile,"--commit","--report",processReport])).includes("添加成功"));
    const processResult=JSON.parse(await fs.readFile(processReport,"utf8"));
    const point=processResult.record.rows[0].record;
    equal(point.internal_type,"F32");equal(point.byte_length,4);equal(point.group_key,"LOCAL");
    equal(point.enum_name,"EXCEL_VOLTAGE");equal(point.sig_id,null);
    equal(point.min_value,"0.0000");equal(point.max_value,"1000.0000");
    equal(point.metadata.source_variable,"ExcelVoltage");equal(point.metadata.display_digits,4);
    equal(point.metadata.ram,"N");equal(point.metadata.flash,"Y");equal(point.metadata.eeprom,"N");equal(point.metadata.calibration,"Y");
    const sheetTable=await client.call(`${url}/boards/DSP/point-tables/process`);
    equal(sheetTable.rows[0].variable_name,"ExcelVoltage");equal(sheetTable.rows[0].sheet_type,"Sys_F32");
    for(const field of ["cpu","access","ram","flash","eeprom","calibration"])equal(point.metadata[field],sheetTable.definition.fields[field].default);
    equal(point.flags,"0"); // Hidden canonical defaults remain the server's responsibility.
    const references=path.join(temporary,"references.json");
    await cli([...common,"--kind","forward","--references",references]);
    const refs=JSON.parse(await fs.readFile(references,"utf8"));
    equal(refs.board_key,"DSP");equal(refs.options.process_points[0].id,point.id);equal(refs.options.endpoints[0].code,"UPP_SERVICE");
    const forwardFile=path.join(temporary,"forward.xlsx"),forwardReport=path.join(temporary,"forward-report.json");
    await populate(forwardFile,"forward",{process_point_id:point.id,endpoint_key:"UPP_SERVICE",address:6,wire_type:"S32",wire_length:4,scale:0.01,access:"RO",byte_order:0,conversion:"fixed_point"});
    const forwardBook=new ExcelJS.Workbook();await forwardBook.xlsx.readFile(forwardFile);
    for(const removed of ["upp_model","name","enabled","conversion","byte_order","address","wire_length"])ok(!forwardBook.getWorksheet("forward").getRow(1).values.includes(removed));
    ok((await cli([...common,"--kind","forward","--file",forwardFile,"--commit","--report",forwardReport])).includes("添加成功"));
    const result=JSON.parse(await fs.readFile(forwardReport,"utf8"));
    equal(result.record.rows[0].record.upp_model,102);
    equal(result.record.rows[0].record.name,point.name);equal(result.record.rows[0].record.enabled,true);
    equal(result.record.rows[0].record.scale,0.01);equal(result.record.rows[0].record.access,"RO");
    const graph=await client.call(`${url}/topology`);
    equal(graph.process_points.length,1);equal(graph.transmit_points.length,1);
    equal(graph.transmit_points[0].process_point_id,graph.process_points[0].id);
    const automaticFile=path.join(temporary,"forward-automatic.xlsx"),automaticReport=path.join(temporary,"forward-automatic-report.json");
    await populate(automaticFile,"forward",{process_point_id:point.id,endpoint_key:"UPP_SERVICE",address:20});
    await cli([...common,"--kind","forward","--file",automaticFile,"--commit","--report",automaticReport]);
    const automatic=JSON.parse(await fs.readFile(automaticReport,"utf8")).record.rows[0].record;
    equal(automatic.address,10);equal(automatic.upp_model,102);equal(automatic.wire_type,"S32");equal(automatic.wire_length,4);
    equal(automatic.name,point.name);equal(automatic.enabled,true);
    equal(automatic.scale,0.0001);equal(automatic.conversion,"fixed_point");
    equal((await client.call(`${url}/topology`)).transmit_points.length,2);
    equal((await client.call(`${url}/edit-lock`)).locked,false);
    let rejected=false;
    try{await cli([...common,"--kind","process","--file",processFile,"--commit"]);}catch(error){rejected=error.code===1;}
    ok(rejected,"Duplicate Excel points must fail atomically");
    equal((await client.call(`${url}/topology`)).process_points.length,1);
    equal((await client.call(`${url}/edit-lock`)).locked,false);
    console.log("PASS: Node.js DSP sheet Excel preview/commit without sigID, metadata, JSON board references, decimal scale, automatic conversion and duplicate rollback");
  } finally { await fs.rm(temporary,{recursive:true,force:true}); }
}
