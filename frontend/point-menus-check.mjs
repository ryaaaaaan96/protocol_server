import { expect } from "@playwright/test";

export async function openRowAction(page, row, action = "记录详情") {
  await row.getByRole("button", { name: /^记录操作 / }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

export async function openColumnMenu(page, key, activation = "rightclick", scope = page) {
  const header = key
    ? scope.locator(`.point-table thead th[data-column-key="${key}"]`)
    : scope.locator(".point-table thead th[data-column-key]").first();
  if (activation === "keyboard") {
    await header.focus();
    await header.press("Shift+F10");
  } else if (activation === "touch") {
    await header.getByRole("button", { name: /列菜单$/ }).click();
  } else {
    await header.click({ button: "right" });
  }
  await expect(page.getByRole("menu")).toBeVisible();
}

export async function openPointColumns(page, scope = page) {
  await openColumnMenu(page, undefined, "rightclick", scope);
  await page.getByRole("menuitem", { name: "列设置…", exact: true }).click();
}
