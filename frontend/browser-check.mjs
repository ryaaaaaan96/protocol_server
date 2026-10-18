import fs from "node:fs";
import { checkPointInteractions } from "./point-interactions-check.mjs";
import { checkPointGroups } from "./point-groups-check.mjs";
import { checkPointColumns } from "./point-columns-check.mjs";
import { checkPointGrid, checkPointGridMappings, checkPointStringRanges, checkReadonlyGrid } from "./point-grid-check.mjs";
import { openRowAction } from "./point-menus-check.mjs";
import { checkProjectEditLock, cleanupProjectEditing } from "./project-edit-lock-check.mjs";
import { checkPointCopy } from "./point-copy-check.mjs";
import { checkProjectTopologyImport } from "./project-topology-import-check.mjs";
import { checkProjectFolderImport } from "./project-folder-import-check.mjs";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const env = Object.fromEntries(
  fs
    .readFileSync("../.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
    baseURL: process.env.BASE_URL || "http://127.0.0.1:8080",
    viewport: { width: 1440, height: 1000 },
  }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Every intended commit is intercepted by its test; never write development data.
await page.route("**/api/projects/*/changes/*/commit", route => {
  errors.push("Unexpected commit: " + route.request().url());
  return route.fulfill({ status: 500, json: { error: "浏览器测试禁止未拦截的提交" } });
});
await page.route("**/api/project-folders/commit", route => {
  errors.push("Unexpected folder import: " + route.request().url());
  return route.fulfill({ status: 500, json: { error: "浏览器测试禁止未拦截的项目文件夹导入" } });
});
const nav = page.getByRole("navigation", { name: "项目与板卡导航" });
const tab = (name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const auxiliary = async (name) => {
  await tab(name).click();
};
const close = async () => {
  const accept = d => d.accept();
  page.on("dialog", accept);
  await page
    .locator("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  page.off("dialog", accept);
};
const record = () => page.locator(".sheet-scroll .record-name");
const openRecord = async (name = record().first()) => {
  await expect(name).toBeVisible();
  const row = name.locator("xpath=ancestor::tr");
  const menu = row.getByRole("button", { name: /^记录操作 / });
  if (await menu.count()) await openRowAction(page, row);
  else await name.click();
};
const tableRows = () => page.locator(".sheet-scroll tbody tr");
const options = async (name) => {
  const select = page.getByLabel(name, { exact: true });
  await expect(select).toBeVisible();
  return (
    await select.locator("option").evaluateAll((os) => os.map((o) => o.value))
  )
    .filter(Boolean)
    .map(Number);
};
const selectBoard = async (code) => {
  await nav.getByRole("button", { name: "板卡内部信息", exact: true }).click();
  await page
    .getByRole("button", { name: `选择 ${code} 板卡`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `选择 ${code} 板卡`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "板卡内部信息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "项目板卡类型协议拓扑" }),
  ).toHaveCount(0);
  await tab(code === "DSP" ? "DSP内部数据" : "处理点表").click();
};
try {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill(env.ADMIN_USERNAME);
  await page.getByLabel("密码", { exact: true }).fill(env.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "项目拓扑", exact: true }).waitFor();
  const pid = await page.getByLabel("当前项目").inputValue(),
    g = await (await page.request.get(`/api/projects/${pid}/topology`)).json();
  await checkProjectEditLock(page, { pid });
  expect(g.project_config.board_types.map((t) => t.code)).toEqual([
    "CSU",
    "UPM",
    "DSP",
    "IDU_T",
    "IDU_R",
  ]);
  await expect(
    page.getByRole("group", { name: "项目板卡类型协议拓扑" }),
  ).toBeVisible();
  await expect(page.locator(".type-node")).toHaveCount(5);
  const csuLink = page.locator(
    '.type-connection-line[data-parent="CSU"][data-child="UPM"]',
  );
  const dspLink = page.locator(
    '.type-connection-line[data-parent="UPM"][data-child="DSP"]',
  );
  await expect(page.locator(".type-connection-line")).toHaveCount(4);
  await expect(csuLink).not.toHaveAttribute("stroke-dasharray");
  await expect(dspLink).not.toHaveAttribute("stroke-dasharray");
  for (const edge of [csuLink, dspLink]) {
    // Horizontal SVG paths have a zero-height DOM box despite a visible stroke.
    await expect(edge).toHaveAttribute("stroke-width", "3");
    expect(await edge.evaluate((e) => getComputedStyle(e).visibility)).toBe(
      "visible",
    );
    expect(await edge.evaluate((e) => e.getTotalLength())).toBeGreaterThan(50);
    await expect(edge).toHaveAttribute("marker-end", /url\(#type-arrow/);
  }
  await expect(
    nav.getByRole("button", { name: "板卡内部信息", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main table")).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.locator("main .type-node")).toHaveCount(5);
  await expect(
    page.getByRole("button", { name: "项目拓扑配置", exact: true }),
  ).toHaveCount(0);
  await expect(nav.locator(".board-nav-item")).toHaveCount(0);
  await expect(page.locator(".type-edge-count")).toHaveText([
    "× 24",
    "× 8",
    "× 1",
    "× 4",
  ]);
  await expect(page.locator(".type-edge-protocol")).toHaveText([
    "MODBUS / CAN FD",
    "UPP / CAN FD",
    "UPP / CAN",
    "MODBUS / RS485",
    "MODBUS / RS485",
  ]);
  const boxes = await page.locator(".type-node").evaluateAll((nodes) =>
    Object.fromEntries(
      nodes.map((node) => {
        const rect = node.querySelector("rect");
        return [
          node.dataset.code,
          {
            x: rect.x.baseVal.value,
            y: rect.y.baseVal.value,
            w: rect.width.baseVal.value,
            h: rect.height.baseVal.value,
          },
        ];
      }),
    ),
  );
  expect(boxes.UPM.x).toBe(boxes.IDU_T.x);
  expect(boxes.UPM.x).toBe(boxes.IDU_R.x);
  expect(boxes.CSU.x).toBeLessThan(boxes.UPM.x);
  expect(boxes.DSP.x).toBeGreaterThan(boxes.UPM.x);
  const rects = Object.values(boxes);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i],
        b = rects[j];
      expect(
        a.x + a.w <= b.x ||
          b.x + b.w <= a.x ||
          a.y + a.h <= b.y ||
          b.y + b.h <= a.y,
      ).toBe(true);
    }
  const edgeLabels = await page
    .locator(".type-edge-count, .type-edge-protocol")
    .evaluateAll((labels) =>
      labels.map((label) => {
        const box = label.getBBox();
        return { x: box.x, y: box.y, w: box.width, h: box.height };
      }),
    );
  for (const label of edgeLabels)
    for (const node of rects) {
      expect(
        label.x + label.w <= node.x ||
          node.x + node.w <= label.x ||
          label.y + label.h <= node.y ||
          node.y + node.h <= label.y,
      ).toBe(true);
    }
  for (const code of ["IDU_T", "IDU_R"]) {
    const edge = page.locator(
      `.type-connection-line[data-parent="CSU"][data-child="${code}"]`,
    );
    await expect(edge).toHaveCount(1);
    await expect(edge).not.toHaveAttribute("stroke-dasharray");
  }
  await expect(page.locator(".type-topology-legend")).toContainText(
    "DSP × 192",
  );
  await page.screenshot({
    path: "../.runtime/project-topology.png",
    fullPage: true,
  });
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: "板卡内部信息", exact: true }),
  ).toHaveCount(0);
  for (const [code, count, activation] of [
    ["CSU", "0", "click"],
    ["IDU_T", "0", "click"],
    ["IDU_R", "0", "click"],
    ["DSP", "552", "click"],
    ["CSU", "0", "Enter"],
    ["DSP", "552", "Space"],
    ["UPM", "202", "click"],
  ]) {
    await nav.getByRole("button", { name: "项目拓扑", exact: true }).click();
    const node = page.getByRole("button", {
      name: `查看 ${code} 板卡内部信息`,
      exact: true,
    });
    if (activation === "click") await node.click();
    else {
      await node.focus();
      await expect(node).toBeFocused();
      await node.press(activation);
    }
    await expect(
      page.getByRole("heading", { name: "板卡内部信息", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `选择 ${code} 板卡`, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    if (code === "UPM") await page.getByRole("button", { name: "全部分组", exact: true }).click();
    await expect(tab(code === "DSP" ? "DSP内部数据" : "处理点表")).toContainText(count);
    if (code === "CSU" && activation === "click") {
      await expect(page.getByRole("tab")).toHaveCount(11);
      await expect(tab("范围表")).toHaveCount(0);
      await expect(tab("采集点表")).toBeVisible();
      await expect(tab("转发点表")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "展开辅助配置", exact: true }),
      ).toHaveCount(0);
    }
    if (code.startsWith("IDU_")) {
      await auxiliary("板间协议");
      await expect(tableRows()).toHaveCount(1);
      await expect(tableRows().first()).toContainText(`CSU ↔ ${code}`);
      await expect(tableRows().first()).toContainText("MODBUS");
      await expect(tableRows().first()).toContainText("RS485");
      await auxiliary("逻辑设备");
      await page
        .getByRole("button", { name: "新建逻辑设备上下文", exact: true })
        .click();
      const type = g.project_config.board_types.find((t) => t.code === code);
      const model = g.board_models.find((m) => m.code === type.model_code);
      await expect(page.getByLabel("板卡模板", { exact: true })).toHaveValue(
        String(model.id),
      );
      await expect(page.getByLabel("板卡模板", { exact: true })).toBeDisabled();
      await close();
    }
  }
  await expect(
    page.getByRole("heading", { name: "板卡内部信息", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".board-type-choice")).toHaveCount(5);
  await expect(nav.locator(".board-nav-item")).toHaveCount(5);
  await expect(
    page.getByRole("group", { name: "项目板卡类型协议拓扑" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "选择 UPM 板卡", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(tab("处理点表")).toContainText("202");
  expect(
    await page
      .locator(".sheet-scroll tbody tr")
      .first()
      .evaluate((r) => parseFloat(getComputedStyle(r.children[1]).fontSize)),
  ).toBeGreaterThanOrEqual(14);
  await page.screenshot({
    path: "../.runtime/board-information.png",
    fullPage: true,
  });
  console.log(
    "PASS: topology nodes open their own board details by click/Enter/Space; 5 types, independent IDUs, branching Modbus links and readable tables",
  );

  await checkPointGroups(page, { pid, graph: g });

  await tab("采集点表").click();
  await expect(tab("采集点表")).toContainText("328");
  await openRecord();
  const arm = g.board_models.find((m) => m.code === "UPM_ARM"),
    dsp = g.board_models.find((m) => m.code === "DSP"),
    csu = g.board_models.find((m) => m.code === "CSU");
  expect(await options("协议端点")).toEqual(
    g.endpoints
      .filter((e) => e.model_id === arm.id && e.role === "client")
      .map((e) => e.id),
  );
  const binding = g.v_bindings.find(
      (b) => b.role === "client" && b.model_id === arm.id,
    ),
    context = g.device_contexts.find((c) => c.id === binding.context_id);
  expect(await options("本地内部信号")).toEqual(
    g.signals.filter((s) => s.group_id === context.group_id).map((s) => s.id),
  );
  const local = g.device_contexts.find(
    (c) => c.model_id === arm.id && c.kind === "local",
  );
  await page
    .getByLabel("逻辑设备", { exact: true })
    .selectOption(String(local.id));
  await expect(page.getByLabel("本地内部信号", { exact: true })).toHaveValue(
    "",
  );
  await close();
  await checkPointGridMappings(page, { pid, modelId: arm.id });
  await openRowAction(page, tableRows().first(), "关联处理点");
  await expect(tab("处理点表")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("信号名称", { exact: true })).toHaveValue(
    binding.signal_name,
  );
  await expect(page.getByLabel("默认值覆盖", { exact: true })).toBeVisible();
  await close();
  await page.getByRole("button", { name: "全部分组", exact: true }).click();
  await page.getByLabel("搜索当前表格").fill("整流Rect1电压");
  await expect(record()).toHaveCount(1);
  await openRecord();
  await expect(page.getByLabel("下限覆盖", { exact: true })).toHaveValue("");
  await expect(page.locator(".point-inheritance")).toContainText("-100");
  await page.getByLabel("数字 sigID", { exact: true }).fill("60001");
  await page.getByLabel("下限覆盖", { exact: true }).fill("-99");
  const processPreviewResponse = page.waitForResponse((r) =>
    r.url().endsWith("/point-tables/process/preview"),
  );
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  const processPreview = await (await processPreviewResponse).json();
  expect(processPreview.allowed).toBe(true);
  expect(
    processPreview.impact.changes.some((c) => c.entity === "signal_ranges"),
  ).toBe(true);
  expect(
    processPreview.impact.changes.some((c) => c.entity === "v_bindings"),
  ).toBe(true);
  await page.screenshot({
    path: "../.runtime/process-point-preview.png",
    fullPage: true,
  });
  await page.getByLabel("下限覆盖", { exact: true }).fill("-98");
  await expect(
    page.getByRole("button", { name: "确认提交", exact: true }),
  ).toHaveCount(0);
  await close();
  console.log(
    "PASS: three primary tables, stable signal navigation and atomic process/range preview with inherited defaults",
  );
  await tab("转发点表").click();
  await expect(tab("转发点表")).toContainText("86");
  expect(await record().first().textContent()).toBe(
    g.v_bindings.find((b) => b.role === "server" && b.model_id === arm.id)
      .signal_name,
  );
  await tab("处理点表").click();
  await expect(tab("范围表")).toHaveCount(0);
  await expect(page.locator('.point-table th[data-column-key="boot_restore"]')).toContainText("上电恢复默认值");
  await expect(page.locator('.point-table th[data-column-key="manual_restore"]')).toContainText("允许手动恢复默认值");
  const range = g.signal_ranges.find((r) =>
      g.v_signals.some((s) => s.id === r.signal_id && s.model_id === arm.id),
    ),
    signal = g.v_signals.find((s) => s.id === range.signal_id);
  await page.getByLabel("搜索当前表格").fill(signal.name);
  await openRecord(page.locator(".sheet-scroll").getByText(signal.name, { exact: true }));
  await expect(page.getByLabel("默认值覆盖", { exact: true })).toHaveValue(
    range.default_value ?? "",
  );
  expect(await page.getByLabel("上电恢复默认值", { exact: true }).isChecked()).toBe(range.boot_restore);
  expect(await page.getByLabel("允许手动恢复默认值", { exact: true }).isChecked()).toBe(range.manual_restore);
  await close();
  await auxiliary("板间协议");
  await expect(tableRows()).toHaveCount(3);
  await expect(tableRows().nth(0)).toContainText("CSU ↔ UPM");
  await expect(tableRows().nth(0)).toContainText("MODBUS");
  await expect(tableRows().nth(0)).toContainText("CANFD");
  await expect(tableRows().nth(1)).toContainText("CSU ↔ UPM");
  await expect(tableRows().nth(1)).toContainText("UPP");
  await expect(tableRows().nth(1)).toContainText("CANFD");
  await auxiliary("协议端点");
  await page.getByRole("button", { name: "新建协议端点", exact: true }).click();
  await page.getByLabel("传输方式", { exact: true }).selectOption("CANFD");
  await expect(page.getByLabel("传输方式", { exact: true })).toHaveValue(
    "CANFD",
  );
  await close();
  await auxiliary("板间协议");
  await page
    .getByRole("button", { name: "选择 DSP 板卡", exact: true })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(tab("板间协议")).toHaveCount(0);
  await expect(tab("采集点表")).toHaveCount(0);
  await expect(tab("DSP内部数据")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "DSP内部数据", exact: true })).toBeVisible();
  await expect(page.locator('.point-table th[data-column-key="boot_restore"]')).toContainText("上电恢复默认值");
  await expect(tab("范围表")).toHaveCount(0);
  await expect(page.getByLabel("搜索当前表格")).toHaveValue("");
  await tab("DSP内部数据").click();
  await expect(tab("DSP内部数据")).toContainText("552");
  await openRecord();
  await expect(page.locator("dialog").getByRole("heading")).toContainText("DSP内部数据");
  await close();
  for (const group of await tableRows()
    .locator("td:nth-child(3)")
    .allTextContents())
    expect(group).toBe("DSP 源变量");
  await expect(tab("逻辑设备")).toHaveCount(0);
  await checkPointInteractions(page, { pid, modelId: dsp.id, record, tableRows });
  await checkPointColumns(page, { pid, modelId: dsp.id });
  await checkPointStringRanges(page, { pid, modelId: dsp.id });
  await checkPointCopy(page, { pid, modelId: dsp.id });
  await checkPointGrid(page, { pid, modelId: dsp.id });
  // Override only the response: exercise presentation without editing project data.
  const schemaRoute = `**/api/projects/${pid}/point-tables/schema`;
  const display = await (await page.request.get(`/api/projects/${pid}/point-tables/schema`)).json();
  const customDisplay = structuredClone(display);
  customDisplay.workspace.boards.DSP = {
    tables: ["fields", "forward"],
    labels: { forward: "DSP 对外点表" },
  };
  customDisplay.workspace.boards.UPM = { tables: ["forward"] };
  await page.route(schemaRoute, (route) => route.fulfill({ json: customDisplay }));
  await page.reload();
  await nav.getByRole("button", { name: "板卡内部信息", exact: true }).click();
  await page.getByRole("button", { name: "选择 CSU 板卡", exact: true }).click();
  await tab("处理点表").click();
  await page.getByRole("button", { name: "选择 DSP 板卡", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.getByRole("tab").nth(0)).toContainText("协议字段");
  await expect(page.getByRole("tab").nth(1)).toContainText("DSP 对外点表");
  await expect(tab("协议字段")).toHaveAttribute("aria-selected", "true");
  await tab("DSP 对外点表").click();
  await expect(page.getByRole("heading", { name: "DSP 对外点表", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择 UPM 板卡", exact: true }).click();
  await page.getByRole("button", { name: "全部分组", exact: true }).click();
  await openRowAction(page, tableRows().first(), "关联处理点");
  await expect(page.locator("dialog")).toBeVisible();
  await expect(tab("处理点表")).toHaveCount(0);
  await close();
  customDisplay.workspace.boards.DSP.tables = [];
  await page.reload();
  await nav.getByRole("button", { name: "板卡内部信息", exact: true }).click();
  await page.getByRole("button", { name: "选择 DSP 板卡", exact: true }).click();
  await expect(page.getByText("此板卡暂无展示表格", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.unroute(schemaRoute);
  await page.reload();
  console.log("PASS: configured board tables, order, titles, hidden process links and empty display");
  await selectBoard("CSU");
  await expect(tab("处理点表")).toContainText("0");
  await expect(
    page.getByText("当前表格暂无匹配记录", { exact: true }),
  ).toBeVisible();
  await auxiliary("逻辑设备");
  await page
    .getByRole("button", { name: "新建逻辑设备上下文", exact: true })
    .click();
  await expect(page.getByLabel("板卡模板", { exact: true })).toHaveValue(
    String(csu.id),
  );
  await close();
  console.log(
    "PASS: per-type scopes, collection/forwarding, range inheritance, type links and empty CSU editing defaults",
  );

  await selectBoard("UPM");
  await auxiliary("数据定义");
  // Choose a uniquely named definition actually shared by both board models.
  const sharedData = g.data_items.find((item) =>
    g.data_items.filter((other) => other.name === item.name).length === 1 &&
    [arm.id, dsp.id].every((modelId) =>
      g.v_signals.some((signal) => signal.model_id === modelId && signal.data_item_id === item.id),
    ),
  );
  expect(sharedData).toBeTruthy();
  await page.getByLabel("搜索当前表格").fill(sharedData.name);
  await page.locator(".sheet-scroll").getByRole("button", { name: sharedData.name, exact: true }).click();
  await page.getByLabel("单位", { exact: true }).fill("预览测试");
  const sharedPromise = page.waitForResponse((r) =>
    r.url().endsWith("/changes/preview"),
  );
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  const shared = await (await sharedPromise).json();
  expect(shared.allowed).toBe(true);
  expect(shared.impact.affected_types.map((t) => t.code)).toEqual([
    "UPM",
    "DSP",
  ]);
  await page.getByText(/涉及板卡类型：/).waitFor();
  await page.screenshot({
    path: "../.runtime/type-relations.png",
    fullPage: true,
  });
  await close();
  await checkProjectTopologyImport(page, { pid });
  await checkProjectFolderImport(page, { pid });

  await nav.getByRole("button", { name: "数据校验", exact: false }).click();
  await page.locator(".issue").first().click();
  await page.locator("dialog").waitFor();
  await expect(
    page.getByRole("heading", { name: "板卡内部信息", exact: true }),
  ).toBeVisible();
  await expect(tab("数据定义")).toHaveAttribute("aria-selected", "true");
  await close();
  await nav.getByRole("button", { name: "项目设置", exact: true }).click();
  await tab("工作簿来源").click();
  await page.getByLabel("搜索当前表格").fill("DSP内部数据");
  await page
    .getByRole("button", { name: "查看单元格与公式", exact: true })
    .first()
    .click();
  await page.locator(".source-json").waitFor();
  await close();
  await nav.getByRole("button", { name: "SQL 工作台", exact: true }).click();
  await page.getByRole("button", { name: "运行查询", exact: true }).click();
  await page.locator(".sql-results tbody tr").first().waitFor();
  await nav.getByRole("button", { name: "代码与版本", exact: true }).click();
  await page.getByRole("button", { name: "生成预览", exact: true }).click();
  await page.getByText(/个错误阻止了配置生成/).waitFor();
  await nav.getByRole("button", { name: "项目设置", exact: true }).click();
  await page
    .getByRole("button", { name: "项目拓扑配置", exact: true })
    .click();
  await expect(page.getByLabel("项目拓扑内容")).toHaveValue(/board_types/);
  await close();
  await nav.getByRole("button", { name: "项目拓扑", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await page.getByRole("button", { name: "导航菜单", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().left >= 0,
  );
  await nav.getByRole("button", { name: "板卡内部信息", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await page.getByRole("button", { name: "导航菜单", exact: true }).click();
  await nav.locator(".board-nav-item").filter({ hasText: "DSP" }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await expect(
    page.getByRole("heading", { name: "板卡内部信息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择 DSP 板卡", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("group", { name: "项目板卡类型协议拓扑" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "../.runtime/mobile-board-information.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.body.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "导航菜单", exact: true }).click();
  await nav.getByRole("button", { name: "项目拓扑", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().right <= 0,
  );
  await expect(page.locator("main table")).toHaveCount(0);
  await expect(page.locator("main .type-node")).toHaveCount(5);
  await page.screenshot({
    path: "../.runtime/mobile-project-topology.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.body.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page
    .getByRole("button", { name: "查看 UPM 板卡内部信息", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "板卡内部信息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择 UPM 板卡", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  console.log(
    "PASS: validation opens board details, source cells, SQL, release gate, project settings and mobile node navigation",
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  const legacyGraph = structuredClone(g);
  legacyGraph.project_config.version = 1;
  for (const mount of legacyGraph.project_config.mounts) {
    const first = mount.connections[0];
    delete mount.connections;
    Object.assign(mount, first);
  }
  legacyGraph.project_config.mounts[0].protocol = null;
  legacyGraph.project_config.mounts[0].transport = null;
  const topologyRoute = `**/api/projects/${pid}/topology`;
  await page.route(topologyRoute, (route) =>
    route.fulfill({ json: legacyGraph }),
  );
  await page.reload();
  await expect(
    page.locator('.type-connection-line[data-parent="CSU"][data-child="UPM"]'),
  ).toHaveAttribute("stroke-dasharray", "7 5");
  await expect(page.locator(".type-node")).toHaveCount(5);
  await page
    .getByRole("button", { name: "查看 UPM 板卡内部信息", exact: true })
    .click();
  await auxiliary("板间协议");
  await expect(tableRows()).toHaveCount(2);
  await expect(tableRows().first()).toContainText("待配置");
  await page.unroute(topologyRoute);
  console.log(
    "PASS: CAN FD protocol pairs, endpoint transport choice and legacy JSON rendering",
  );
  await page.route("**/api/projects", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: (await response.json()).map((p) => ({ ...p, role: "viewer" })),
    });
  });
  await page.reload();
  await selectBoard("UPM");
  await expect(
    page.getByRole("button", { name: "新建处理点表", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".drag-handle")).toHaveCount(0);
  await checkReadonlyGrid(page);
  await checkPointCopy(page, { pid, modelId: arm.id, readonly: true });
  await openRecord();
  await expect(page.getByLabel("信号名称", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "检查关联影响", exact: true }),
  ).toHaveCount(0);
  await close();
  await auxiliary("板间协议");
  await page
    .getByRole("button", { name: "项目拓扑配置", exact: true })
    .click();
  await expect(page.getByLabel("项目拓扑内容")).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(
    page.getByRole("button", { name: "检查项目配置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "下载拓扑 JSON", exact: true }),
  ).toBeVisible();
  await close();
  const after = await (
    await page.request.get(`/api/projects/${pid}/topology`)
  ).json();
  expect(after.revision).toBe(g.revision);
  expect(errors).toEqual([]);
  console.log(
    "PASS: viewer controls, no JS exceptions or configuration commits; revision unchanged",
  );
} catch (e) {
  await page
    .screenshot({ path: "../.runtime/browser-failure.png", fullPage: true })
    .catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  try {
    await cleanupProjectEditing(page);
  } finally {
    await browser.close();
  }
}
