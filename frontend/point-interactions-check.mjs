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

  await expect(page.getByLabel("保存方式", { exact: true })).toHaveCount(0);
  await record().first().click();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(tableRows().locator("input,select")).toHaveCount(0);
  await expect(tableRows().first().locator("td").last()).toHaveClass("point-actions");
  await expect(page.locator(".point-table th.point-actions .point-fixed-label")).toHaveText("固定");
  const colors = await tableRows().first().evaluate(row => ({
    action: getComputedStyle(row.querySelector(".point-actions")).backgroundColor,
    data: getComputedStyle(row.querySelector("[data-column-key]")).backgroundColor,
  }));
  expect(colors.action).not.toBe(colors.data);
  const scroll = page.locator(".point-table");
  const settings = () => tableRows().first().getByRole("button", { name: "设置", exact: true });
  const close = async () => {
    await page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
    await expect(page.locator("dialog")).toHaveCount(0);
  };
  const desktop = page.viewportSize();
  for (const viewport of [desktop, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await settings().scrollIntoViewIfNeeded();
    const overflow = await scroll.evaluate(el => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeGreaterThan(100);
    for (const fraction of [0, 0.5, 1]) {
      await scroll.evaluate((el, fraction) => { el.scrollLeft = (el.scrollWidth - el.clientWidth) * fraction; }, fraction);
      // The final column stays at the scroll viewport's right edge, at every offset.
      await expect.poll(() => scroll.evaluate(el => {
        const edge = el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
        return Math.abs(el.querySelector("tbody td.point-actions").getBoundingClientRect().right - edge);
      })).toBeLessThan(2);
      await expect(settings()).toBeInViewport();
      await settings().click();
      await expect(page.locator("dialog")).toContainText("编辑DSP内部数据");
      await close();
    }
  }
  await page.setViewportSize(desktop);
  await scroll.evaluate(el => { el.scrollLeft = 0; });
  const startSettings = async () => {
    await expect(record().first()).toHaveText(firstName);
    await settings().click();
    await page.getByLabel("信号名称", { exact: true }).fill(`${firstName} UI 检查`);
  };
  await startSettings();
  // Closing without confirmation preserves form input; editing sends no autosave/check requests.
  const writes = [];
  const track = request => { if (request.method() === "POST") writes.push(request.url()); };
  page.on("request", track);
  await page.waitForTimeout(900);
  page.off("request", track);
  expect(writes).toEqual([]);
  page.once("dialog", d => d.dismiss());
  await page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(page.getByLabel("信号名称", { exact: true })).toHaveValue(`${firstName} UI 检查`);
  await review();
  await expect(page.locator("dialog")).toContainText("关联变更预览");
  const commitRoute = `**/api/projects/${pid}/changes/*/commit`;
  for (const [status, json] of [
    [500, { error: "测试：保存失败" }],
    [409, { error: "名称或编号已存在" }],
  ]) {
    await page.route(commitRoute, route => route.fulfill({ status, json }));
    await confirm();
    await expect(page.locator(".toast.error")).toContainText(json.error);
    await expect(page.locator("dialog")).toBeVisible();
    await expect(page.getByLabel("信号名称", { exact: true })).toHaveValue(`${firstName} UI 检查`);
    await page.unroute(commitRoute);
    await review();
  }
  await page.route(commitRoute, route => route.fulfill({ status: 409, json: {
    error: "相同字段已被其他成员修改，本次修改未保存", code: "REVISION_CONFLICT",
    expected_revision: before.revision, current_revision: before.revision + 1,
  } }));
  await confirm();
  await expect(page.locator(".toast.error")).toContainText("本次修改未保存");
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(record().first()).toHaveText(firstName);
  await page.unroute(commitRoute);

  await startSettings();
  await review();
  await page.route(commitRoute, route => route.fulfill({ json: { merged: true, revision: before.revision + 1 } }));
  await confirm();
  await expect(page.locator(".toast:not(.error)")).toContainText("已自动合并");
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(record().first()).toHaveText(firstName);
  await page.unroute(commitRoute);
  const after = await (await page.request.get(dataUrl)).json();
  expect(after.revision).toBe(before.revision);
  expect(after.rows.map(r => r.id)).toEqual(before.rows.map(r => r.id));
  console.log("PASS: row ordering, fixed final actions on desktop/mobile, read-only cells, explicit settings/preview/commit, toasts and conflict rollback");
}
