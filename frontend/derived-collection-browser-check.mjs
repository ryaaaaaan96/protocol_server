import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";
const root=fileURLToPath(new URL(".",import.meta.url));
const manifest=JSON.parse(await readFile(new URL("../config/dc-ups/project.json",import.meta.url),"utf8"));
const board=manifest.topology.board_types.find(b=>b.code==="UPM_DEMO");
const definition=JSON.parse(await readFile(new URL("../config/dc-ups/upm-demo/collect.json",import.meta.url),"utf8"));
const records=[{id:1,board_key:"UPM_DEMO",group_key:"LOCAL",endpoint_key:"UPM_MODBUS",signal_name:"本地电压",source_device_code:"LOCAL",address:31000,dev_id:1,wire_type:"U16",wire_length:2,register_count:1,register_type:"INPUT",poll_interval:1000,can_edit:false,edit_values:{}},
{id:2,board_key:"UPM_DEMO",group_key:"LOCAL",endpoint_key:"UPM_MODBUS",signal_name:"DSP电压",source_device_code:"DSP8",address:57006,dev_id:1,wire_type:"U32",wire_length:4,register_count:2,register_type:"HOLDING",poll_interval:1000,can_edit:false,edit_values:{}}];
const data={revision:1,board_key:"UPM_DEMO",kind:"collect",derived:true,storage:"derived",definition,rows:records,options:{native_groups:board.point_groups,endpoints:board.point_endpoints,process_points:[]}};
const graph={revision:1,project_config:manifest.topology,process_points:[],collect_points:[],transmit_points:[],derived_counts:{UPM_DEMO:records.length}};
const server=await createServer({root,logLevel:"error",server:{host:"127.0.0.1",port:0}});
let browser;const errors=[];
try {
 await server.listen();browser=await chromium.launch({headless:true});
 const page=await browser.newPage({baseURL:`http://127.0.0.1:${server.httpServer.address().port}`,viewport:{width:1600,height:1000}});
 page.on("pageerror",e=>errors.push(e.message));
 await page.route("**/__derived",route=>route.fulfill({contentType:"text/html; charset=utf-8",body:`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module">
 import {createApp,h,ref} from '/node_modules/.vite/deps/vue.js';import Workspace from '/src/pages/TopologyWorkspace.vue';import {permissionKey} from '/src/composables/useProjectPermissions.ts';import '/src/style.css';
 const app=createApp({render:()=>h(Workspace,{pid:1,boardKey:'UPM_DEMO',canWrite:true,graph:${JSON.stringify(graph)}})});app.provide(permissionKey,{state:ref({can_edit:true,can_manage_project:true,grants:[],catalog:[]}),error:ref(''),refresh:async()=>{}});app.mount('#app');</script></body></html>`}));
 await page.route("**/api/**",route=>{
  assert.equal(route.request().method(),"GET");
  return route.fulfill({json:route.request().url().endsWith("/schema")?{boards:{UPM_DEMO:{collect:definition}},workspace:{boards:{UPM_DEMO:{tables:["collect"]}}}}:data});
 });
 await page.goto("/__derived");
 await expect(page.getByRole("tab")).toHaveCount(1);
 await expect(page.getByRole("tab",{name:/采集点表/})).toContainText("2");
 await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly","true");
 await expect(page.locator("tbody tr")).toHaveCount(2);
 await expect(page.getByRole("button",{name:/新建|编辑单元格|检查并保存/})).toHaveCount(0);
 const cell=page.locator('tbody tr').nth(1).locator('[data-column-key="address"]');
 await cell.dblclick();await expect(page.locator(".point-cell-editor")).toHaveCount(0);
 await page.locator('tbody tr').nth(1).getByRole("button").first().click();
 await expect(page.getByRole("menuitem",{name:"关联处理点",exact:true})).toHaveCount(0);
 await expect(page.getByRole("menuitem",{name:"记录详情",exact:true})).toHaveCount(0);
 await page.keyboard.press("Escape");
 await page.getByLabel("搜索当前表格",{exact:true}).fill("DSP8");
 await expect(page.locator("tbody tr")).toHaveCount(1);
 await expect(page.locator("tbody")).toContainText("57006");
 assert.deepEqual(errors,[]);
 console.log("PASS: upm-demo single readonly collection sheet, instance addresses, counts, search and protected cells");
}finally{await browser?.close();await server.close();}
