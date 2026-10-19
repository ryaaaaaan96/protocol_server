import assert from "node:assert/strict";
import { checkPointColumns } from "./point-columns-check.mjs";
import { checkPointCopy } from "./point-copy-check.mjs";
import { openRowAction } from "./point-menus-check.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL(".", import.meta.url));
const definition = async name => JSON.parse(await readFile(new URL(`../config/dc-ups/DSP/${name}.json`, import.meta.url), "utf8"));
const processDefinition = await definition("process"), forwardDefinition = await definition("transmit");
const points = [
  { id: 1, project_id: 1, board_key: "DSP", group_key: "LOCAL", name: "母线电压", enum_name: "DC_BUS_VOLTAGE", sig_id: 4097, internal_type: "F32", element_count: 1, byte_length: 4, unit: "V", default_value: "0", min_value: "0", max_value: "1000", flags: "0", callback: "NULL", process_enabled: true, boot_restore: false, manual_restore: false, notes: null },
  { id: 2, project_id: 1, board_key: "DSP", group_key: "LOCAL", name: "输出电流", enum_name: "OUTPUT_CURRENT", sig_id: 4098, internal_type: "U16", element_count: 1, byte_length: 2, unit: "A", default_value: "0", min_value: "0", max_value: "100", flags: "0", callback: "NULL", process_enabled: true, boot_restore: false, manual_restore: false, notes: null },
];
const mappings = [3, 4].map((id, index) => ({ id, project_id: 1, board_key: "DSP", process_point_id: 1, endpoint_key: "UPP_SERVICE", name: `电压转发 ${index + 1}`, upp_model: 5 + index, address: 6, wire_type: "S32", wire_length: 4, scale: 0.001, access: "RO", byte_order: 0, conversion: "fixed_point", enabled: true }));
const processRows = points.map(point => ({ ...point, edit_values: { ...point }, data_type: point.internal_type, group_name: "DSP 内部数据", resolved_sig_id: point.sig_id, forward_count: point.id === 1 ? 2 : 0 }));
const forwardRows = mappings.map(mapping => ({ ...mapping, edit_values: { ...mapping }, group_key: "LOCAL", signal_name: points[0].name, enum_name: points[0].enum_name, data_type: "F32", byte_length: 4, resolved_sig_id: 4097, effective_address: mapping.address, effective_type: mapping.wire_type, effective_length: mapping.wire_length }));
const options = { native_groups: [{ code: "LOCAL", name: "DSP 内部数据" }], process_points: processRows, endpoints: [{ code: "UPP_SERVICE", name: "UPP 对外接口", protocol: "UPP" }] };
const tables = {
  process: { revision: 1, board_key: "DSP", kind: "process", storage: "native", definition: processDefinition, rows: processRows, options },
  forward: { revision: 1, board_key: "DSP", kind: "forward", storage: "native", definition: forwardDefinition, rows: forwardRows, options },
};
const graph = {
  revision: 1,
  project_config: { root: { type: "UPM", quantity: 1 }, mounts: [{ parent: "UPM", child: "DSP", quantity: 8, connections: [{ protocol: "UPP", transport: "CAN" }] }], board_types: [
    { code: "UPM", name: "UPM 控制板" },
    { code: "DSP", name: "DSP 功率板", point_storage: "native", point_groups: options.native_groups, point_endpoints: options.endpoints },
  ] },
  process_points: points, transmit_points: mappings,
};
const schema = { boards: { DSP: { process: processDefinition, forward: forwardDefinition } }, workspace: { boards: { DSP: { tables: ["process", "forward"] } } } };
const preview = { id: 99, allowed: true, merged: false, errors: [], impact: { count: 0, changes: [] } };
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ baseURL: `http://127.0.0.1:${address.port}`, viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  await page.addInitScript({ content: `window.__graph = ${JSON.stringify(graph)};` });
  await page.route("**/__native_test", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="test"></div><script type="module">
    import { createApp, h, ref } from '/node_modules/.vite/deps/vue.js';
    import Workspace from '/src/pages/TopologyWorkspace.vue';
    import { permissionKey } from '/src/composables/useProjectPermissions.ts';
    import '/src/style.css';
    const app = createApp({ render: () => h(Workspace, { pid: 1, graph: window.__graph, canWrite: true, boardKey: 'DSP' }) });
    app.provide(permissionKey, { state: ref({ role: 'engineer', can_edit: true, can_manage_project: false, edit_scope: 'scoped', grants: [{ board_key: 'DSP', scope: 'board' }], catalog: [] }), error: ref(''), refresh: async () => {} });
    app.mount('#test');
  </script></body></html>` }));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      requests.push({ path, body: request.postDataJSON() });
      if (path.endsWith("/preview")) return route.fulfill({ json: preview });
      throw new Error(`Unexpected mutation ${path}`);
    }
    if (path.endsWith("/point-tables/schema")) return route.fulfill({ json: schema });
    const kind = path.split("/").at(-1);
    if (tables[kind]) {
      assert.equal(path, `/api/projects/1/boards/DSP/point-tables/${kind}`);
      return route.fulfill({ json: tables[kind] });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  await page.goto("/__native_test");
  const rows = () => page.locator(".point-table tbody tr");
  const cell = (key, index = 0) => rows().nth(index).locator(`[data-column-key="${key}"]`);
  await expect(rows()).toHaveCount(2);
  await expect(page.getByRole("group", { name: "点表分组", exact: true })).toContainText("LOCAL · DSP 内部数据");
  await expect(page.getByRole("tab", { name: /^DSP内部数据/ })).toContainText("2");
  await expect(page.getByRole("button", { name: "选择 DSP 板卡", exact: true })).toContainText("2 个内部点");
  await checkPointColumns(page, { data: tables.process, forward: tables.forward });
  await checkPointCopy(page, tables.process);
  assert.equal(requests.length, 0, "column views and copying never submit data");
  await rows().first().locator(".drag-handle").dragTo(rows().nth(1));
  await expect(rows().first()).toHaveAttribute("data-row-id", "2");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("排序变更预览");
  assert.equal(requests.at(-1).path, "/api/projects/1/boards/DSP/point-tables/process/reorder/preview");
  assert.deepEqual(requests.at(-1).body.ids, [2, 1]);
  assert.deepEqual(requests.at(-1).body.expected, [1, 2]);
  await page.getByRole("button", { name: "返回调整", exact: true }).click();
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  await expect(rows().first()).toHaveAttribute("data-row-id", "1");
  await rows().first().locator(".drag-handle").press("ArrowDown");
  await expect(rows().first()).toHaveAttribute("data-row-id", "2");
  await page.getByRole("button", { name: "取消修改", exact: true }).click();
  await cell("max_value").dblclick();
  await page.getByLabel("编辑 上限", { exact: true }).fill("");
  await page.getByLabel("编辑 上限", { exact: true }).press("Enter");
  await expect(cell("max_value")).toHaveText("—");
  await page.getByRole("button", { name: "检查", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("草稿检查结果");
  assert.equal(requests.at(-1).body.rows[0].values.max_value, null);
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await page.getByRole("button", { name: "新建DSP内部数据", exact: true }).click();
  await page.getByLabel("信号名称", { exact: true }).fill("新增内部点");
  await page.getByLabel("枚举", { exact: true }).fill("NEW_INTERNAL_POINT");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("关联检查通过");
  const processCreate = requests.at(-1).body;
  assert.equal(processCreate.values.group_key, "LOCAL", JSON.stringify(processCreate));
  assert.equal(processCreate.values.element_count, 1);
  assert.ok(!("group_id" in processCreate.values));
  assert.ok(!("data_item_id" in processCreate.values));
  await page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("tab", { name: /^DSP UPP转发表/ }).click();
  await expect(rows()).toHaveCount(2);
  await expect(cell("upp_model")).toHaveText("5");
  await cell("signal_name").dblclick();
  await page.getByLabel("编辑 DSP 内部点", { exact: true }).selectOption("2");
  await expect(cell("enum_name")).toHaveText("OUTPUT_CURRENT");
  await expect(cell("data_type")).toHaveText("U16");
  await cell("scale").dblclick();
  await page.getByLabel("编辑 协议系数", { exact: true }).fill("0.025");
  await page.getByLabel("编辑 协议系数", { exact: true }).press("Enter");
  await cell("byte_order").dblclick();
  await page.getByLabel("编辑 字节序", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "检查", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("草稿检查结果");
  const changed = requests.at(-1).body.rows[0].values;
  assert.equal(changed.process_point_id, 2);
  assert.equal(changed.scale, 0.025);
  assert.equal(changed.byte_order, 2);
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await openRowAction(page, rows().first());
  await page.getByLabel("转发字段名称", { exact: true }).fill("小数协议系数保留");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("关联检查通过");
  assert.equal(requests.at(-1).body.values.name, "小数协议系数保留");
  assert.equal(requests.at(-1).body.expected.scale, 0.001);
  await page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("button", { name: "新建DSP UPP转发表", exact: true }).click();
  await page.getByLabel("DSP 内部点", { exact: true }).selectOption("1");
  await page.getByLabel("转发字段名称", { exact: true }).fill("新增转发");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("关联检查通过");
  const forwardCreate = requests.at(-1).body.values;
  assert.equal(forwardCreate.process_point_id, 1);
  assert.equal(forwardCreate.endpoint_key, "UPP_SERVICE");
  assert.equal(forwardCreate.byte_order, 0);
  for (const key of ["endpoint_id", "context_id", "signal_id", "field_id"]) assert.ok(!(key in forwardCreate), `${key} must not be injected`);
  await page.route("**/__native_import", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="test"></div><script type="module">
    import { createApp, h } from '/node_modules/.vite/deps/vue.js';
    import ImportModal from '/src/components/ImportModal.vue';
    import '/src/style.css';
    createApp({ render: () => h(ImportModal, { pid: 1, canWrite: true }) }).mount('#test');
  </script></body></html>` }));
  await page.route("**/api/projects/1/imports/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) return route.fulfill({ json: {
      id: 98, import_scope: "dsp", filename: "dsp.xlsx", sha256: "a".repeat(64), point_count: 552, dsp_count: 552,
      transmit_count: 445, warnings: [], sample: points.slice(0, 1),
    } });
    assert.equal(route.request().postDataJSON().replace, true);
    return route.fulfill({ json: {} });
  });
  await page.goto("/__native_import");
  await expect(page.locator("dialog")).toContainText("仅更新 DSP 侧点表");
  await page.getByLabel("选择 Excel 文件", { exact: true }).setInputFiles({ name: "dsp.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("mock upload") });
  await expect(page.locator(".import-counts")).toContainText("552");
  await expect(page.locator(".import-counts")).toContainText("445");
  await expect(page.locator(".import-counts")).not.toContainText("平台映射");
  await expect(page.locator("dialog tbody tr")).toContainText("DSP");
  await expect(page.locator("dialog tbody tr")).toContainText("F32");
  await expect(page.locator(".confirm-checkbox")).toContainText("保留项目拓扑、UPM 及其他板卡数据");
  const importButton = page.getByRole("button", { name: "确认导入 552 个测点", exact: true });
  await expect(importButton).toBeDisabled();
  await page.locator(".confirm-checkbox input").check();
  await expect(importButton).toBeEnabled();
  await Promise.all([page.waitForResponse(response => response.url().endsWith("/imports/98/commit")), importButton.click()]);
  assert.deepEqual(errors, []);
  console.log("PASS: native DSP groups/counts, independent point creation, reference edits, fractional scale, byte order preview payloads without legacy relations, and DSP-only import confirmation");
} finally {
  await browser?.close();
  await server.close();
}
