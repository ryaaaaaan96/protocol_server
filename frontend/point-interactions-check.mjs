import { expect } from "@playwright/test";

// Real previews; intercepted commits leave the user's development project unchanged.
export async function checkPointInteractions(page, { pid, modelId, record, tableRows }) {
  const dataUrl = `/api/projects/${pid}/board-models/${modelId}/point-tables/process`;
  const before = await (await page.request.get(dataUrl)).json();
  const firstId = String(before.rows[0].id), secondId = String(before.rows[1].id);
  const firstName = before.rows[0].name;
  const review = () => page.getByRole("button", { name: "检查关联影响", exact: true }).click();
  const cancel = () => page.getByRole("button", { name: "取消修改", exact: true }).click();
  const confirm = () => page.getByRole("button", { name: "确认提交", exact: true }).click();
  const back = () => page.getByRole("button", { name: "返回调整", exact: true }).click();
  await expect(tableRows().first()).toHaveAttribute("data-row-id", firstId);
  await tableRows().first().locator(".drag-handle").dragTo(tableRows().nth(1));
  await expect(tableRows().first()).toHaveAttribute("data-row-id", secondId);
  await expect(page.getByLabel("搜索当前表格")).toBeDisabled();
  await review();
  await expect(page.locator("dialog")).toContainText("排序变更预览");
  await expect(page.locator("dialog")).toContainText("显示顺序");
  await back();
  await cancel();
  await expect(tableRows().first()).toHaveAttribute("data-row-id", firstId);
  await tableRows().first().locator(".drag-handle").press("ArrowDown");
  await expect(tableRows().first()).toHaveAttribute("data-row-id", secondId);
  await cancel();
  await tableRows().first().locator(".drag-handle").click();
  await page.getByLabel("组内目标位置").fill("51");
  await page.getByRole("button", { name: "移动", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(tableRows().first()).toHaveAttribute("data-row-id", firstId);
  await cancel();
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await page.getByLabel("搜索当前表格").fill(firstName);
  await expect(page.locator(".drag-handle").first()).toBeDisabled();
  await page.getByLabel("搜索当前表格").fill("");

  const startInline = async () => {
    await expect(record().first()).toHaveText(firstName);
    await record().first().click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.getByLabel("信号名称", { exact: true }).fill(`${firstName} UI 检查`);
  };
  await startInline();
  // Declining navigation preserves the draft.
  page.once("dialog", d => d.dismiss());
  await page.getByRole("tab", { name: /^转发点表/ }).click();
  await expect(page.getByLabel("信号名称", { exact: true })).toHaveValue(`${firstName} UI 检查`);
  await review();
  await expect(page.locator("dialog")).toContainText("单元格变更预览");
  const commitRoute = `**/api/projects/${pid}/changes/*/commit`;
  await page.route(commitRoute, route => route.fulfill({ status: 500, json: { error: "测试：保存失败" } }));
  await confirm();
  await expect(page.locator(".toast.error")).toContainText("测试：保存失败");
  await expect(page.locator("dialog")).toBeVisible();
  await back();
  await page.unroute(commitRoute);
  await review();
  // A business 409 (duplicate name) must preserve edits, not act as a revision conflict.
  await page.route(commitRoute, route => route.fulfill({ status: 409, json: { error: "名称或编号已存在" } }));
  await confirm();
  await expect(page.locator(".toast.error")).toContainText("名称或编号已存在");
  await expect(page.locator("dialog")).toBeVisible();
  await back();
  await page.unroute(commitRoute);
  await review();
  await page.route(commitRoute, route => route.fulfill({ status: 409, json: {
    error: "相同字段已被其他成员修改，本次修改未保存", code: "REVISION_CONFLICT",
    expected_revision: before.revision, current_revision: before.revision + 1,
  } }));
  await confirm();
  await expect(page.locator(".toast.error")).toContainText("本次修改未保存");
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator(".point-draft-bar")).toHaveCount(0);
  await expect(record().first()).toHaveText(firstName);
  await page.unroute(commitRoute);

  await startInline();
  await review();
  await page.route(commitRoute, route => route.fulfill({ json: { merged: true, revision: before.revision + 1 } }));
  await confirm();
  await expect(page.locator(".toast:not(.error)")).toContainText("已自动合并");
  await expect(page.locator(".point-draft-bar")).toHaveCount(0);
  await expect(record().first()).toHaveText(firstName);
  await page.unroute(commitRoute);
  const after = await (await page.request.get(dataUrl)).json();
  expect(after.revision).toBe(before.revision);
  expect(after.rows.map(r => r.id)).toEqual(before.rows.map(r => r.id));
  console.log("PASS: native drag, keyboard and cross-page order, inline edit, dirty guard, success/failure toasts and conflict rollback");
}
