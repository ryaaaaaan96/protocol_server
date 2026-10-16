import fs from "node:fs";
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
const nav = page.getByRole("navigation", { name: "项目与板卡导航" });
const tab = (name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const close = () =>
  page
    .locator("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
const record = () => page.locator(".sheet-scroll .record-name");
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
  await tab("内部信号表").click();
};
try {
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill(env.ADMIN_USERNAME);
  await page.getByLabel("密码", { exact: true }).fill(env.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "项目拓扑", exact: true }).waitFor();
  const pid = await page.getByLabel("当前项目").inputValue(),
    g = await (await page.request.get(`/api/projects/${pid}/topology`)).json();
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
  await expect(page.locator("main").getByRole("button")).toHaveCount(5);
  await expect(
    page.getByRole("button", { name: "项目 JSON 配置", exact: true }),
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
    await expect(tab("内部信号表")).toContainText(count);
    if (code.startsWith("IDU_")) {
      await tab("板间协议").click();
      await expect(tableRows()).toHaveCount(1);
      await expect(tableRows().first()).toContainText(`CSU ↔ ${code}`);
      await expect(tableRows().first()).toContainText("MODBUS");
      await expect(tableRows().first()).toContainText("RS485");
      await tab("逻辑设备").click();
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
  await expect(tab("内部信号表")).toContainText("202");
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

  await tab("采集表").click();
  await expect(tab("采集表")).toContainText("328");
  await record().first().click();
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
  await tab("转发表").click();
  await expect(tab("转发表")).toContainText("86");
  for (const name of await record().allTextContents())
    expect(name).toBe("北向 Modbus 服务");
  await tab("范围表").click();
  const range = g.signal_ranges[0],
    signal = g.v_signals.find((s) => s.id === range.signal_id);
  await expect(tableRows().first().locator("td").nth(3)).toHaveText(
    signal.default_value ?? "—",
  );
  await record().first().click();
  await expect(page.getByLabel("默认值覆盖", { exact: true })).toHaveValue(
    range.default_value ?? "",
  );
  await close();
  await tab("板间协议").click();
  await expect(tableRows()).toHaveCount(3);
  await expect(tableRows().nth(0)).toContainText("CSU ↔ UPM");
  await expect(tableRows().nth(0)).toContainText("MODBUS");
  await expect(tableRows().nth(0)).toContainText("CANFD");
  await expect(tableRows().nth(1)).toContainText("CSU ↔ UPM");
  await expect(tableRows().nth(1)).toContainText("UPP");
  await expect(tableRows().nth(1)).toContainText("CANFD");
  await tab("协议端点").click();
  await page.getByRole("button", { name: "新建协议端点", exact: true }).click();
  await page.getByLabel("传输方式", { exact: true }).selectOption("CANFD");
  await expect(page.getByLabel("传输方式", { exact: true })).toHaveValue(
    "CANFD",
  );
  await close();
  await tab("板间协议").click();
  await page
    .getByRole("button", { name: "选择 DSP 板卡", exact: true })
    .click();
  await expect(tab("板间协议")).toHaveAttribute("aria-selected", "true");
  await expect(tableRows()).toHaveCount(1);
  await expect(tableRows().first()).toContainText("UPM ↔ DSP");
  await expect(page.getByLabel("搜索当前表格")).toHaveValue("");
  await tab("内部信号表").click();
  await expect(tab("内部信号表")).toContainText("552");
  for (const group of await tableRows()
    .locator("td:nth-child(3)")
    .allTextContents())
    expect(group).toBe("DSP 源变量");
  await tab("板间协议").click();
  await expect(tableRows()).toHaveCount(1);
  await expect(tableRows().first()).toContainText("UPM ↔ DSP");
  await tab("逻辑设备").click();
  await page
    .getByRole("button", { name: "新建逻辑设备上下文", exact: true })
    .click();
  await expect(page.getByLabel("板卡模板", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("板卡模板", { exact: true })).toHaveValue(
    String(dsp.id),
  );
  await close();
  await selectBoard("CSU");
  await expect(tab("内部信号表")).toContainText("0");
  await expect(
    page.getByText("当前表格暂无匹配记录", { exact: true }),
  ).toBeVisible();
  await tab("逻辑设备").click();
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
  await tab("数据定义").click();
  await page.getByLabel("搜索当前表格").fill("机器型号");
  await record().first().click();
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
  await tab("板间协议").click();
  await page
    .getByRole("button", { name: "项目 JSON 配置", exact: true })
    .click();
  const editor = page.getByLabel("项目 JSON 内容");
  await expect(editor).toHaveValue(/board_types/);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const download = await downloadPromise;
  expect(
    JSON.parse(fs.readFileSync(await download.path(), "utf8")).mounts[0]
      .quantity,
  ).toBe(24);
  await page
    .getByLabel("导入项目 JSON")
    .setInputFiles("../config/project.example.json");
  await expect(editor).toHaveValue(
    fs.readFileSync("../config/project.example.json", "utf8"),
  );
  const modified = structuredClone(g.project_config);
  modified.mounts[0].quantity = 12;
  await editor.fill(JSON.stringify(modified, null, 2));
  await page.getByRole("button", { name: "检查项目配置", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "配置检查通过" }).waitFor();
  await expect(page.getByRole("status")).toContainText("DSP × 96");
  const invalid = structuredClone(g.project_config);
  invalid.mounts[0].parent = "DSP";
  await editor.fill(JSON.stringify(invalid));
  await expect(
    page.getByRole("button", { name: "应用项目配置", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "检查项目配置", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "配置不能提交" }).waitFor();
  await editor.fill(JSON.stringify(g.project_config));
  await page.route("**/api/projects/*/changes/preview", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "项目已被修改，请刷新后重新预览" }),
    }),
  );
  await page.getByRole("button", { name: "检查项目配置", exact: true }).click();
  await page
    .locator('dialog [role="alert"]')
    .filter({ hasText: "项目已被修改" })
    .waitFor();
  await page.unroute("**/api/projects/*/changes/preview");
  await close();
  console.log(
    "PASS: shared type impact, JSON import/export, count preview, cyclic hierarchy rejection and stale revision feedback",
  );

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
    .getByRole("button", { name: "项目 JSON 配置", exact: true })
    .click();
  await expect(page.getByLabel("项目 JSON 内容")).toHaveValue(/board_types/);
  await close();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.getByLabel("新项目 JSON 配置")).toHaveValue(/CSU/);
  await page.getByRole("button", { name: "取消", exact: true }).click();
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
  await expect(page.locator("main").getByRole("button")).toHaveCount(5);
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
  await tab("板间协议").click();
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
    page.getByRole("button", { name: "新建内部信号", exact: true }),
  ).toHaveCount(0);
  await record().first().click();
  await expect(page.getByLabel("名称", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "检查关联影响", exact: true }),
  ).toHaveCount(0);
  await close();
  await tab("板间协议").click();
  await page
    .getByRole("button", { name: "项目 JSON 配置", exact: true })
    .click();
  await expect(page.getByLabel("项目 JSON 内容")).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(
    page.getByRole("button", { name: "检查项目配置", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "导出 JSON", exact: true }),
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
  await browser.close();
}
