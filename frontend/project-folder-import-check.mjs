import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";

export async function checkProjectFolderImport(page, { pid }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "protocol-folder-ui-"));
  const folder = path.join(temporary, "portable-project");
  fs.mkdirSync(path.join(folder, "DSP"), { recursive: true });
  fs.writeFileSync(path.join(folder, "project.json"), JSON.stringify({ key: "upm" }));
  fs.writeFileSync(path.join(folder, "DSP", "process.json"), "{}");
  const before = await (await page.request.get(`/api/projects/${pid}/topology`)).json();
  const previewPath = "**/api/project-folders/preview";
  const commitPath = "**/api/project-folders/commit";
  let previewStatus = 200, commitStatus = 409, lastUpload = "", lastCommit = null;
  let response = {
    token: "folder-ui-preview",
    key: "upm",
    name: "UPM 文件夹预览",
    existing_project_id: Number(pid),
    revision: before.revision,
    replace_data: false,
    files: ["project.json", "DSP/process.json"],
  };
  const previewHandler = async route => {
    lastUpload = route.request().postDataBuffer().toString("utf8");
    await route.fulfill({ status: previewStatus, json: previewStatus === 200 ? response : {
      error: "项目配置或 Dump 导致数据校验失败，未导入",
      errors: [{ entity: "signals", name: "直流电压", message: "信号编号与已有记录重复" }],
    } });
  };
  const commitHandler = async route => {
    lastCommit = route.request().postDataJSON();
    await route.fulfill({
      status: commitStatus,
      json: commitStatus === 200
        ? { project_id: Number(pid), key: "upm", revision: before.revision, replace_data: false }
        : { error: "项目已被其他成员更新，请重新选择文件夹检查" },
    });
  };
  await page.route(previewPath, previewHandler);
  await page.route(commitPath, commitHandler);
  const dialog = page.getByRole("dialog");
  try {
    const nav = page.getByRole("navigation", { name: "项目与板卡导航" });
    await nav.getByRole("button", { name: "项目设置", exact: true }).click();
    await page.getByRole("button", { name: "导入项目文件夹", exact: true }).click();
    const picker = dialog.getByLabel("选择项目文件夹", { exact: true });
    await expect(picker).toHaveAttribute("webkitdirectory", "");
    await picker.setInputFiles(folder);
    await expect(dialog.getByText("保留当前数据库中的数据", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "覆盖项目配置，保留点表数据", exact: true })).toBeEnabled();
    expect(lastUpload).toContain('name="files"; filename="portable-project/project.json"');
    expect(lastUpload).toContain('filename="portable-project/DSP/process.json"');

    fs.writeFileSync(path.join(folder, "project.dump"), "UI fixture; never restored");
    response = { ...response, token: "folder-dump-preview", replace_data: true, files: [...response.files, "project.dump"] };
    await picker.setInputFiles(folder);
    await expect(dialog.getByText("使用项目 Dump 中的数据", { exact: true })).toBeVisible();
    await expect(dialog.getByText("此文件夹包含项目 Dump，确认后将替换该项目当前的点表数据。", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "覆盖项目配置与点表数据", exact: true }).click();
    expect(lastCommit).toEqual({ token: "folder-dump-preview" });
    await expect(dialog.locator('.notice[role="alert"]')).toContainText("项目已被其他成员更新");
    await expect(dialog.getByRole("button", { name: "覆盖项目配置与点表数据", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("region", { name: "项目文件夹导入预览" })).toHaveCount(0);

    previewStatus = 400;
    await picker.setInputFiles(folder);
    await expect(dialog.locator('.notice[role="alert"]')).toContainText("项目配置或 Dump 导致数据校验失败");
    await expect(dialog.getByLabel("导入校验详情")).toContainText("signals / 直流电压：信号编号与已有记录重复");
    await expect(dialog.getByRole("button", { name: /^覆盖项目配置/ })).toHaveCount(0);
    previewStatus = 200;
    response = { ...response, replace_data: false, token: "folder-config-preview" };
    commitStatus = 200;
    await picker.setInputFiles(folder);
    await expect(dialog.getByLabel("导入校验详情")).toHaveCount(0);
    await dialog.getByRole("button", { name: "覆盖项目配置，保留点表数据", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText("项目配置已导入，现有点表数据已保留");
    await expect(page.getByLabel("当前项目")).toHaveValue(String(pid));
    const after = await (await page.request.get(`/api/projects/${pid}/topology`)).json();
    expect(after).toEqual(before);
    console.log("PASS: folder import preserves relative paths, distinguishes optional Dump replacement, clears stale/invalid previews and refreshes selection after success; browser checks do not change point data");
  } finally {
    await page.unroute(previewPath, previewHandler);
    await page.unroute(commitPath, commitHandler);
    fs.rmSync(temporary, { recursive: true, force: true });
    if (await dialog.isVisible()) await dialog.getByRole("button", { name: "取消", exact: true }).click();
  }
}
