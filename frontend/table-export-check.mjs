import assert from "node:assert/strict";
import {expect} from "@playwright/test";
import {openColumnMenu} from "./point-menus-check.mjs";

export async function downloadView(page,format="json") {
  await page.getByRole("button",{name:"导出当前表格",exact:true}).click();
  const pending=page.waitForEvent("download");
  await page.getByRole("menuitem",{name:format==="json"?"导出 JSON":"导出 Excel (.xlsx)",exact:true}).click();
  const download=await pending;
  const stream=await download.createReadStream(),parts=[];
  for await(const part of stream) parts.push(part);
  assert.equal(await download.failure(),null);
  return {filename:download.suggestedFilename(),bytes:Buffer.concat(parts)};
}
export async function checkExpandedExport(page,requests) {
  await openColumnMenu(page,"wire_type");
  await page.getByRole("menuitem",{name:"隐藏此列",exact:true}).click();
  const file=await downloadView(page);
  const json=JSON.parse(file.bytes);
  assert.equal(json.rows.length,9);
  assert.equal(json.context.expanded,true);
  assert.equal(json.context.endpoint_key,"MODBUS_SERVICE");
  assert.ok(!json.columns.some(column=>column.key==="wire_type"));
  assert.deepEqual(json.columns.map(column=>column.key),await page.locator(".point-table thead th[data-column-key]").evaluateAll(cells=>cells.map(cell=>cell.dataset.columnKey)));
  assert.equal(json.rows.find(row=>row.instance_device==="DSP8").address,57000);
  await page.getByRole("textbox",{name:"搜索当前表格",exact:true}).fill("DSP8");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.route("**/api/projects/1/export-table",async route=>{
    requests.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    await route.fulfill({contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",body:Buffer.from("mock XLSX download")});
  });
  const excel=await downloadView(page,"xlsx");
  assert.ok(excel.filename.endsWith(".xlsx"));
  const payload=requests.at(-1).body;
  assert.equal(payload.rows.length,1);
  assert.equal(payload.rows[0].address,57000);
  assert.equal(payload.context.search,"DSP8");
  await page.getByRole("textbox",{name:"搜索当前表格",exact:true}).clear();
}

export async function checkPagedExport(page,source) {
  const template=source.rows.find(row=>row.group_key==="DSP"&&row.endpoint_key==="MODBUS_SERVICE");
  const data={...source,rows:Array.from({length:5},(_,index)=>({...template,id:100+index,address:index*2,
    edit_values:{...template.edit_values,id:100+index,address:index*2},
    instance_rows:template.instance_rows.map(instance=>({...instance,address:instance.address+index*2}))}))};
  await page.route("**/api/projects/1/boards/UPM/point-tables/forward",route=>route.fulfill({json:data}));
  await page.route("**/__export_pagination",route=>route.fulfill({contentType:"text/html; charset=utf-8",body:`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="test"></div><script type="module">
    import {createApp,h,ref} from '/node_modules/.vite/deps/vue.js';
    import PointTable from '/src/components/PointTable.vue';
    import {permissionKey} from '/src/composables/useProjectPermissions.ts';
    import '/src/style.css';
    const app=createApp({render:()=>h(PointTable,{pid:1,boardKey:'UPM',kind:'forward',label:'转发点表',revision:1,canWrite:false,groupKey:'DSP',endpointKey:'MODBUS_SERVICE'})});
    app.provide(permissionKey,{state:ref({can_edit:false,grants:[],catalog:[]}),error:ref(''),refresh:async()=>{}});app.mount('#test');
    </script></body></html>`}));
  await page.goto("/__export_pagination");
  await page.getByRole("combobox",{name:"每页条数",exact:true}).selectOption("25");
  await expect(page.locator("tbody tr")).toHaveCount(25);
  const json=JSON.parse((await downloadView(page)).bytes);
  assert.equal(json.rows.length,40,"export includes every matching row, beyond the current page");
  assert.equal(new Set(json.rows.map(row=>row.instance_device)).size,8);
}
