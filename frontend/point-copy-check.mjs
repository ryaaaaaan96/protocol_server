import { expect } from "@playwright/test";
import { openRowAction } from "./point-menus-check.mjs";

// Copy uses the real browser clipboard; the caller supplies an isolated API fixture.
export async function checkPointCopy(page, data) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  const row = id => page.locator(`.point-table tbody tr[data-row-id="${id}"]`);
  const bar = page.locator(".point-grid-selection-bar");
  const readCopy = async (trigger, expected, width = data.definition.columns.length) => {
    const sentinel = "browser clipboard sentinel";
    await page.evaluate(value => navigator.clipboard.writeText(value), sentinel);
    await trigger();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe(sentinel);
    const lines = (await page.evaluate(() => navigator.clipboard.readText())).split(/\r?\n/);
    expect(lines).toHaveLength(expected.length);
    for (const [index, record] of expected.entries()) {
      expect(lines[index].split("\t")).toHaveLength(width);
      expect(lines[index].startsWith(`${record.name}\t`)).toBe(true);
    }
  };
  await readCopy(() => openRowAction(page, row(data.rows[0].id), "复制此行"), [data.rows[0]]);
  await page.getByRole("checkbox", { name: "选择当前页", exact: true }).check();
  await expect(bar).toContainText("已选择 2 行");
  await readCopy(() => bar.getByRole("button", { name: "复制选中行", exact: true }).click(), data.rows);
  await bar.getByRole("button", { name: "取消选择", exact: true }).click();
  await row(data.rows[0].id).locator('[data-column-key="name"]').click();
  await row(data.rows[1].id).locator('[data-column-key="enum_name"]').click({ modifiers: ["Shift"] });
  await expect(bar).toContainText("2 行 × 4 列");
  await readCopy(() => bar.getByRole("button", { name: "复制选区", exact: true }).click(), data.rows, 4);
  await bar.getByRole("button", { name: "取消选择", exact: true }).click();
  await expect(page.locator(".point-grid-draft")).toHaveCount(0);
  console.log("PASS: real clipboard copies a row, selected rows and a cell rectangle without creating records");
}
