import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL(".", import.meta.url));
const definition = async name => JSON.parse(await readFile(new URL(`../config/dc-ups/DSP/${name}.json`, import.meta.url), "utf8"));
const definitions = { process: await definition("process"), forward: await definition("transmit") };
const points = [1, 2, 3].map(id => ({
  id, board_key: "DSP", group_key: "LOCAL", name: `内部数据${id}`, variable_name: `Value${id}`,
  sheet_type: "Sys_U16", internal_type: "U16", element_count: 1, byte_length: 2,
  type_length: 2, category: "系统参数1", display_digits: 0, precision: 1, notes: "", access: "RW",
  recommended_wire_type: "U16", recommended_wire_length: 2, recommended_scale: 1,
}));
const mappings = [1, 2, 3].map(id => ({
  id, board_key: "DSP", process_point_id: id === 3 ? 2 : 1, endpoint_key: "UPP_SERVICE",
  wire_type: "U16", wire_length: 2, address: 6 + 2 * (id - 1), scale: 1, access: "RO", upp_model: 1,
}));
const board = { code: "DSP", name: "DSP 功率板", point_storage: "native", point_rules: {sheet_layout: true},
  point_groups: [{ code: "LOCAL", name: "DSP 内部数据" }], point_endpoints: [{ code: "UPP_SERVICE", name: "UPP 转发", protocol: "UPP" }] };
let revision = 1, lastPreview, conflict = false;
const snapshot = () => {
  const options = { process_points: points, native_groups: board.point_groups, endpoints: board.point_endpoints };
  const table = kind => ({
    revision, board_key: "DSP", kind, storage: "native", definition: definitions[kind], options,
    rows: kind === "process" ? points.map(row => ({ ...row, edit_values: { ...row } }))
      : mappings.map(row => ({ ...row, edit_values: { ...row }, effective_type: row.wire_type, effective_length: row.wire_length, effective_address: row.address })),
  });
  return { revision, process: table("process"), forward: table("forward") };
};
const errors = [], requests = [];
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ baseURL: `http://127.0.0.1:${server.httpServer.address().port}`, viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  let acceptNavigation = true;
  page.on("dialog", dialog => acceptNavigation ? dialog.accept() : dialog.dismiss());
  await page.route("**/__overview_test", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="test"></div><script type="module">
    import { createApp, h, ref } from '/node_modules/.vite/deps/vue.js';
    import Workspace from '/src/pages/TopologyWorkspace.vue';
    import { permissionKey } from '/src/composables/useProjectPermissions.ts';
    import '/src/style.css';
    const writable = ref(true), state = ref({can_edit:true,can_manage_project:true,grants:[],catalog:[]});
    window.setWritable = value => { writable.value = value; };
    window.setInternalOnly = () => { state.value = {can_edit:true,can_manage_project:false,grants:[{board_key:'DSP',scope:'internal'}],catalog:[]}; };
    const app = createApp({render:()=>h(Workspace,{pid:1,boardKey:'DSP',canWrite:writable.value,
      graph:${JSON.stringify({ revision: 1, project_config: { board_types: [board], root: { type: "DSP", quantity: 1 }, mounts: [] }, process_points: points, transmit_points: mappings })}})});
    app.provide(permissionKey,{state,error:ref(''),refresh:async()=>{}});
    app.mount('#test');
  </script></body></html>` }));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path.endsWith("/schema")) return route.fulfill({ json: {
        boards: { DSP: definitions }, workspace: { boards: { DSP: { tables: ["process", "forward"] } } },
      } });
      const kind = path.split("/").at(-1);
      return route.fulfill({ json: kind === "overview" ? snapshot() : snapshot()[kind] });
    }
    const body = request.postDataJSON(); requests.push({ path, body });
    if (path.endsWith("/preview")) {
      lastPreview = body;
      return route.fulfill({ json: { id: 99, allowed: true, errors: [], impact: { count: body.rows?.length || 0, changes: [] } } });
    }
    if (path.endsWith("/commit")) {
      if (conflict) return route.fulfill({ status: 409, json: { error: "相同字段已变化", code: "REVISION_CONFLICT" } });
      for (const row of lastPreview.rows) Object.assign((row.kind === "process" ? points : mappings).find(item => item.id === row.id), row.values);
      revision++;
      return route.fulfill({ json: { revision, merged: false } });
    }
    throw new Error(`Unexpected mutation ${path}`);
  });
  await page.goto("/__overview_test");
  await page.getByRole("tab", { name: "总体视图", exact: true }).click();
  const rows = () => page.locator(".point-overview tbody tr");
  const cell = (key, index = 0) => rows().nth(index).locator(`[data-column-key="${key}"]`);
  await expect(rows()).toHaveCount(4); // two mappings, one mapping, one unmapped point
  for (const key of definitions.forward.presentation.overview_hidden_fields)
    await expect(cell(`forward:${key}`)).toHaveCount(0);
  const leadingColumns = await page.locator(".point-overview th[data-column-key]").evaluateAll(cells => cells.map(cell => cell.dataset.columnKey));
  assert.deepEqual(leadingColumns.slice(0, definitions.process.presentation.overview_leading_fields.length),
    definitions.process.presentation.overview_leading_fields.map(key => `process:${key}`));
  await expect(cell("forward:effective_type", 3)).toHaveText("—");
  await expect(cell("process:name", 0)).toHaveText("内部数据1");
  await expect(cell("process:name", 1)).toHaveText("内部数据1");
  await expect(cell("forward:effective_address")).toHaveAttribute("aria-readonly", "true");
  if (process.env.OVERVIEW_SCREENSHOT) await page.screenshot({ path: process.env.OVERVIEW_SCREENSHOT, fullPage: true });
  await expect(page.getByRole("tab", { name: "总体视图", exact: true })).toHaveAttribute("aria-selected", "true");
  await cell("process:name", 1).dblclick();
  await page.getByLabel("数据名称", { exact: true }).fill("共享内部点");
  await page.getByLabel("数据名称", { exact: true }).press("Tab");
  await expect(cell("process:name", 0)).toHaveText("共享内部点");
  await expect(cell("process:name", 1)).toHaveText("共享内部点");
  await cell("forward:scale", 1).dblclick();
  await page.getByLabel("协议系数", { exact: true }).fill("0.5");
  await page.getByLabel("协议系数", { exact: true }).press("Enter");
  await expect(cell("forward:scale", 0)).toHaveText("1");
  await expect(cell("forward:scale", 1)).toHaveText("0.5");
  await expect(cell("forward:effective_address", 2)).toHaveText("待计算");
  await page.getByRole("button", { name: "检查", exact: true }).click();
  assert.equal(lastPreview.rows.length, 2);
  assert.deepEqual(lastPreview.rows.map(row => [row.kind, row.id, row.values]), [
    ["process", 1, { name: "共享内部点" }], ["forward", 2, { scale: 0.5 }],
  ]);
  assert.equal(lastPreview.rows[0].expected.name, "内部数据1");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  acceptNavigation = false;
  await page.getByRole("tab", { name: /^DSP内部数据/ }).click();
  await expect(page.getByRole("tab", { name: "总体视图", exact: true })).toHaveAttribute("aria-selected", "true");
  acceptNavigation = true;
  await page.getByRole("button", { name: "检查并保存", exact: true }).click();
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(cell("process:name")).toHaveText("共享内部点");
  await expect(page.locator(".point-draft-bar")).toHaveCount(0);
  assert.equal(points[0].name, "共享内部点");
  assert.equal(mappings[1].scale, 0.5);
  await page.getByLabel("转发配置筛选").selectOption("missing");
  await expect(rows()).toHaveCount(1);
  await rows().first().getByRole("button", { name: "添加转发" }).click();
  await expect(page.getByRole("dialog")).toContainText("新建DSP UPP转发表");
  await expect(page.getByLabel("数据名称", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("数据名称", { exact: true })).toBeDisabled();
  await page.locator(".modal-footer").getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("转发配置筛选").selectOption("all");
  await page.getByRole("button", { name: "列设置", exact: true }).click();
  await page.getByLabel("显示 EnumTab", { exact: true }).uncheck();
  await page.getByLabel("冻结 VariateName", { exact: true }).check();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(cell("process:enum_table")).toHaveCount(0);
  await expect(cell("process:variable_name")).toHaveClass(/point-frozen/);
  assert.equal(await rows().first().locator(".overview-actions").evaluate(el => getComputedStyle(el).position), "sticky");
  await cell("process:name").dblclick();
  await page.getByLabel("数据名称", { exact: true }).fill("保留冲突草稿");
  await page.getByLabel("数据名称", { exact: true }).press("Tab");
  conflict = true;
  await page.getByRole("button", { name: "检查并保存", exact: true }).click();
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("草稿已保留");
  await expect(cell("process:name")).toHaveText("保留冲突草稿");
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(cell("process:name")).toHaveText("共享内部点");
  await page.evaluate(() => window.setInternalOnly());
  await expect(cell("process:name")).toHaveAttribute("aria-readonly", "false");
  await expect(cell("forward:scale")).toHaveAttribute("aria-readonly", "true");
  await page.evaluate(() => window.setWritable(false));
  await expect(cell("process:name")).toHaveAttribute("aria-readonly", "true");
  await cell("process:name").dblclick();
  await expect(page.getByLabel("数据名称", { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.equal(requests.filter(request => request.path.endsWith("/commit")).length, 2);
  console.log("PASS: overview joins, shared drafts, mixed save, missing mappings, columns, conflict retention and permissions");
} finally {
  await browser?.close();
  await server.close();
}
