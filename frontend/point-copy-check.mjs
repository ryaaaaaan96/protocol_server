import { expect } from "@playwright/test";
import { openRowAction } from "./point-menus-check.mjs";

// Read the browser's real clipboard; these checks never submit or duplicate records.
export async function checkPointCopy(page, { pid, modelId, readonly = false }) {
  const url = `/api/projects/${pid}/board-models/${modelId}/point-tables/process`;
  const before = await (await page.request.get(url)).json();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  const row = id => page.locator(`.point-table tbody tr[data-row-id="${id}"]`);
  const check = number => page.getByRole("checkbox", { name: new RegExp(`^选择第\\s*${number}\\s*行$`) });
  const bar = page.locator(".point-grid-selection-bar");
  const clear = async () => {
    if (await bar.count()) await bar.getByRole("button", { name: "取消选择", exact: true }).click();
    await expect(bar).toHaveCount(0);
  };
  const readCopy = async (trigger, expected, width = before.definition.columns.length) => {
    const sentinel = "protocol browser clipboard sentinel";
    await page.evaluate(value => navigator.clipboard.writeText(value), sentinel);
    await trigger();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(sentinel);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    const lines = text.split(/\r?\n/);
    expect(lines).toHaveLength(expected.length);
    for (const [index, record] of expected.entries()) {
      expect(lines[index].split("\t")).toHaveLength(width);
      expect(lines[index].startsWith(`${record.name}\t`)).toBe(true);
    }
    return text;
  };
  await expect(page.locator(".point-table .point-actions")).toHaveCount(0);
  await clear();
  await readCopy(() => openRowAction(page, row(before.rows[0].id), "复制此行"), [before.rows[0]]);
  await check(1).click();
  await check(3).click({ modifiers: ["Shift"] });
  for (const index of [1, 2, 3]) await expect(check(index)).toHaveAttribute("aria-checked", "true");
  await expect(bar).toContainText("已选择 3 行");
  await readCopy(() => bar.getByRole("button", { name: "复制选中行", exact: true }).click(), before.rows.slice(0, 3));
  if (!readonly) await page.screenshot({ path: "../.runtime/point-copy-multiple.png", fullPage: true });
  await check(2).click();
  await expect(check(2)).toHaveAttribute("aria-checked", "false");
  await expect(bar).toContainText("已选择 2 行");
  await readCopy(() => openRowAction(page, row(before.rows[0].id), "复制选中行"), [before.rows[0], before.rows[2]]);
  if (!readonly) {
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await check(51).click();
    await expect(bar).toContainText("已选择 3 行");
    await readCopy(() => bar.getByRole("button", { name: "复制选中行", exact: true }).click(), [before.rows[0], before.rows[2], before.rows[50]]);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await clear();
    await page.getByRole("checkbox", { name: "选择当前页", exact: true }).check();
    await expect(bar).toContainText("已选择 50 行");
    await readCopy(() => bar.getByRole("button", { name: "复制选中行", exact: true }).click(), before.rows.slice(0, 50));
    await page.getByRole("checkbox", { name: "选择当前页", exact: true }).uncheck();
    await expect(bar).toHaveCount(0);
  } else {
    await clear();
  }
  await row(before.rows[0].id).locator('td[data-column-key="name"]').click();
  await row(before.rows[1].id).locator('td[data-column-key="enum_name"]').click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("2 行 × 4 列");
  await readCopy(() => bar.getByRole("button", { name: "复制选区", exact: true }).click(), before.rows.slice(0, 2), 4);
  await clear();
  await expect(page.locator(".point-grid-draft")).toHaveCount(0);
  const after = await (await page.request.get(url)).json();
  expect(after.rows).toEqual(before.rows);
  expect(after.revision).toBe(before.revision);
  console.log(`PASS: ${readonly ? "viewer" : "editor"} real clipboard supports single rows, Shift ranges, nonadjacent rows${readonly ? "" : ", cross-page rows and the current page"}, and explicit rectangular copy without creating records`);
}
