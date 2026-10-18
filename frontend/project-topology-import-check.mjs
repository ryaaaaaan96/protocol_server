import fs from "node:fs";
import { expect } from "@playwright/test";
import { ensureProjectEditing } from "./project-edit-lock-check.mjs";

export async function checkProjectTopologyImport(page, { pid }) {
  const nav = page.getByRole("navigation", { name: "项目与板卡导航" });
  await nav.getByRole("button", { name: "项目设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "新建项目", exact: true })).toHaveCount(0);
  await ensureProjectEditing(page);
  const endpoint = `/api/projects/${pid}/configuration/source`;
  const response = await page.request.get(endpoint);
  expect(response.ok()).toBe(true);
  const source = await response.json();
  const sourcePath = `**${endpoint}`;
  const commitPath = `**/api/projects/${pid}/changes/*/commit`;
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "项目拓扑配置", exact: true }).click();
  try {
    const contents = dialog.getByLabel("项目拓扑内容");
    await expect(contents).toHaveAttribute("readonly", "");
    await expect(contents).toHaveValue(JSON.stringify(source.config, null, 2));
    await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
    const downloaded = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载拓扑 JSON", exact: true }).click();
    expect(JSON.parse(fs.readFileSync(await (await downloaded).path(), "utf8"))).toEqual(source.config);
    const checked = page.waitForRequest(request => request.url().endsWith("/changes/preview"));
    await dialog.getByRole("button", { name: "检查项目配置", exact: true }).click();
    const payload = (await checked).postDataJSON();
    expect(payload.values).toEqual(source.config);
    expect(payload.expected.source_sha256).toBe(source.sha256);
    await expect(dialog.getByRole("status")).toContainText("配置检查通过");

    await page.route(sourcePath, route => route.fulfill({ json: { ...source, sha256: "stale-source" } }));
    await dialog.getByRole("button", { name: "重新读取项目文件", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "导入已检查的拓扑", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "检查项目配置", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("服务器项目文件已变化");
    await page.unroute(sourcePath);
    await page.route(sourcePath, route => route.fulfill({ status: 400, json: { error: "项目源文件格式错误" } }));
    await dialog.getByRole("button", { name: "重新读取项目文件", exact: true }).click();
    await expect(dialog.locator('.notice[role="alert"]')).toContainText("项目源文件格式错误");
    await expect(contents).toHaveValue("");
    await expect(dialog.getByRole("button", { name: "检查项目配置", exact: true })).toBeDisabled();
    await page.unroute(sourcePath);

    await dialog.getByRole("button", { name: "重新读取项目文件", exact: true }).click();
    await expect(contents).toHaveValue(JSON.stringify(source.config, null, 2));
    await dialog.getByRole("button", { name: "检查项目配置", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("配置检查通过");
    await page.route(commitPath, route => route.fulfill({ status: 409, json: { error: "服务器项目文件已变化，请重新读取并检查后导入" } }));
    await dialog.getByRole("button", { name: "导入已检查的拓扑", exact: true }).click();
    await expect(dialog.locator('.notice[role="alert"]')).toContainText("服务器项目文件已变化");
    await expect(dialog.getByRole("button", { name: "导入已检查的拓扑", exact: true })).toHaveCount(0);
    console.log("PASS: SSH topology is read-only, reload/download/preview use the server file, stale source and failed reads cannot be imported; no project creation controls");
  } finally {
    await page.unroute(sourcePath);
    await page.unroute(commitPath);
    if (await dialog.isVisible()) await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  }
}
