import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const env = Object.fromEntries(
  fs
    .readFileSync("../.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:8080");
  await page.getByLabel("用户名", { exact: true }).fill(env.ADMIN_USERNAME);
  await page.getByLabel("密码", { exact: true }).fill(env.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "板卡拓扑", exact: true }).waitFor();
  await page.getByRole("img", { name: "项目板卡协议拓扑" }).waitFor();
  if ((await page.locator(".board-node").count()) !== 9)
    throw new Error("Expected 9 board nodes");
  await page.locator(".board-node").first().click();
  await page.getByRole("heading", { name: "协议端点", exact: true }).waitFor();
  await page.screenshot({ path: "../.runtime/topology.png", fullPage: true });
  await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
  await page
    .getByLabel("选择 Excel 文件")
    .setInputFiles("../UPM项目测点数据表.xlsx");
  const importButton = page.getByRole("button", {
    name: "确认导入 612 个测点",
    exact: true,
  });
  await importButton.waitFor();
  if (await importButton.isEnabled())
    throw new Error("Replacement confirmation missing");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "数据与协议", exact: true }).click();
  await page.getByLabel("搜索配置").fill("机器型号");
  await page
    .locator(".record-name")
    .filter({ hasText: "机器型号" })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "编辑共享数据定义", exact: true })
    .waitFor();
  await page.getByLabel("单位", { exact: true }).fill("预览测试");
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "关联检查通过" }).waitFor();
  await page.getByText(/涉及板卡：/).waitFor();
  await page.screenshot({
    path: "../.runtime/data-relations.png",
    fullPage: true,
  });
  await page
    .locator("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  // Exercise recoverable stale-preview feedback; no business edits committed.
  await page.locator(".record-name").first().click();
  await page.route("**/api/projects/*/changes/preview", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "项目已被修改，请刷新后重新预览" }),
    }),
  );
  await page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  await page
    .locator('dialog [role="alert"]')
    .filter({ hasText: "项目已被修改" })
    .waitFor();
  await page
    .locator("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.unroute("**/api/projects/*/changes/preview");
  await page.getByLabel("搜索配置").fill("DSP内部数据");
  await page.getByRole("button", { name: "工作簿来源", exact: true }).click();
  await page
    .getByRole("button", { name: "查看单元格与公式", exact: true })
    .first()
    .click();
  await page.locator(".source-json").waitFor();
  await page
    .locator("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "SQL 工作台", exact: true }).click();
  await page.getByRole("button", { name: "运行查询", exact: true }).click();
  await page.locator(".sql-results tbody tr").first().waitFor();
  await page.getByRole("button", { name: /^数据校验/ }).click();
  await page.locator(".issue").first().waitFor();
  await page.getByRole("button", { name: "代码与版本", exact: true }).click();
  await page.getByRole("button", { name: "生成预览", exact: true }).click();
  await page.getByText(/个错误阻止了配置生成/).waitFor();
  await page.getByRole("button", { name: "模板与端点", exact: true }).click();
  await page
    .getByRole("button", { name: "新建板卡模板", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "成员与权限", exact: true }).click();
  await page.getByRole("heading", { name: "项目成员", exact: true }).waitFor();
  await page.getByRole("button", { name: "操作记录", exact: true }).click();
  await page.getByRole("button", { name: "查看变更" }).first().waitFor();
  await page.getByRole("button", { name: "板卡拓扑", exact: true }).click();
  await page.getByRole("img", { name: "项目板卡协议拓扑" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  await page.getByRole('button', {name:'导航菜单',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().left >= 0);
  await page.getByRole('button', {name:'板卡拓扑',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  await page.screenshot({
    path: "../.runtime/mobile-topology.png",
    fullPage: true,
  });
  const width = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
  }));
  if (width.body > width.viewport)
    throw new Error(`Mobile overflow ${JSON.stringify(width)}`);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: topology, endpoint inspector, source cells, shared change preview, stale errors, import confirmation, SQL, validation, release gate, permissions pages and mobile layout; no JavaScript exceptions or business edits.",
  );
} finally {
  await browser.close();
}
