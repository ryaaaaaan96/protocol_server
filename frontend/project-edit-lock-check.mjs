import { expect } from "@playwright/test";

const acquired = new WeakMap();
const requestHeaders = { "X-Requested-With": "protocol-studio" };

export async function ensureProjectEditing(page) {
  const start = page.getByRole("button", { name: "开始编辑", exact: true });
  const end = page.getByRole("button", { name: "结束编辑", exact: true });
  await expect(start.or(end)).toBeVisible();
  if (await start.count()) {
    await expect(start).toBeEnabled();
    await start.click();
    const pid = await page.getByLabel("当前项目").inputValue();
    if (!acquired.has(page)) acquired.set(page, new Set());
    acquired.get(page).add(pid);
  }
  await expect(end).toBeVisible();
}

// An intercepted successful commit must mimic the real atomic lock release.
export async function fulfillSuccessfulCommit(page, route, pid, json) {
  const release = await page.request.post(`/api/projects/${pid}/edit-lock/release`, {
    headers: requestHeaders,
    data: {},
  });
  expect(release.ok()).toBe(true);
  await route.fulfill({ json });
}

export async function cleanupProjectEditing(page) {
  for (const pid of acquired.get(page) || []) {
    const response = await page.request.get(`/api/projects/${pid}/edit-lock`);
    if (response.ok() && (await response.json()).owned) {
      const release = await page.request.post(`/api/projects/${pid}/edit-lock/release`, {
        headers: requestHeaders,
        data: {},
      });
      expect(release.ok()).toBe(true);
    }
  }
  acquired.delete(page);
}

export async function checkProjectEditLock(page, { pid }) {
  const nav = page.getByRole("navigation", { name: "项目与板卡导航" });
  const start = page.getByRole("button", { name: "开始编辑", exact: true });
  const end = page.getByRole("button", { name: "结束编辑", exact: true });
  const openDsp = async () => {
    await nav.getByRole("button", { name: "板卡内部信息", exact: true }).click();
    await page.getByRole("button", { name: "选择 DSP 板卡", exact: true }).click();
    await page.getByRole("tab", { name: /^DSP内部数据/ }).click();
    await expect(page.locator(".point-table table")).toHaveAttribute("aria-readonly", "true");
    await page.locator('.point-table tbody td[data-column-key="name"]').first().dblclick();
    await expect(page.locator(".point-cell-editor")).toHaveCount(0);
  };
  await expect(start).toBeEnabled();
  await expect(end).toHaveCount(0);
  await openDsp();
  const lockPath = `**/api/projects/${pid}/edit-lock`;
  const occupied = {
    locked: true,
    owned: false,
    owner: { id: 987654, username: "browser_occupied", display_name: "占用编辑者" },
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    lease_seconds: 120,
  };
  const blockedLock = route => route.fulfill({ json: occupied });
  await page.route(lockPath, blockedLock);
  try {
    await page.reload();
    await page.getByRole("heading", { name: "项目拓扑", exact: true }).waitFor();
    await expect(page.getByText(occupied.owner.display_name, { exact: false }).first()).toBeVisible();
    if (await start.count()) await expect(start).toBeDisabled();
    await expect(end).toHaveCount(0);
    await openDsp();
  } finally {
    await page.unroute(lockPath, blockedLock);
  }
  await page.reload();
  await page.getByRole("heading", { name: "项目拓扑", exact: true }).waitFor();
  await ensureProjectEditing(page);
  const lock = await (await page.request.get(`/api/projects/${pid}/edit-lock`)).json();
  expect(lock.owned).toBe(true);
  expect(lock.locked).toBe(true);
  console.log("PASS: project starts read-only, another editor's lock blocks editing, explicit acquisition grants edit mode");
}
