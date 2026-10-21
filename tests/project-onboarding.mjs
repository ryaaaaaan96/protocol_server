// A fresh project made only of example JSON/JS, with no production workbook or scripts.
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";

export function onboardingFixture(directory, key) {
  fs.cpSync(new URL("../examples/minimal-project/", import.meta.url), directory, {recursive:true});
  const file = path.join(directory, "project.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.key = key;
  fs.writeFileSync(file, JSON.stringify(manifest));
}

export async function checkProjectOnboarding({client, equal, ok, fixtureKey, projectConfigs, base}) {
  const key = fixtureKey("onboarding");
  const directory = path.join(projectConfigs, key), upload = new FormData();
  for (const relative of fs.readdirSync(directory, {recursive:true})) {
    const file = path.join(directory, relative);
    if (fs.statSync(file).isFile()) upload.append("files", new Blob([fs.readFileSync(file)]), `${key}/${relative}`);
  }
  const imported = await client.call("/project-folders/preview", "POST", upload);
  equal(imported.key, key);
  equal(imported.existing_project_id, null);
  equal(imported.replace_data, false);
  const installed = await client.call("/project-folders/commit", "POST", {token:imported.token});
  const project = {id:installed.project_id};
  const url = `/projects/${project.id}`, tables = `${url}/boards/SENSOR_NODE/point-tables`;
  const graph = () => client.call(`${url}/topology`);
  const read = kind => client.call(`${tables}/${kind}`);
  const edit = async (kind, values, id = null) => {
    const pending = await client.call(`${tables}/${kind}/preview`, "POST", {
      revision:(await graph()).revision, operation:id === null ? "create" : "update", id, values,
    });
    ok(pending.allowed, JSON.stringify(pending.errors));
    return (await client.call(`${url}/changes/${pending.id}/commit`, "POST", {})).record;
  };
  const initial = await graph();
  equal(initial.process_points.length, 0);
  equal(initial.validation.errors, 0);
  const schema = await client.call(`${url}/point-tables/schema`);
  equal(Object.keys(schema.boards).join(), "SENSOR_NODE");
  equal(schema.boards.SENSOR_NODE.process.fields.gain.label, "校准系数");
  // Omit group and endpoint: defaults must come from this project's own JSON.
  const pressure = await edit("process", {name:"压力", enum_name:"PRESSURE", internal_type:"U16", element_count:1, unit:"Pa", gain:2});
  equal(pressure.group_key, "CHANNELS");
  equal(pressure.metadata.gain, 2);
  equal((await read("process")).rows[0].calibrated_label, "压力 × 2");
  const collect = await edit("collect", {process_point_id:pressure.id, upp_model:7, address:20, wire_type:"U16", wire_length:2, poll_interval:100});
  equal(collect.endpoint_key, "LINK_IN");
  const forward = await edit("forward", {process_point_id:pressure.id, name:"压力输出", wire_type:"U16", scale:1, access:"RO"});
  equal(forward.endpoint_key, "OUTBOUND");
  equal(forward.address, 1000);
  equal(forward.wire_length, 2);
  const temperature = await edit("process", {name:"温度", enum_name:"TEMPERATURE", internal_type:"U32", element_count:1, gain:3});
  const second = await edit("forward", {process_point_id:temperature.id, name:"温度输出", wire_type:"U32", scale:1, access:"RO"});
  equal(second.address, 1001);
  equal(second.wire_length, 4);
  const layoutFile = path.join(projectConfigs, key, "sensor/transmit.js");
  const originalLayout = fs.readFileSync(layoutFile, "utf8");
  const layoutBaseline = await graph();
  try {
    fs.writeFileSync(layoutFile, "export default function calculate(points) { return points.map(p => ({id:p.id,address:1000,wire_length:p.wire_type === 'U32' ? 4 : 2})); }");
    const overlap = await client.call(`${tables}/process/preview`, "POST", {
      revision:layoutBaseline.revision, operation:"update", id:pressure.id, values:{gain:3},
    });
    equal(overlap.allowed, false);
    ok(overlap.errors.some(issue => issue.code === "overlap"), JSON.stringify(overlap.errors));
    equal((await graph()).revision, layoutBaseline.revision);
  } finally { fs.writeFileSync(layoutFile, originalLayout); }
  const before = await graph();
  const denied = await client.call(`${tables}/process/preview`, "POST", {
    revision:before.revision, operation:"update", id:pressure.id, values:{gain:99},
  });
  equal(denied.allowed, false);
  ok(denied.errors.some(issue => issue.code === "gain_range"));
  equal((await graph()).revision, before.revision);
  // A JSON parameter edit reloads without restarting either application.
  const file = path.join(projectConfigs, key, "sensor/process.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const definition = JSON.parse(original);
    definition.behavior.parameters.max_gain = 20;
    fs.writeFileSync(file, JSON.stringify(definition));
    await edit("process", {gain:12}, pressure.id);
    equal((await read("process")).rows.find(row => row.id === pressure.id).calibrated_label, "压力 × 12");
  } finally { fs.writeFileSync(file, original); }
  await edit("process", {gain:4}, pressure.id);
  equal((await read("collect")).rows[0].poll_interval, 100);
  const generated = await client.call(`${url}/generate`);
  equal(generated.blocked, false);
  ok(Object.hasOwn(generated.files, "board_types/SENSOR_NODE/process.json"));
  ok(Object.hasOwn(generated.files, "board_types/SENSOR_NODE/transmit.json"));
  const snapshot = await client.call(`${url}/export`);
  equal(snapshot.process_points.length, 2);
  equal(snapshot.collect_points.length, 1);
  equal(snapshot.transmit_points.length, 2);
  const response = await fetch(`${base}${url}/export.xlsx`, {headers:{Cookie:client.cookie}});
  equal(response.status, 200);
  const require = createRequire(new URL("../scripts/excel-batch/package.json", import.meta.url));
  const ExcelJS = require("exceljs"), workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.worksheets.find(sheet => sheet.getRow(1).values.includes("校准显示"));
  ok(sheet, "Excel follows the independent project's custom columns");
  ok(sheet.getRow(2).values.includes("压力 × 4"));
  equal((await graph()).validation.errors, 0);
  equal((await client.call(`${url}/edit-lock`)).locked, false);
  if (process.argv.includes("--browser")) {
    await checkBrowser({base, cookie:client.cookie, key, equal, read});
  }
  console.log("PASS: standalone JSON/JS project, configured defaults, three editable tables, custom validation, live rules, calculation, generation and JSON/XLSX export");
}

async function checkBrowser({base, cookie, key, equal, read}) {
  const {chromium, expect} = await import("../frontend/node_modules/@playwright/test/index.mjs");
  const browser = await chromium.launch({headless:true});
  try {
    const origin = new URL(base).origin;
    const context = await browser.newContext({baseURL:origin, viewport:{width:1440, height:1000}});
    const separator = cookie.indexOf("=");
    await context.addCookies([{name:cookie.slice(0, separator), value:cookie.slice(separator + 1), url:origin}]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await page.getByLabel("当前项目").selectOption({label:"最小示例项目"});
    await page.getByRole("button", {name:"查看 SENSOR_NODE 板卡内部信息", exact:true}).click();
    await expect(page.locator(".point-table tbody tr")).toHaveCount(2);
    await expect(page.getByRole("columnheader", {name:/校准系数/})).toBeVisible();
    await page.getByRole("button", {name:"开始编辑", exact:true}).click();
    await page.locator('td[data-column-key="gain"]').first().dblclick();
    const editor = page.getByLabel("编辑 校准系数", {exact:true});
    await editor.fill("5");
    await editor.press("Tab");
    await page.getByRole("button", {name:"检查并保存", exact:true}).click();
    await page.getByRole("button", {name:"确认提交", exact:true}).click();
    await expect(page.locator('td[data-column-key="calibrated_label"]').first()).toHaveText("压力 × 5");
    equal((await read("process")).rows[0].gain, 5);
    for (const label of [/^采集点表/, /^转发点表/, /^总体视图/]) {
      await page.getByRole("tab", {name:label}).click();
      await expect(page.locator(".point-table tbody tr").first()).toBeVisible();
    }
    equal(errors.length, 0);
    console.log(`PASS: real browser uses unchanged frontend/backend for ${key}, including custom cell editing`);
  } finally { await browser.close(); }
}
