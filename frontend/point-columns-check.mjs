import { expect } from "@playwright/test";

export async function checkPointColumns(page, { pid, modelId }) {
  const base = `/api/projects/${pid}/board-models/${modelId}/point-tables`;
  const data = await (await page.request.get(`${base}/process`)).json();
  const keys = data.definition.columns;
  const label = key => data.definition.fields[key].column_label || data.definition.fields[key].label;
  const headers = () => page.locator(".point-table thead th[data-column-key]").evaluateAll(cells => cells.map(cell => cell.dataset.columnKey));
  const panel = () => page.locator("dialog").filter({ has: page.getByRole("heading", { name: "列设置", exact: true }) });
  const open = () => page.getByRole("button", { name: "列设置", exact: true }).click();
  const apply = () => panel().getByRole("button", { name: "应用", exact: true }).click();
  await expect.poll(headers).toEqual(keys);
  await open();
  await panel().getByLabel(`显示 ${label(keys[1])}`, { exact: true }).uncheck();
  await panel().getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(headers).toEqual(keys);

  await open();
  await panel().getByLabel(`显示 ${label(keys[1])}`, { exact: true }).uncheck();
  await panel().getByLabel(`冻结 ${label(keys[2])}`, { exact: true }).check();
  const item = key => panel().locator(`.point-column-item[data-column-key="${key}"]`);
  await item(keys[4]).locator(".column-drag-handle").dragTo(item(keys[3]));
  await item(keys[3]).getByRole("button", { name: `上移 ${label(keys[3])}`, exact: true }).click();
  await item(keys[3]).getByRole("button", { name: `下移 ${label(keys[3])}`, exact: true }).click();
  await apply();
  const expected = [keys[0], keys[2], keys[4], keys[3], ...keys.slice(5)];
  await expect.poll(headers).toEqual(expected);

  const scroll = page.locator(".point-table");
  await scroll.evaluate(el => { el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2; });
  await expect.poll(() => scroll.evaluate(el => {
    const row = el.querySelector("tbody tr");
    const number = row.querySelector(".row-number").getBoundingClientRect();
    const frozen = [...row.querySelectorAll(".point-frozen")].map(cell => cell.getBoundingClientRect());
    return Math.max(Math.abs(frozen[0].left - number.right), Math.abs(frozen[1].left - frozen[0].right));
  })).toBeLessThan(2);
  await expect(page.locator(".point-table tbody tr").first().getByRole("button", { name: "设置", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect.poll(headers).toEqual(expected);
  await expect(page.locator(".point-table thead .point-frozen")).toHaveCount(2);

  const forward = await (await page.request.get(`${base}/forward`)).json();
  await page.getByRole("tab", { name: /^转发点表/ }).click();
  await expect.poll(headers).toEqual(forward.definition.columns);
  await page.getByRole("tab", { name: /^DSP内部数据/ }).click();
  await expect.poll(headers).toEqual(expected);
  await open();
  for (const key of keys) await panel().getByLabel(`显示 ${label(key)}`, { exact: true }).uncheck();
  await expect(panel().getByRole("button", { name: "应用", exact: true })).toBeDisabled();
  await expect(panel().getByRole("alert")).toContainText("至少保留一列");
  await panel().getByRole("button", { name: "恢复默认", exact: true }).click();
  await apply();
  await expect.poll(headers).toEqual(keys);
  await expect(page.locator(".point-table thead .point-frozen")).toHaveCount(1);
  await scroll.evaluate(el => { el.scrollLeft = 0; });
  expect((await (await page.request.get(`${base}/process`)).json()).revision).toBe(data.revision);
  console.log("PASS: column visibility, drag/keyboard order, frozen offsets, persistence, per-table isolation, minimum visibility and defaults");
}
