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
for (const [index, point] of points.entries()) Object.assign(point, {
  variable_name: index ? "OutputCurrent" : "DcBusVoltage", sheet_type: `Sys_${point.internal_type}`,
  enum_table: index ? "" : "bit0:有效\nbit1:故障", display_digits: 0, type_length: point.byte_length,
  access: "RO", ram: "N", flash: "Y", eeprom: "N", calibration: "Y", structure: "PARAM_MONITOR_DATA_STR",
  cpu: "CPU2", precision: 1, sheet_data_type: index ? "U16" : "S32", upload_level: "2：UPM进行轮询",
  category: index ? "任务级观测量" : "系统参数1", sheet_upp_model: index ? 99 : 1,
  recommended_wire_type: index ? "U16" : "S32", recommended_wire_length: point.byte_length,
  recommended_scale: index ? 1 : 0.001, recommended_conversion: index ? "identity" : "fixed_point",
});
const mappings = [3, 4, 5].map((id, index) => ({ id, project_id: 1, board_key: "DSP", process_point_id: index === 2 ? 2 : 1, endpoint_key: "UPP_SERVICE", name: `电压转发 ${index + 1}`, upp_model: index === 2 ? 99 : 1, address: 6 + index * 4, wire_type: "S32", wire_length: 4, scale: 0.001, access: "RO", byte_order: 0, conversion: "fixed_point", enabled: true }));
const processRows = points.map(point => ({ ...point, edit_values: { ...point }, data_type: point.internal_type, group_name: "DSP 内部数据", resolved_sig_id: point.sig_id, forward_count: point.id === 1 ? 2 : 0 }));
const forwardRows = mappings.map(mapping => {
  const source = points.find(point => point.id === mapping.process_point_id);
  return { ...mapping, edit_values: { ...mapping }, group_key: "LOCAL", signal_name: source.name, variable_name: source.variable_name, sheet_type: source.sheet_type, category: source.category,
    recommended_wire_type: source.recommended_wire_type, recommended_wire_length: source.recommended_wire_length, recommended_scale: source.recommended_scale, recommended_conversion: source.recommended_conversion,
    enum_name: source.enum_name, data_type: source.internal_type, byte_length: source.byte_length, resolved_sig_id: source.sig_id, effective_address: mapping.address, effective_type: mapping.wire_type, effective_length: mapping.wire_length };
});
const options = { native_groups: [{ code: "LOCAL", name: "DSP 内部数据" }], process_points: processRows, endpoints: [{ code: "UPP_SERVICE", name: "UPP 对外接口", protocol: "UPP" }] };
const tables = {
  process: { revision: 1, board_key: "DSP", kind: "process", storage: "native", definition: processDefinition, rows: processRows, options },
  forward: { revision: 1, board_key: "DSP", kind: "forward", storage: "native", definition: forwardDefinition, rows: forwardRows, options },
};
const graph = {
  revision: 1,
  project_config: { root: { type: "UPM", quantity: 1 }, mounts: [{ parent: "UPM", child: "DSP", quantity: 8, connections: [{ protocol: "UPP", transport: "CAN" }] }], board_types: [
    { code: "UPM", name: "UPM 控制板" },
    { code: "DSP", name: "DSP 功率板", point_storage: "native", point_rules: {sheet_layout: true}, point_groups: options.native_groups, point_endpoints: options.endpoints },
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
      if (path.endsWith("/preview")) {
        const payload = request.postDataJSON(), values = payload.rows?.[0]?.values || payload.values || {};
        if (values.wire_type === "F32") {
          const id = payload.rows?.[0]?.id ?? payload.id;
          const mapping = { ...mappings.find(item => item.id === id), ...values };
          const valid = mapping.scale === 1;
          return route.fulfill({ json: valid
            ? { ...preview, warnings: [{ name: "母线电压", message: "当前 F32 偏离建议 S32，请确认接收端协议。" }] }
            : { ...preview, allowed: false, errors: [{ message: "F32 直接映射需要 4 字节和系数 1。" }] } });
        }
        if (values.ram === "Y") {
          const before = { id: 1, board_key: "DSP", name: "母线电压", enum_name: "DC_BUS_VOLTAGE", internal_type: "F32", metadata: { source_variable: "DcBusVoltage", ram: "N", cpu: "CPU2", enum_table: "bit0:有效\nbit1:故障" } };
          const after = { ...before, internal_type: values.sheet_type?.replace("Sys_", "") || before.internal_type, metadata: { ...before.metadata, ram: "Y", ...(values.enum_table !== undefined ? { enum_table: values.enum_table } : {}) } };
          return route.fulfill({ json: { ...preview, impact: { count: 1, changes: [{ entity: "process_points", key: 1, before, after }] } } });
        }
        return route.fulfill({ json: preview });
      }
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
  await page.addInitScript(() => localStorage.setItem("point-columns:1:DSP:process", JSON.stringify([
    { key: "enum_name", visible: true, frozen: true }, { key: "name", visible: false, frozen: false },
  ])));
  await page.goto("/__native_test");
  const rows = () => page.locator(".point-table tbody tr");
  const cell = (key, index = 0) => rows().nth(index).locator(`[data-column-key="${key}"]`);
  await expect(rows()).toHaveCount(2);
  await expect(page.getByRole("group", { name: "点表分组", exact: true })).toContainText("LOCAL · DSP 内部数据");
  await expect(page.getByRole("tab", { name: /^DSP内部数据/ })).toContainText("2");
  await expect(page.getByRole("button", { name: "选择 DSP 板卡", exact: true })).toContainText("2 个内部点");
  await expect(cell("variable_name")).toHaveText("DcBusVoltage");
  await expect(cell("sheet_type")).toHaveText("Sys_F32");
  await expect(cell("enum_table")).toHaveText("bit0:有效\nbit1:故障");
  await expect(cell("notes")).toHaveText("");
  await expect(cell("type_length")).toHaveAttribute("aria-readonly", "true");
  await expect(cell("sheet_data_type")).toHaveCount(0);
  await expect(cell("sheet_upp_model")).toHaveCount(0);
  await expect(page.getByPlaceholder("搜索名称、变量、类型或分类…")).toBeVisible();
  await expect(page.locator('.point-column-label').filter({ hasText: /^DataType/ })).toHaveText("DataType\nLength");
  const search = page.getByPlaceholder("搜索名称、变量、类型或分类…");
  await search.fill("bit1:故障");
  await expect(rows()).toHaveCount(1);
  await search.clear();
  await expect(rows()).toHaveCount(2);
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
  await page.getByLabel(`编辑 ${processDefinition.fields.max_value.label}`, { exact: true }).fill("");
  await page.getByLabel(`编辑 ${processDefinition.fields.max_value.label}`, { exact: true }).press("Enter");
  await expect(cell("max_value")).toHaveText("");
  await page.getByRole("button", { name: "检查", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("草稿检查结果");
  assert.equal(requests.at(-1).body.rows[0].values.max_value, null);
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await cell("sheet_type").dblclick();
  await page.getByLabel("编辑 DateType", { exact: true }).selectOption("Sys_U16");
  await expect(cell("type_length")).toHaveText("2");
  await cell("element_count").dblclick();
  await page.getByLabel("编辑 ArrayCnt", { exact: true }).fill("15");
  await page.getByLabel("编辑 ArrayCnt", { exact: true }).press("Enter");
  await expect(cell("byte_length")).toHaveText("30");
  await expect(cell("max_value")).toHaveAttribute("aria-readonly", "false");
  await cell("display_digits").dblclick();
  await page.getByLabel("编辑 DisplayDigit", { exact: true }).fill("3");
  await page.getByLabel("编辑 DisplayDigit", { exact: true }).press("Enter");
  await expect(cell("precision")).toHaveText("0.001");
  await cell("category").dblclick();
  await page.getByLabel("编辑 数据分类", { exact: true }).selectOption("任务级观测量");
  await cell("ram").dblclick();
  await page.getByLabel("编辑 RAM", { exact: true }).selectOption("Y");
  await cell("enum_table").dblclick();
  const multiline = page.getByLabel("编辑 EnumTab", { exact: true });
  await expect(multiline).toHaveJSProperty("tagName", "TEXTAREA");
  await multiline.fill("bit0:修改");
  await multiline.press("End");
  await multiline.press("Shift+Enter");
  await multiline.pressSequentially("bit1:新增");
  await multiline.press("Enter");
  await expect(cell("enum_table")).toHaveText("bit0:修改\nbit1:新增");
  await page.getByRole("button", { name: "检查", exact: true }).click();
  await expect(page.locator("dialog .impact-list")).toContainText("RAM：N → Y");
  await expect(page.locator("dialog .impact-list")).toContainText("DateType：Sys_F32 → Sys_U16");
  await expect(page.locator("dialog .impact-list")).not.toContainText("[object Object]");
  await expect(page.locator("dialog .impact-list")).not.toContainText("metadata");
  const sheetChanges = requests.at(-1).body.rows[0].values;
  assert.equal(sheetChanges.sheet_type, "Sys_U16");
  assert.equal(sheetChanges.element_count, 15);
  assert.equal(sheetChanges.enum_table, "bit0:修改\nbit1:新增");
  assert.equal(sheetChanges.display_digits, 3);
  assert.equal(sheetChanges.category, "任务级观测量");
  assert.equal(sheetChanges.ram, "Y");
  for (const key of ["byte_length", "precision", "sheet_data_type", "sheet_upp_model", "internal_type", "sig_id"]) assert.ok(!(key in sheetChanges));
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await openRowAction(page, rows().first());
  await page.getByLabel("RAM", { exact: true }).selectOption("Y");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog .impact-list")).toContainText("RAM：N → Y");
  await expect(page.locator("dialog .impact-list")).not.toContainText("[object Object]");
  await page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("button", { name: "新建DSP内部数据", exact: true }).click();
  await page.getByLabel(processDefinition.fields.name.label, { exact: true }).fill("新增内部点");
  await page.getByLabel(processDefinition.fields.variable_name.label, { exact: true }).fill("NewInternalPoint");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("关联检查通过");
  const processCreate = requests.at(-1).body;
  assert.equal(processCreate.values.group_key, "LOCAL", JSON.stringify(processCreate));
  assert.equal(processCreate.values.element_count, 1);
  assert.equal(processCreate.values.variable_name, "NewInternalPoint");
  assert.equal(processCreate.values.sheet_type, "Sys_F32");
  assert.ok(!("enum_name" in processCreate.values));
  assert.ok(!("sig_id" in processCreate.values));
  assert.ok(!("group_id" in processCreate.values));
  assert.ok(!("data_item_id" in processCreate.values));
  await page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("tab", { name: /^DSP UPP转发表/ }).click();
  await expect(rows()).toHaveCount(3);
  for (const column of ["effective_address", "effective_length"]) await expect(cell(column)).toHaveAttribute("aria-readonly", "true");
  await page.getByRole("button", {name:"重算协议布局",exact:true}).click();
  await expect(page.locator("dialog")).toContainText("协议布局计算预览");
  assert.equal(requests.at(-1).body.operation,"recalculate");
  await page.locator("dialog").getByRole("button",{name:"关闭",exact:true}).last().click();
  await expect(cell("upp_model")).toHaveText("1");
  await expect(cell("upp_model")).toHaveAttribute("aria-readonly", "true");
  for (const key of ["name", "enabled", "byte_length"]) await expect(cell(key)).toHaveCount(0);
  assert.deepEqual(await page.locator(".point-table thead th[data-column-key] .point-column-label").allTextContents(), ["数据名称", "VariateName", "数据分类", "UPP模型号", "UPP偏移地址", "UPP协议字节数", "数据类型", "协议系数", "读写属性"]);
  await expect(cell("resolved_sig_id")).toHaveCount(0);
  await expect(cell("category")).toHaveText("系统参数1");
  const classification = page.getByRole("group", { name: "转发数据分类", exact: true });
  const mutationsBeforeFilter = requests.length;
  await classification.getByRole("button", { name: /^任务级观测量/ }).click();
  await expect(rows()).toHaveCount(1);
  await expect(cell("category")).toHaveText("任务级观测量");
  await classification.getByRole("button", { name: /^系统参数1/ }).click();
  await expect(rows()).toHaveCount(2);
  await classification.getByRole("button", { name: /^全部分类/ }).click();
  await expect(rows()).toHaveCount(3);
  assert.equal(requests.length, mutationsBeforeFilter, "classification is a local view");
  await rows().first().locator(".drag-handle").dragTo(rows().last());
  await expect(rows().first()).toHaveAttribute("data-row-id", "3");
  await expect(page.locator(".point-draft-bar")).toHaveCount(0);
  await cell("signal_name").dblclick();
  await page.getByLabel("编辑 数据名称", { exact: true }).selectOption("2");
  await expect(cell("variable_name")).toHaveText("OutputCurrent");
  await expect(cell("upp_model")).toHaveText("99");
  // The protocol length remains independent from the new source's 2 internal bytes.
  await expect(cell("effective_length")).toHaveText("4");
  await expect(page.locator('.point-table [data-column-key="sheet_type"]')).toHaveCount(0);
  await expect(cell("category")).toHaveText("任务级观测量");
  await expect(cell("effective_type")).toHaveText("S32");
  await cell("scale").dblclick();
  await page.getByLabel("编辑 协议系数", { exact: true }).fill("0.025");
  await page.getByLabel("编辑 协议系数", { exact: true }).press("Enter");
  for (const key of ["byte_order", "conversion"]) await expect(cell(key)).toHaveCount(0);
  await page.getByRole("button", { name: "检查", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("草稿检查结果");
  const changed = requests.at(-1).body.rows[0].values;
  assert.equal(changed.process_point_id, 2);
  assert.equal(changed.scale, 0.025);
  for (const key of ["byte_order", "conversion"]) assert.ok(!(key in changed));
  assert.ok(!("wire_type" in changed), "switching an existing mapping preserves manual communication values");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await cell("effective_type").dblclick();
  await page.getByLabel(`编辑 ${forwardDefinition.fields.wire_type.label}`, { exact: true }).selectOption("F32");
  await expect(cell("effective_type")).toHaveAttribute("title", /当前 F32 偏离建议/);
  await cell("scale").dblclick();
  await page.getByLabel("编辑 协议系数", { exact: true }).fill("1");
  await page.getByLabel("编辑 协议系数", { exact: true }).press("Enter");
  await classification.getByRole("button", { name: /^任务级观测量/ }).click();
  await expect(rows()).toHaveCount(1);
  await expect(page.locator(".point-grid-draft")).toContainText("1 行");
  await page.getByRole("button", { name: "检查并保存", exact: true }).click();
  await expect(page.locator("dialog .point-communication-warnings")).toContainText("当前 F32 偏离建议 S32");
  assert.equal(requests.at(-1).body.rows[0].id, 3);
  await page.getByRole("button", { name: "返回调整", exact: true }).click();
  await classification.getByRole("button", { name: /^全部分类/ }).click();
  await cell("effective_type").click();
  await page.locator(".point-grid-status").getByRole("button", { name: "应用通信建议", exact: true }).click();
  await expect(cell("effective_type")).toHaveText("S32");
  await expect(page.locator(".point-grid-draft")).toContainText("0 行");
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await openRowAction(page, rows().first());
  await expect(page.getByLabel("转发字段名称", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("启用", { exact: true })).toHaveCount(0);
  for (const label of ["UPP偏移地址", "UPP协议字节数"]) await expect(page.getByLabel(label, {exact:true})).toHaveCount(0);
  await page.getByLabel("读写属性", {exact:true}).selectOption("RW");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("关联检查通过");
  assert.equal(requests.at(-1).body.values.access, "RW");
  assert.ok(!("address" in requests.at(-1).body.values));
  for (const key of ["name", "enabled", "byte_order", "conversion"]) assert.ok(!(key in requests.at(-1).body.values));
  assert.equal(requests.at(-1).body.expected.scale, 0.001);
  await page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("button", { name: "新建DSP UPP转发表", exact: true }).click();
  await page.getByLabel("数据名称", { exact: true }).selectOption("1");
  await expect(page.getByLabel(forwardDefinition.fields.wire_type.label, { exact: true })).toHaveValue("S32");
  await expect(page.getByLabel("UPP协议字节数", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("协议系数", { exact: true })).toHaveValue("0.001");
  await page.getByLabel("数据名称", { exact: true }).selectOption("2");
  await expect(page.getByLabel(forwardDefinition.fields.wire_type.label, { exact: true })).toHaveValue("U16");
  await expect(page.getByLabel("UPP协议字节数", { exact: true })).toHaveCount(0);
  await page.getByLabel(forwardDefinition.fields.wire_type.label, { exact: true }).selectOption("F32");
  await page.getByLabel("数据名称", { exact: true }).selectOption("1");
  await expect(page.getByLabel(forwardDefinition.fields.wire_type.label, { exact: true })).toHaveValue("F32");
  await expect(page.getByLabel("UPP协议字节数", { exact: true })).toHaveCount(0);

  for (const label of ["数据转换", "字节序"]) await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await page.getByLabel("协议系数", { exact: true }).fill("1");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await expect(page.locator("dialog")).toContainText("关联检查通过");
  await expect(page.locator("dialog .point-communication-warnings")).toContainText("当前 F32 偏离建议 S32");
  const overrideCreate = requests.at(-1).body.values;
  assert.deepEqual(Object.fromEntries(["wire_type", "scale"].map(key => [key, overrideCreate[key]])), {
    wire_type: "F32", scale: 1,
  });
  await page.locator("dialog").getByRole("button", { name: "应用通信建议", exact: true }).click();
  await expect(page.getByLabel(forwardDefinition.fields.wire_type.label, { exact: true })).toHaveValue("S32");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  const forwardCreate = requests.at(-1).body.values;
  assert.equal(forwardCreate.process_point_id, 1);
  assert.equal(forwardCreate.endpoint_key, "UPP_SERVICE");
  assert.equal(forwardCreate.wire_type, "S32");
  assert.ok(!("wire_length" in forwardCreate));
  assert.equal(forwardCreate.scale, 0.001);
  for (const key of ["upp_model", "name", "enabled", "byte_order", "conversion"]) assert.ok(!(key in forwardCreate));
  for (const key of ["endpoint_id", "context_id", "signal_id", "field_id"]) assert.ok(!(key in forwardCreate), `${key} must not be injected`);
  await page.route("**/__native_import", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="test"></div><script type="module">
    import { createApp, h } from '/node_modules/.vite/deps/vue.js';
    import ImportModal from '/src/components/ImportModal.vue';
    import '/src/style.css';
    createApp({ render: () => h(ImportModal, { pid: 1, canWrite: true, boards: [{code:"DSP",name:"DSP 功率板"},{code:"CUSTOM",name:"自定义板卡"}] }) }).mount('#test');
  </script></body></html>` }));
  await page.route("**/api/projects/1/imports/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) return route.fulfill({ json: {
      id: 98, board_key: "DSP", board_name: "DSP 功率板", group_counts:[{name:"内部点",count:552}], import_scope: "dsp", filename: "dsp.xlsx", sha256: "a".repeat(64), point_count: 552, dsp_count: 552,
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
  await expect(page.locator(".confirm-checkbox")).toContainText("保留项目拓扑和其他板卡数据");
  const importButton = page.getByRole("button", { name: "确认导入 552 个测点", exact: true });
  await expect(importButton).toBeDisabled();
  await page.locator(".confirm-checkbox input").check();
  await expect(importButton).toBeEnabled();
  await Promise.all([page.waitForResponse(response => response.url().endsWith("/imports/98/commit")), importButton.click()]);
  assert.deepEqual(errors, []);
  console.log("PASS: native DSP groups/counts, point creation, reference edits, fractional scale, previews without conversion/byte-order inputs, and DSP-only import confirmation");
} finally {
  await browser?.close();
  await server.close();
}
