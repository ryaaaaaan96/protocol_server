import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const root=fileURLToPath(new URL(".",import.meta.url));
const manifest=JSON.parse(await readFile(new URL("../config/dc-ups/project.json",import.meta.url),"utf8"));
const board=manifest.topology.board_types.find(b=>b.code==="UPM");
const definitions={};
for(const [kind,file] of [["process","process"],["collect","collect"],["forward","transmit"]])
  definitions[kind]=JSON.parse(await readFile(new URL(`../config/dc-ups/UPM/${file}.json`,import.meta.url),"utf8"));
const script=await readFile(new URL("../config/dc-ups/UPM/transmit.js",import.meta.url),"utf8");
const {behavior}=await import(`data:text/javascript;base64,${Buffer.from(script).toString("base64")}`);
const collectScript=await readFile(new URL("../config/dc-ups/UPM/collect.js",import.meta.url),"utf8");
const {behavior:collectBehavior}=await import(`data:text/javascript;base64,${Buffer.from(collectScript).toString("base64")}`);
const points=[
  {id:1,board_key:"UPM",group_key:"LOCAL",name:"本地电压",enum_name:"LOCAL_VOLTAGE",sig_id:101,internal_type:"U16",element_count:1,byte_length:2},
  {id:2,board_key:"UPM",group_key:"DSP",name:"DSP 电压",enum_name:"DSP_VOLTAGE",sig_id:201,internal_type:"U16",element_count:1,byte_length:2},
  {id:3,board_key:"UPM",group_key:"DSP",name:"未转发测点",enum_name:"DSP_UNMAPPED",sig_id:202,internal_type:"U16",element_count:1,byte_length:2},
  {id:4,board_key:"UPM",group_key:"LOCAL",name:"暂不上传测点",enum_name:"LOCAL_RESERVED",sig_id:null,metadata:{source_sig_id:"※"},internal_type:"U16",element_count:1,byte_length:2},
];
const collect=[{id:1,board_key:"UPM",process_point_id:2,endpoint_key:"DSP_UPP",upp_model:99,address:6,
  wire_type:"U16",wire_length:2,scale:0.1,access:"RO",byte_order:0,acquisition_mode:"poll",poll_interval:3,set_priority:0,scan_priority:0}];
const forward=[
  {id:1,board_key:"UPM",process_point_id:1,endpoint_key:"MODBUS_SERVICE",address:31000,wire_type:"U16",wire_length:2,register_type:"INPUT",register_count:1,scale:0.1,access:"RO"},
  {id:2,board_key:"UPM",process_point_id:1,endpoint_key:"UPP_SERVICE",upp_model:131,address:6,wire_type:"U16",wire_length:2,scale:0.1,access:"RO"},
  {id:3,board_key:"UPM",process_point_id:2,endpoint_key:"MODBUS_SERVICE",address:0,wire_type:"U16",wire_length:2,register_type:"HOLDING",register_count:1,device_addresses:"DSP1: 50000；DSP8: 57000",scale:0.1,access:"RO"},
];
const data=kind=>({
  revision:1,board_key:"UPM",kind,storage:"native",definition:definitions[kind],
  options:{native_groups:board.point_groups,process_points:points,
    endpoints:board.point_endpoints.filter(e=>kind==="collect"?e.direction==="collect":e.direction!=="collect")},
  rows:(kind==="process"?points:kind==="collect"?collect:forward).map(row=>{
    const p=kind==="process"?row:points.find(p=>p.id===row.process_point_id);
    const result={...row,group_key:p.group_key,signal_name:p.name,enum_name:p.enum_name,
      endpoint_name:board.point_endpoints.find(e=>e.code===row.endpoint_key)?.name,edit_values:{...row}};
    if(kind==="forward") {
      const protocol=board.point_endpoints.find(e=>e.code===row.endpoint_key)?.protocol;
      const devices=board.point_groups.find(g=>g.code===p.group_key).devices;
      const addresses=behavior({action:"instances",rows:[{id:row.id,group_key:p.group_key,protocol,base_address:row.address,devices}]},definitions.forward.behavior.parameters);
      result.device_instances=devices.map(device=>({...device,address:addresses.find(item=>item.device_code===device.code).address}));
      Object.assign(result,behavior({action:"project",rows:[result],sources:points}).at(0).values);
    }
    if(kind==="collect") {
      const sources=points.map(point=>({...point,transmissions:forward.filter(mapping=>mapping.process_point_id===point.id).map(mapping=>({...mapping,protocol:board.point_endpoints.find(e=>e.code===mapping.endpoint_key).protocol}))}));
      Object.assign(result,collectBehavior({action:"project",rows:[result],sources}).at(0).values);
      result.edit_values.base_address=result.base_address;
    }
    return result;
  }),
});
const errors=[],requests=[];
const server=await createServer({root,logLevel:"error",server:{host:"127.0.0.1",port:0}});
let browser;
try {
  await server.listen();browser=await chromium.launch({headless:true});
  const page=await browser.newPage({baseURL:`http://127.0.0.1:${server.httpServer.address().port}`,viewport:{width:1600,height:1000}});
  page.on("pageerror",e=>errors.push(e.message));
  page.on("dialog",d=>d.accept());
  await page.route("**/__upm_test",route=>route.fulfill({contentType:"text/html; charset=utf-8",body:`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="test"></div><script type="module">
    import { createApp,h,ref } from '/node_modules/.vite/deps/vue.js';
    import Workspace from '/src/pages/TopologyWorkspace.vue';
    import { permissionKey } from '/src/composables/useProjectPermissions.ts';
    import '/src/style.css';
    const app=createApp({render:()=>h(Workspace,{pid:1,boardKey:'UPM',canWrite:true,
      graph:${JSON.stringify({revision:1,project_config:manifest.topology,process_points:points,collect_points:collect,transmit_points:forward})}})});
    app.provide(permissionKey,{state:ref({can_edit:true,can_manage_project:true,grants:[],catalog:[]}),error:ref(''),refresh:async()=>{}});
    app.mount('#test');
  </script></body></html>`}));
  await page.route("**/api/**",route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==="GET") return route.fulfill({json:url.pathname.endsWith("/schema")
      ?{boards:{UPM:definitions},workspace:{boards:{UPM:{tables:["process","collect","transmit"]}}}}
      :url.pathname.endsWith("/overview")?{revision:1,process:data("process"),forward:data("forward")}
      :data(url.pathname.split("/").at(-1))});
    requests.push({path:url.pathname,body:req.postDataJSON()});
    return route.fulfill({json:{id:1,allowed:true,errors:[],impact:{count:1,changes:[]}}});
  });
  await page.goto("/__upm_test");
  const tabCount=(label)=>page.getByRole("tab",{name:label}).locator("small");
  await expect(tabCount(/处理点表/)).toHaveText("1");
  await expect(tabCount(/转发点表 · MODBUS/)).toHaveText("1");
  await expect(tabCount(/转发点表 · UPP/)).toHaveText("1");
  await expect(page.getByRole("tab",{name:/处理点表/})).toHaveAttribute("aria-selected","true");
  await expect(page.getByRole("tab",{name:/采集点表/})).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("显示未分配 sigID 的点",{exact:true}).check();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  const reservedSigID=page.locator('tbody tr').nth(1).locator('[data-column-key="sig_id"]');
  await expect(reservedSigID).toHaveText("※（不上传 UPP）");
  await reservedSigID.dblclick();
  await page.getByLabel("编辑 sigID",{exact:true}).fill("303");
  await page.getByLabel("编辑 sigID",{exact:true}).press("Tab");
  await expect(reservedSigID).toHaveText("303");
  await expect(page.getByLabel("显示未分配 sigID 的点",{exact:true})).toBeDisabled();
  await page.getByRole("tab",{name:"总体视图",exact:true}).click();
  await expect(page.getByRole("grid",{name:"UPM 总体视图",exact:true})).toBeVisible();
  const overviewRows=()=>page.locator(".point-overview tbody tr");
  const overviewCell=(key,index=0)=>overviewRows().nth(index).locator(`[data-column-key="${key}"]`);
  await expect(overviewRows()).toHaveCount(2); // One LOCAL point, two independent endpoints.
  await page.getByLabel("显示未分配 sigID 的点",{exact:true}).check();
  await expect(overviewRows()).toHaveCount(3);
  await expect(overviewCell("process:sig_id",2)).toHaveText("※（不上传 UPP）");
  await page.getByLabel("显示未分配 sigID 的点",{exact:true}).uncheck();
  await expect(overviewRows()).toHaveCount(2);
  await expect(overviewCell("forward:endpoint_name",0)).toHaveText("Modbus 对外表");
  await expect(overviewCell("forward:endpoint_name",1)).toHaveText("CSU-UPM UPP 对外表");
  await expect(page.locator('[data-column-key="forward:device_addresses"]')).toHaveCount(0);
  await expect(overviewCell("forward:upp_model",0)).toHaveAttribute("aria-readonly","true");
  await expect(overviewCell("forward:register_type",1)).toHaveAttribute("aria-readonly","true");
  await overviewCell("process:name").dblclick();
  await page.getByLabel("数据定义",{exact:true}).fill("共享处理点");
  await page.getByLabel("数据定义",{exact:true}).press("Tab");
  await expect(overviewCell("process:name",1)).toHaveText("共享处理点");
  await overviewCell("forward:scale",1).dblclick();
  await page.getByLabel("精度",{exact:true}).fill("0.5");
  await page.getByLabel("精度",{exact:true}).press("Enter");
  await expect(overviewCell("forward:scale",0)).toHaveText("0.1");
  await expect(overviewCell("forward:scale",1)).toHaveText("0.5");
  await page.getByRole("button",{name:"检查",exact:true}).click();
  assert.ok(requests.at(-1).path.endsWith("/overview/batch/preview"));
  assert.deepEqual(requests.at(-1).body.rows.map(({kind,id,values})=>({kind,id,values})),[
    {kind:"process",id:1,values:{name:"共享处理点"}},
    {kind:"forward",id:2,values:{scale:0.5}},
  ]);
  await page.getByRole("button",{name:"继续编辑",exact:true}).click();
  await page.getByRole("tab",{name:/转发点表 · MODBUS/}).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("button",{name:"按设备展开",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(page.locator('tbody [data-column-key="instance_device"]')).toHaveText("LOCAL");
  await expect(page.locator('tbody [data-column-key="address"]')).toHaveText("31000");
  await expect(page.locator('tbody [data-column-key="address"]')).toHaveAttribute("aria-readonly","true");
  await expect(page.getByRole("columnheader",{name:/Modbus 寄存器区/})).toBeVisible();
  await expect(page.locator('[data-column-key="device_addresses"]')).toHaveCount(0);
  await expect(page.getByRole("columnheader",{name:/UPP 模型号/})).toHaveCount(0);
  await page.getByRole("tab",{name:/转发点表 · UPP/}).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("columnheader",{name:/UPP 模型号/})).toBeVisible();
  await expect(page.locator('[data-column-key="device_addresses"]')).toHaveCount(0);
  await expect(page.getByRole("columnheader",{name:/Modbus 寄存器区/})).toHaveCount(0);
  await page.getByRole("button",{name:"DSP · DSP 设备共享模板",exact:true}).click();
  await expect(tabCount(/处理点表/)).toHaveText("2");
  await expect(tabCount(/采集点表/)).toHaveText("1");
  await expect(tabCount(/转发点表 · MODBUS/)).toHaveText("8");
  await expect(tabCount(/转发点表 · UPP/)).toHaveText("0");
  await page.getByRole("tab",{name:"总体视图",exact:true}).click();
  await expect(overviewRows()).toHaveCount(2);
  await expect(overviewCell("process:name",1)).toHaveText("未转发测点");
  await expect(overviewCell("forward:scale",1)).toHaveText("—");
  await page.getByRole("tab",{name:/采集点表/}).click();
  await expect(page.locator('[data-column-key="device_addresses"]')).toHaveCount(0);
  await expect(page.locator(".notice").filter({hasText:"转发表的子集"})).toContainText("DSP / UPP_SERVICE");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator('tbody [data-column-key="base_address"]')).toHaveText("0");
  await page.locator('tbody [data-column-key="base_address"]').dblclick();
  await page.getByLabel("编辑 Base 地址",{exact:true}).fill("12");
  await page.getByLabel("编辑 Base 地址",{exact:true}).press("Enter");
  await expect(page.locator('tbody [data-column-key="address"]')).toHaveText("6");
  await page.locator('tbody [data-column-key="poll_interval"]').dblclick();
  await page.getByLabel("编辑 UPP 轮询间隔",{exact:true}).fill("8");
  await page.getByLabel("编辑 UPP 轮询间隔",{exact:true}).press("Enter");
  await page.getByRole("button",{name:"检查",exact:true}).click();
  assert.ok(requests.at(-1).path.endsWith("/collect/batch/preview"));
  assert.equal(requests.at(-1).body.rows[0].values.poll_interval,8);
  assert.equal(requests.at(-1).body.rows[0].values.base_address,12);
  await page.getByRole("button",{name:"继续编辑",exact:true}).click();
  await page.getByRole("tab",{name:/转发点表 · MODBUS/}).click();
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await expect(page.locator(".pagination-summary")).toContainText("共 8 条");
  await expect(page.locator('tbody [data-column-key="instance_device"]')).toHaveText(["DSP1","DSP2","DSP3","DSP4","DSP5","DSP6","DSP7","DSP8"]);
  await expect(page.locator('tbody [data-column-key="address"]')).toHaveText(["50000","51000","52000","53000","54000","55000","56000","57000"]);
  await expect(page.locator('[data-column-key="device_addresses"]')).toHaveCount(0);
  await expect(page.locator("tbody")).not.toContainText("DSP1: 50000；DSP8: 57000");
  const beforeReadOnly=requests.length;
  await page.locator('tbody [data-column-key="address"]').last().dblclick();
  await expect(page.getByLabel("编辑 协议地址 / 偏移",{exact:true})).toHaveCount(0);
  assert.equal(requests.length,beforeReadOnly);
  await page.getByRole("textbox",{name:"搜索当前表格",exact:true}).fill("DSP8");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(tabCount(/转发点表 · MODBUS/)).toHaveText("8");
  await expect(page.locator(".pagination-summary")).toContainText("共 1 条");
  await expect(page.locator('tbody [data-column-key="address"]')).toHaveText("57000");
  await page.getByRole("textbox",{name:"搜索当前表格",exact:true}).fill("");
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await page.locator("tbody tr").last().getByRole("button",{name:/记录操作/}).click();
  await page.getByRole("menuitem",{name:"共享模板详情",exact:true}).click();
  await expect(page.locator("dialog")).toContainText("编辑转发点表");
  await page.locator("dialog").getByRole("button",{name:"关闭",exact:true}).last().click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator('tbody [data-column-key="address"]')).toHaveText("0");
  await page.locator('tbody [data-column-key="address"]').dblclick();
  await page.getByLabel("编辑 协议地址 / 偏移",{exact:true}).fill("6");
  await page.getByLabel("编辑 协议地址 / 偏移",{exact:true}).press("Enter");
  await expect(page.getByRole("button",{name:"按设备展开",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"检查",exact:true}).click();
  assert.ok(requests.at(-1).path.endsWith("/forward/batch/preview"));
  assert.equal(requests.at(-1).body.rows[0].id,3);
  assert.deepEqual(requests.at(-1).body.rows[0].values,{address:6});
  await page.getByRole("button",{name:"继续编辑",exact:true}).click();
  await page.getByRole("button",{name:"放弃修改",exact:true}).click();
  await page.getByRole("button",{name:"按设备展开",exact:true}).click();
  await expect(page.locator("tbody tr")).toHaveCount(8);
  await page.getByRole("button",{name:"全部分组",exact:true}).click();
  await expect(tabCount(/处理点表/)).toHaveText("3");
  await expect(tabCount(/采集点表/)).toHaveText("1");
  await expect(tabCount(/转发点表 · MODBUS/)).toHaveText("9");
  await expect(tabCount(/转发点表 · UPP/)).toHaveText("1");
  await expect(page.locator("tbody tr")).toHaveCount(9);
  await expect(page.locator(".pagination-summary")).toContainText("共 9 条");
  // The generic view never mutates storage IDs, associations or source data.
  const expansionChecks=await page.evaluate(async source=>{
    const {expandedPointTable}=await import('/src/domain/pointExpansion.ts');
    const original=JSON.stringify(source),expanded=expandedPointTable(source);
    const invalid=structuredClone(source);
    invalid.rows[0].instance_rows[0].process_point_id=999;
    let rejected=false;
    try {expandedPointTable(invalid);} catch {rejected=true;}
    return {unchanged:JSON.stringify(source)===original,rejected,
      ids:new Set(expanded.rows.map(row=>row.id)).size,count:expanded.rows.length,
      editors:expanded.definition.editor,templates:[...new Set(expanded.rows.map(row=>row.template_id))]};
  },data("forward"));
  assert.deepEqual(expansionChecks,{unchanged:true,rejected:true,ids:10,count:10,editors:[],templates:[3,1,2]});
  await page.route("**/__upm_import",route=>route.fulfill({contentType:"text/html; charset=utf-8",body:`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="test"></div><script type="module">
    import {createApp,h} from '/node_modules/.vite/deps/vue.js';
    import ImportModal from '/src/components/ImportModal.vue';
    createApp({render:()=>h(ImportModal,{pid:1,canWrite:true,boards:[{code:"UPM",name:"UPM 控制板"}]})}).mount('#test');
  </script></body></html>`}));
  await page.route("**/api/projects/1/imports/**",route=>{
    assert.equal(new URL(route.request().url()).searchParams.get("board"),"UPM");
    return route.fulfill({json:{id:2,board_key:"UPM",board_name:"UPM 控制板",group_counts:[{name:"LOCAL",count:161},{name:"DSP",count:445}],import_scope:"upm",filename:"upm.xlsx",sha256:"a".repeat(64),
      point_count:606,local_count:161,dsp_count:445,collect_count:445,transmit_count:560,warnings:[],sample:points}});
  });
  await page.goto("/__upm_import");
  await page.getByLabel("导入板卡",{exact:true}).selectOption("UPM");
  await page.getByLabel("选择 Excel 文件",{exact:true}).setInputFiles({name:"upm.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:Buffer.from("mock")});
  await expect(page.locator(".import-counts")).toContainText("161");
  await expect(page.locator(".confirm-checkbox")).toContainText("确认替换 UPM 控制板 板卡的点表");
  await expect(page.locator(".confirm-checkbox")).toContainText("保留项目拓扑和其他板卡数据");
  assert.deepEqual(errors,[]);
  console.log("PASS: UPM collection editing, hidden device addresses, JSON/JS device expansion and shared template editing");
} finally { await browser?.close();await server.close(); }
