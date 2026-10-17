import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "../frontend/node_modules/typescript/lib/typescript.js";
import { effectScope, nextTick, ref } from "../frontend/node_modules/vue/index.mjs";

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function compile(path) {
  return ts.transpileModule(
    await readFile(new URL(path, import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
}
const domainUrl = moduleUrl(await compile("../frontend/src/domain/editLock.ts"));
const { editLockFailure, isProjectLockState } = await import(domainUrl);
for (const [cause, kind, hint] of [
  [{ status: 404, details: { error: "API 不存在" } }, "backend-version", "重启服务"],
  [{ status: 404, message: "请求失败 (404)" }, "backend-version", "更新后端"],
  [{ status: 404, message: "记录不存在或不可访问" }, "request", "项目列表"],
  [{ status: 401 }, "session", "重新登录"],
  [{ status: 403 }, "permission", "板卡和协议授权"],
  [{ status: 500, details: { error: "数据库操作失败，请查看服务端日志" } }, "database", "迁移"],
  [{ status: 500 }, "server", "500"],
  [{ status: 502 }, "server", "502"],
  [{ status: 503 }, "server", "503"],
  [{ status: 429 }, "request", "429"],
  [{ status: 200, details: { code: "INVALID_EDIT_LOCK_RESPONSE" } }, "response", "代理配置"],
  [new TypeError("Failed to fetch"), "network", "检查网络"],
]) {
  const failure = editLockFailure(cause);
  assert.equal(failure.kind, kind);
  assert.ok(failure.message.includes(hint));
  if (kind !== "session") assert.ok(failure.message.includes("草稿保留"));
}
assert.equal(editLockFailure({ status: 401 }).retryable, false);
const empty = { locked: false, owned: false, owner: null, expires_at: null, lease_seconds: 120 };
const owned = {
  locked: true, owned: true,
  owner: { id: 1, display_name: "工程师", username: "engineer" },
  expires_at: new Date(Date.now() + 120_000).toISOString(), lease_seconds: 120,
};
assert.ok(isProjectLockState(empty));
assert.ok(isProjectLockState(owned));
for (const value of [null, {}, { error: "请求失败 (200)" }, { ...empty, owned: true }, { ...owned, expires_at: "invalid" }, { ...owned, owner: null }])
  assert.equal(isProjectLockState(value), false);

const harness = globalThis.__editLockTest = { requests: [], mounted: [], cleanup: [] };
const vueUrl = new URL("../frontend/node_modules/vue/index.mjs", import.meta.url).href;
const hooksUrl = moduleUrl(`
  export { computed, ref, watch } from ${JSON.stringify(vueUrl)};
  export const onMounted = fn => globalThis.__editLockTest.mounted.push(fn);
  export const onBeforeUnmount = fn => globalThis.__editLockTest.cleanup.push(fn);
`);
const apiUrl = moduleUrl(`
  export class ApiError extends Error {
    constructor(message, status, details = {}) { super(message); this.status = status; this.details = details; }
  }
  export const api = (path, method = 'GET', body) => new Promise((resolve, reject) =>
    globalThis.__editLockTest.requests.push({ path, method, body, resolve, reject }));
`);
const { ApiError } = await import(apiUrl);
const source = (await compile("../frontend/src/composables/useProjectEditLock.ts"))
  .replace('"vue"', JSON.stringify(hooksUrl))
  .replace('"../api"', JSON.stringify(apiUrl))
  .replace('"../domain/editLock"', JSON.stringify(domainUrl));
const { useProjectEditLock } = await import(moduleUrl(source));
globalThis.window = new EventTarget();
const pid = ref(1), user = ref({ id: 1 }), eligible = ref(true), notices = [];
let acquisitions = 0;
const scope = effectScope();
const lock = scope.run(() => useProjectEditLock({
  pid, user, eligible,
  notify: (message) => notices.push(message),
  acquired: () => acquisitions++,
}));
function request(path, method = "GET") {
  const request = harness.requests.shift();
  assert.ok(request, `request expected: ${path}`);
  assert.equal(request.path, path);
  assert.equal(request.method, method);
  return request;
}
async function settled() { await nextTick(); await Promise.resolve(); await Promise.resolve(); }
try {
  for (const mounted of harness.mounted) mounted();
  assert.equal(lock.checking.value, true);
  request("/projects/1/edit-lock").reject(new ApiError("API 不存在", 404, { error: "API 不存在" }));
  await settled();
  assert.equal(lock.owned.value, false);
  assert.equal(lock.failure.value.kind, "backend-version");
  assert.equal(lock.checking.value, false);

  const retry = lock.retry();
  assert.equal(lock.checking.value, true);
  request("/projects/1/edit-lock").resolve(empty);
  await retry;
  assert.equal(lock.failure.value, null);
  const acquire = lock.acquire();
  request("/projects/1/edit-lock/acquire", "POST").resolve(owned);
  await acquire;
  assert.equal(lock.owned.value, true);
  assert.equal(acquisitions, 1);

  const failedRenew = lock.sync(true);
  request("/projects/1/edit-lock/renew", "POST").reject(new TypeError("Failed to fetch"));
  await failedRenew;
  assert.equal(lock.owned.value, false, "uncertain lease must always disable editing");
  assert.equal(lock.failure.value.kind, "network");
  const recover = lock.retry();
  request("/projects/1/edit-lock").resolve(owned);
  await recover;
  assert.equal(lock.owned.value, true);
  assert.equal(lock.failure.value, null);

  const stale = lock.sync();
  const staleRequest = request("/projects/1/edit-lock");
  pid.value = 2;
  await settled();
  request("/projects/2/edit-lock").resolve(empty);
  await settled();
  staleRequest.resolve(owned);
  await stale;
  assert.equal(lock.owned.value, false, "old project response cannot restore editing");
  assert.deepEqual(lock.state.value, empty);

  const malformed = lock.retry();
  request("/projects/2/edit-lock").resolve({ error: "请求失败 (200)" });
  await malformed;
  assert.equal(lock.owned.value, false);
  assert.equal(lock.failure.value.kind, "response");

  const restore = lock.retry();
  request("/projects/2/edit-lock").resolve(owned);
  await restore;
  window.dispatchEvent(new CustomEvent("project-edit-lock", { detail: { pid: 2 } }));
  assert.equal(lock.owned.value, false, "successful commit immediately relinquishes local editing");
  request("/projects/2/edit-lock").resolve(empty);
  await settled();
  assert.equal(harness.requests.length, 0);
} finally {
  for (const cleanup of harness.cleanup) cleanup();
  scope.stop();
  delete globalThis.__editLockTest;
}
console.log("Edit-lock failures, recovery, malformed responses, project races, and commit release passed");
