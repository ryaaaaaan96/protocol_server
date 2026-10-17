import { expect } from "@playwright/test";
import { openColumnMenu, openPointColumns, openRowAction } from "./point-menus-check.mjs";
import { ensureProjectEditing, fulfillSuccessfulCommit } from "./project-edit-lock-check.mjs";

const rows = page => page.locator(".point-table tbody tr[data-row-id]");
const cell = (page, id, key) => page.locator(`.point-table tr[data-row-id="${id}"] td[data-column-key="${key}"]`);
const draft = page => page.locator(".point-grid-draft");
const editor = (page, label) => page.getByLabel(`编辑 ${label}`, { exact: true });

async function paste(target, text) {
  await target.click();
  await target.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    element.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData,
      bubbles: true,
      cancelable: true,
    }));
  }, text);
}

async function discard(page) {
  const accept = dialog => dialog.accept();
  page.on("dialog", accept);
  try {
    await draft(page).getByRole("button", { name: "放弃修改", exact: true }).click();
  } finally {
    page.off("dialog", accept);
  }
  await expect(draft(page)).toHaveCount(0);
}

async function changeText(page, id, key, label, value, finish = "Enter") {
  await cell(page, id, key).dblclick();
  const input = editor(page, label);
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press(finish);
}

async function configureColumns(page, definition, visible) {
  await openPointColumns(page);
  const panel = page.locator("dialog");
  if (visible) {
    for (const key of definition.columns) {
      const field = definition.fields[key];
      await panel.getByLabel(`显示 ${field.column_label || field.label}`, { exact: true }).setChecked(visible.includes(key));
    }
  } else {
    await panel.getByRole("button", { name: "恢复默认", exact: true }).click();
  }
  await panel.getByRole("button", { name: "应用", exact: true }).click();
  await expect(panel).toHaveCount(0);
}

// Standalone checks must retain the draft and lease, including invalid changes.
export async function checkPointGridCheckOnly(page, { pid, modelId }) {
  await ensureProjectEditing(page);
  const dataUrl = `/api/projects/${pid}/board-models/${modelId}/point-tables/process`;
  const before = await (await page.request.get(dataUrl)).json();
  const first = before.rows[0];
  const numericId = before.rows.slice(0, 50).find(row => !row.edit_values.sig_symbol);
  expect(numericId).toBeTruthy();
  const changedName = `${first.name} 独立检查`;
  const commits = [];
  const track = request => {
    if (request.method() === "POST" && /\/changes\/[^/]+\/commit$/.test(request.url())) commits.push(request.url());
  };
  const assertUnchanged = async () => {
    const current = await (await page.request.get(dataUrl)).json();
    expect(current.rows).toEqual(before.rows);
    expect(current.revision).toBe(before.revision);
    const lease = await (await page.request.get(`/api/projects/${pid}/edit-lock`)).json();
    expect(lease.owned).toBe(true);
    expect(lease.locked).toBe(true);
    expect(commits).toEqual([]);
  };
  const check = async allowed => {
    const response = page.waitForResponse(response => response.url().endsWith(`${dataUrl}/batch/preview`));
    await draft(page).getByRole("button", { name: "检查", exact: true }).click();
    const result = await (await response).json();
    expect(result.allowed).toBe(allowed);
    const panel = page.locator("dialog").last();
    await expect(panel.getByRole("button", { name: "继续编辑", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "确认提交", exact: true })).toHaveCount(0);
    if (result.validation) {
      await expect(panel).toContainText(`${result.validation.errors} 条错误、${result.validation.warnings} 条提示`);
      if (result.validation.issues?.length) {
        const details = panel.locator("details");
        await details.locator("summary").click();
        await expect(details.locator("article")).toHaveCount(Math.min(200, result.validation.issues.length));
        await expect(details.locator("article").first()).toContainText(result.validation.issues[0].message);
        await details.locator("summary").click();
      }
    }
    await assertUnchanged();
    return { result, panel };
  };
  page.on("request", track);
  try {
    await changeText(page, first.id, "name", "信号名称", changedName);
    let { panel } = await check(true);
    await expect(panel).toContainText("检查通过");
    await page.screenshot({ path: "../.runtime/point-grid-check-only-valid.png", fullPage: true });
    await panel.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(cell(page, first.id, "name")).toHaveText(changedName);
    await expect(draft(page)).toContainText("1 行 · 1 处修改");

    await changeText(page, numericId.id, "resolved_sig_id", before.definition.fields.sig_id.label, "1.5");
    const invalid = await check(false);
    expect(invalid.result.errors.some(error => error.field === "sig_id")).toBe(true);
    await expect(invalid.panel).toContainText(before.definition.fields.sig_id.label);
    await page.screenshot({ path: "../.runtime/point-grid-check-only-invalid.png", fullPage: true });
    await invalid.panel.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(cell(page, numericId.id, "resolved_sig_id")).toHaveText("1.5");
    await draft(page).getByRole("button", { name: "撤销", exact: true }).click();
    await expect(draft(page)).toContainText("1 行 · 1 处修改");
    await assertUnchanged();

    const preview = page.waitForResponse(response => response.url().endsWith(`${dataUrl}/batch/preview`));
    await draft(page).getByRole("button", { name: "检查并保存", exact: true }).click();
    expect((await (await preview).json()).allowed).toBe(true);
    await expect(page.locator("dialog").getByRole("button", { name: "确认提交", exact: true })).toBeEnabled();
    expect(commits).toEqual([]);
    const commitRoute = `**/api/projects/${pid}/changes/*/commit`;
    const accept = route => fulfillSuccessfulCommit(page, route, pid, { revision: before.revision + 1 });
    await page.route(commitRoute, accept);
    try {
      await page.locator("dialog").getByRole("button", { name: "确认提交", exact: true }).click();
      await expect(page.locator("dialog")).toHaveCount(0);
      await expect(draft(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "开始编辑", exact: true })).toBeEnabled();
      expect(commits).toHaveLength(1);
      const current = await (await page.request.get(dataUrl)).json();
      expect(current.rows).toEqual(before.rows);
      expect(current.revision).toBe(before.revision);
    } finally {
      await page.unroute(commitRoute, accept);
    }
  } finally {
    page.off("request", track);
  }
  console.log("PASS: independent valid/invalid checks preserve drafts, lease and stored data without commit; returning to the intercepted save flow still works");
}

// Exercise actual preview validation; every commit below is intercepted.
export async function checkPointGrid(page, { pid, modelId }) {
  await checkPointGridCheckOnly(page, { pid, modelId });
  await ensureProjectEditing(page);
  const dataUrl = `/api/projects/${pid}/board-models/${modelId}/point-tables/process`;
  const before = await (await page.request.get(dataUrl)).json();
  const [first, second] = before.rows;
  const firstCell = cell(page, first.id, "name");
  const secondCell = cell(page, second.id, "name");
  await expect(rows(page).first()).toHaveAttribute("data-row-id", String(first.id));
  await expect(page.locator(".point-table table")).toHaveAttribute("role", "grid");
  await firstCell.click();
  await expect(firstCell).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.locator(".point-cell-editor")).toHaveCount(0);
  await firstCell.press("Enter");
  await expect(editor(page, "信号名称")).toHaveValue(first.name);
  await editor(page, "信号名称").fill("应被 Escape 取消的临时输入");
  await editor(page, "信号名称").press("Escape");
  await expect(firstCell).toHaveText(first.name);
  await expect(draft(page)).toHaveCount(0);
  await firstCell.press("ArrowDown");
  await expect(secondCell).toHaveAttribute("aria-selected", "true");
  await secondCell.press("ArrowUp");
  await expect(firstCell).toHaveAttribute("aria-selected", "true");

  // Computed/shared values cannot silently become writable columns.
  const computedCell = cell(page, first.id, "unit");
  await computedCell.dblclick();
  await expect(page.locator(".point-cell-editor")).toHaveCount(0);
  await computedCell.press("Enter");
  await expect(page.locator(".point-cell-editor")).toHaveCount(0);
  await paste(firstCell, "不能部分写入的名称\t不存在的点表分组");
  await expect(page.getByRole("alert")).toContainText("未粘贴任何数据");
  await expect(firstCell).toHaveText(first.name);
  await expect(draft(page)).toHaveCount(0);

  const inherited = before.rows.slice(0, 50).find(row => row.data_type !== "STRING" && row.edit_values.min_value == null);
  if (inherited) {
    await cell(page, inherited.id, "min_value").dblclick();
    await expect(editor(page, "下限覆盖")).toHaveValue("");
    await editor(page, "下限覆盖").press("Escape");
    await expect(draft(page)).toHaveCount(0);
  }

  const changedNames = [`${first.name} 网格检查`, `${second.name} 网格检查`];
  const writes = [];
  const track = request => { if (request.method() === "POST" && !request.url().includes("/edit-lock/")) writes.push(request.url()); };
  page.on("request", track);
  await changeText(page, first.id, "name", "信号名称", changedNames[0], "Tab");
  await expect(cell(page, first.id, before.definition.columns[1])).toHaveAttribute("aria-selected", "true");
  await changeText(page, second.id, "name", "信号名称", changedNames[1]);
  await expect(draft(page)).toContainText("2 行 · 2 处修改");
  await expect(firstCell).toHaveText(changedNames[0]);
  await expect(secondCell).toHaveText(changedNames[1]);
  await expect(page.locator("dialog")).toHaveCount(0);
  let warned = false;
  const stay = dialog => { warned = true; return dialog.dismiss(); };
  page.on("dialog", stay);
  try {
    await page.getByRole("button", { name: "选择 CSU 板卡", exact: true }).click();
  } finally {
    page.off("dialog", stay);
  }
  expect(warned).toBe(true);
  await expect(page.getByRole("button", { name: "选择 DSP 板卡", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(draft(page)).toContainText("2 行 · 2 处修改");
  await page.waitForTimeout(400);
  page.off("request", track);
  expect(writes).toEqual([]);
  await draft(page).getByRole("button", { name: "撤销", exact: true }).click();
  await expect(secondCell).toHaveText(second.name);
  await expect(draft(page)).toContainText("1 行 · 1 处修改");
  await draft(page).getByRole("button", { name: "重做", exact: true }).click();
  await expect(secondCell).toHaveText(changedNames[1]);
  await openColumnMenu(page, "unit");
  await page.getByRole("menuitem", { name: "隐藏此列", exact: true }).click();
  await expect(draft(page)).toContainText("2 行 · 2 处修改");
  await expect(firstCell).toHaveText(changedNames[0]);
  await openColumnMenu(page, "name");
  await page.getByRole("menuitem", { name: "恢复默认列", exact: true }).click();
  await expect(secondCell).toHaveText(changedNames[1]);
  await page.locator(".point-table").evaluate(element => { element.scrollLeft = 0; });
  await page.screenshot({ path: "../.runtime/point-grid-editing.png", fullPage: true });

  const previewPath = `${dataUrl}/batch/preview`;
  const review = async () => {
    const responsePromise = page.waitForResponse(response => response.url().endsWith(previewPath));
    await draft(page).getByRole("button", { name: "检查并保存", exact: true }).click();
    const response = await responsePromise;
    const payload = response.request().postDataJSON();
    expect(payload.operation).toBe("update");
    expect(payload.revision).toBe(before.revision);
    expect(payload.rows).toHaveLength(2);
    for (const [index, original] of [first, second].entries()) {
      const proposed = payload.rows.find(row => row.id === original.id);
      expect(proposed).toBeTruthy();
      expect(proposed.values).toEqual({ name: changedNames[index] });
      expect(proposed.expected).toMatchObject(Object.fromEntries(
        Object.entries(original.edit_values).filter(([key]) => before.definition.editor.includes(key)),
      ));
    }
    expect((await response.json()).allowed).toBe(true);
    await expect(page.locator("dialog")).toContainText("关联检查通过");
  };
  await review();
  await page.screenshot({ path: "../.runtime/point-grid-preview.png", fullPage: true });
  const commitRoute = `**/api/projects/${pid}/changes/*/commit`;
  for (const [status, json] of [
    [500, { error: "网格检查：保存失败，请重试" }],
    [409, {
      error: "网格检查：相同字段已被其他成员修改，草稿尚未保存",
      code: "REVISION_CONFLICT",
      expected_revision: before.revision,
      current_revision: before.revision + 1,
    }],
  ]) {
    const rejectCommit = route => route.fulfill({ status, json });
    await page.route(commitRoute, rejectCommit);
    try {
      await page.getByRole("button", { name: "确认提交", exact: true }).click();
      await expect(page.locator(".toast.error")).toContainText(json.error);
      await expect(firstCell).toHaveText(changedNames[0]);
      await expect(secondCell).toHaveText(changedNames[1]);
      await expect(draft(page)).toContainText("2 行 · 2 处修改");
      const back = page.locator("dialog").getByRole("button", { name: "返回调整", exact: true });
      if (await back.count()) await back.click();
    } finally {
      await page.unroute(commitRoute, rejectCommit);
    }
    await review();
  }
  const acceptCommit = route => fulfillSuccessfulCommit(page, route, pid, { merged: true, revision: before.revision + 1 });
  await page.route(commitRoute, acceptCommit);
  try {
    await page.getByRole("button", { name: "确认提交", exact: true }).click();
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(draft(page)).toHaveCount(0);
    await expect(firstCell).toHaveText(first.name);
    await expect(secondCell).toHaveText(second.name);
    await expect(page.getByRole("button", { name: "开始编辑", exact: true })).toBeEnabled();
  } finally {
    await page.unroute(commitRoute, acceptCommit);
  }
  await ensureProjectEditing(page);

  // Paste is aligned to visible columns, with one undo entry for the rectangle.
  await configureColumns(page, before.definition, ["name", "enum_name"]);
  const pasted = [
    [`${first.name} 粘贴`, `GRID_CHECK_${first.id}`],
    [`${second.name} 粘贴`, `GRID_CHECK_${second.id}`],
  ];
  await paste(firstCell, pasted.map(row => row.join("\t")).join("\r\n"));
  await expect(draft(page)).toContainText("2 行 · 4 处修改");
  for (const [index, original] of [first, second].entries()) {
    await expect(cell(page, original.id, "name")).toHaveText(pasted[index][0]);
    await expect(cell(page, original.id, "enum_name")).toHaveText(pasted[index][1]);
  }
  await expect(page.locator('.point-table td[aria-selected="true"]')).toHaveCount(4);
  const copied = await cell(page, second.id, "enum_name").evaluate(element => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData("text/plain");
  });
  expect(copied).toBe(pasted.map(row => row.join("\t")).join("\r\n"));
  await page.screenshot({ path: "../.runtime/point-grid-paste.png", fullPage: true });
  await draft(page).getByRole("button", { name: "撤销", exact: true }).click();
  await expect(firstCell).toHaveText(first.name);
  await expect(secondCell).toHaveText(second.name);
  // Redo must remain reachable even when undo removed the last draft.
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(draft(page)).toContainText("2 行 · 4 处修改");
  await discard(page);
  await expect(firstCell).toHaveText(first.name);
  await configureColumns(page, before.definition);
  const after = await (await page.request.get(dataUrl)).json();
  expect(after.revision).toBe(before.revision);
  expect(after.rows).toEqual(before.rows);
  console.log("PASS: grid keyboard editing, raw inherited values, local drafts, undo/redo, rectangular paste, batch preview and draft preservation after failures");
}

export async function checkPointStringRanges(page, { pid, modelId }) {
  await ensureProjectEditing(page);
  const url = `/api/projects/${pid}/board-models/${modelId}/point-tables/process`;
  const before = await (await page.request.get(url)).json();
  const firstPage = before.rows.slice(0, 50);
  const stringRow = firstPage.find(row => row.data_type === "STRING");
  const numericRow = firstPage.find(row => row.data_type !== "STRING");
  expect(stringRow).toBeTruthy();
  expect(numericRow).toBeTruthy();
  for (const key of ["min_value", "max_value"]) {
    const value = cell(page, stringRow.id, key);
    await expect(value).toHaveText("—");
    await expect(value).toHaveAttribute("aria-readonly", "true");
    await value.dblclick();
    await expect(page.locator(".point-cell-editor")).toHaveCount(0);
    await paste(value, "123");
    await expect(page.getByRole("alert")).toContainText("未粘贴任何数据");
    await expect(value).toHaveText("—");
    await expect(draft(page)).toHaveCount(0);
  }
  const row = id => page.locator(`.point-table tbody tr[data-row-id="${id}"]`);
  const close = () => page.locator("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await openRowAction(page, row(stringRow.id));
  await expect(page.getByLabel("下限覆盖", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("上限覆盖", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("默认值覆盖", { exact: true })).toBeVisible();
  await close();
  await openRowAction(page, row(numericRow.id));
  await expect(page.getByLabel("下限覆盖", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("上限覆盖", { exact: true })).toBeEnabled();
  await close();
  for (const [key, label] of [["min_value", "下限覆盖"], ["max_value", "上限覆盖"]]) {
    const value = cell(page, numericRow.id, key);
    await expect(value).toHaveAttribute("aria-readonly", "false");
    await value.dblclick();
    await expect(editor(page, label)).toHaveValue(String(numericRow.edit_values[key] ?? ""));
    await editor(page, label).press("Escape");
  }
  await expect(draft(page)).toHaveCount(0);
  const after = await (await page.request.get(url)).json();
  expect(after.rows).toEqual(before.rows);
  expect(after.revision).toBe(before.revision);
  console.log("PASS: STRING bounds are inapplicable in cells, paste and record details; numeric bounds remain editable without changing stored data");
}

export async function checkPointGridMappings(page, { pid, modelId }) {
  await ensureProjectEditing(page);
  const base = `/api/projects/${pid}/board-models/${modelId}/point-tables/collect`;
  const data = await (await page.request.get(base)).json();
  const id = Number(await rows(page).first().getAttribute("data-row-id"));
  const original = data.rows.find(row => row.id === id);
  const values = original.edit_values;
  const currentContext = data.options.contexts.find(context => context.id === values.context_id);
  const endpoint = data.options.endpoints.find(item => item.id === values.endpoint_id);
  const choices = async label => (await editor(page, label).locator("option").evaluateAll(options => options.map(option => option.value))).filter(Boolean).map(Number);
  for (const [key, label, ids] of [
    ["signal_name", "本地内部信号", data.options.signals.filter(signal => signal.group_id === currentContext.group_id).map(signal => signal.id)],
    ["endpoint_name", "协议端点", data.options.endpoints.filter(item => item.role === "client").map(item => item.id)],
    ["field_name", "协议字段", data.options.fields.filter(field => field.contract_id === endpoint.contract_id).map(field => field.id)],
  ]) {
    await cell(page, id, key).dblclick();
    await expect(editor(page, label)).toBeVisible();
    expect(await choices(label)).toEqual(ids);
    await editor(page, label).press("Escape");
  }
  const nextContext = data.options.contexts.find(context => context.group_id != null && context.group_id !== currentContext.group_id);
  if (nextContext) {
    await cell(page, id, "context_name").dblclick();
    await editor(page, "逻辑设备").selectOption(String(nextContext.id));
    if (await editor(page, "逻辑设备").count()) await editor(page, "逻辑设备").press("Enter");
    await expect(draft(page)).toContainText("1 行 · 2 处修改");
    await cell(page, id, "signal_name").dblclick();
    await expect(editor(page, "本地内部信号")).toHaveValue("");
    expect(await choices("本地内部信号")).toEqual(data.options.signals.filter(signal => signal.group_id === nextContext.group_id).map(signal => signal.id));
    await editor(page, "本地内部信号").press("Escape");
    await discard(page);
  }
  await expect(draft(page)).toHaveCount(0);
  expect((await (await page.request.get(base)).json()).revision).toBe(data.revision);
  console.log("PASS: inline mapping choices respect endpoint roles, contracts and signal groups; changing context clears incompatible signal");
}

export async function checkReadonlyGrid(page) {
  const first = rows(page).first().locator('td[data-column-key="name"]');
  const original = await first.textContent();
  const writes = [];
  const track = request => { if (request.method() === "POST" && !request.url().includes("/edit-lock/")) writes.push(request.url()); };
  page.on("request", track);
  try {
    await first.dblclick();
    await expect(page.locator(".point-cell-editor")).toHaveCount(0);
    await first.press("Enter");
    await expect(page.locator(".point-cell-editor")).toHaveCount(0);
    await paste(first, "只读用户不能粘贴修改");
    await expect(first).toHaveText(original);
    await expect(draft(page)).toHaveCount(0);
    await openPointColumns(page);
    await expect(page.locator("dialog").getByLabel("显示 信号名称", { exact: true })).toBeEnabled();
    await page.locator("dialog").getByRole("button", { name: "取消", exact: true }).click();
    expect(writes).toEqual([]);
  } finally {
    page.off("request", track);
  }
  console.log("PASS: viewer grid selection does not expose editors, accept pastes or send mutation requests");
}
