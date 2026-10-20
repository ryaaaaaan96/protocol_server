// Generic graph checks; no credentials, backend or database are used.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../config/dc-ups/project.json", import.meta.url), "utf8"));
const compiled = ts.transpileModule(await readFile(new URL("./src/domain/project.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { boardTypes, typeMounts } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const shared = {
  version: 3,
  board_types: ["A", "B", "C", "D"].map(code => ({ code, name: code, model_code: code })),
  roots: [{ type: "A", quantity: 2 }, { type: "B", quantity: 1 }],
  mounts: [
    { parent: "A", child: "C", quantity: 3, connections: [] },
    { parent: "B", child: "C", quantity: 6, connections: [] },
    { parent: "C", child: "D", quantity: 4, connections: [] },
  ],
};
const legacy = {
  version: 1,
  board_types: ["ROOT", "CHILD"].map(code => ({ code, name: code })),
  root: { type: "ROOT", quantity: 2 },
  mounts: [{ parent: "ROOT", child: "CHILD", quantity: 3, protocol: "UPP", transport: "CAN" }],
};
assert.deepEqual(boardTypes({ project_config: shared }).map(board => board.quantity), [2, 1, 6, 24]);
const named = structuredClone(shared);
const names = { A: "constructor", B: "__proto__", C: "toString", D: "hasOwnProperty" };
for (const board of named.board_types) board.code = names[board.code];
for (const entry of named.roots) entry.type = names[entry.type];
for (const link of named.mounts) { link.parent = names[link.parent]; link.child = names[link.child]; }
assert.deepEqual(boardTypes({ project_config: named }).map(board => board.quantity), [2, 1, 6, 24]);
const reordered = structuredClone(shared);
for (const key of ["board_types", "roots", "mounts"]) reordered[key].reverse();
assert.deepEqual(Object.fromEntries(boardTypes({ project_config: reordered }).map(board => [board.code, board.quantity])), { D: 24, C: 6, B: 1, A: 2 });
assert.deepEqual(boardTypes({ project_config: legacy }).map(board => board.quantity), [2, 6]);
assert.deepEqual(typeMounts({ project_config: legacy })[0].connections, [{ protocol: "UPP", transport: "CAN" }]);
const actual = boardTypes({ project_config: manifest.topology });
assert.deepEqual(actual.find(board => board.code === "UPM").parents.map(link => link.parent).sort(), ["CSU", "UPM_DEMO"]);
assert.equal(actual.find(board => board.code === "UPM").quantity, 24);
assert.equal(actual.find(board => board.code === "DSP").quantity, 192);
assert.equal(actual.find(board => board.code === "UPM_DEMO").parents.length, 0);

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ baseURL: `http://127.0.0.1:${server.httpServer.address().port}`, viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  const requests = [];
  await page.route("**/api/**", route => { requests.push(route.request().url()); return route.abort(); });
  let config;
  await page.route("**/__topology", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module">
    import {createApp,h} from '/node_modules/.vite/deps/vue.js';import Topology from '/src/pages/ProjectTopology.vue';import '/src/style.css';
    createApp({render:()=>h(Topology,{graph:{project_config:${JSON.stringify(config)}},onBoard:code=>{window.selectedBoard=code;}})}).mount('#app');
    </script></body></html>` }));
  for (config of [manifest.topology, reordered, legacy]) {
    await page.goto("/__topology");
    await expect(page.locator(".type-node")).toHaveCount(config.board_types.length, { timeout: 30000 });
    await expect(page.locator(".type-connection-line")).toHaveCount(config.mounts.length);
    const positions = await page.locator(".type-node").evaluateAll(nodes => nodes.map(node => ({
      code: node.getAttribute("data-code"),
      x: Number(node.querySelector("rect").getAttribute("x")),
      y: Number(node.querySelector("rect").getAttribute("y")),
    })));
    assert.equal(new Set(positions.map(node => node.code)).size, positions.length);
    for (const link of config.mounts) {
      assert(positions.find(node => node.code === link.parent).x < positions.find(node => node.code === link.child).x, "Every parent precedes its shared child");
    }
    for (const a of positions) for (const b of positions) {
      if (a.code !== b.code && a.x === b.x) assert(Math.abs(a.y - b.y) >= 120, "Nodes never overlap");
    }
    const labels = await page.locator(".type-edge-protocol, .type-edge-count").evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBBox();
      return { x, y, width, height };
    }));
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, "Protocol and quantity labels never overlap");
    }
    const roots = config.roots || [config.root];
    for (const entry of roots) await expect(page.locator(`.type-node[data-code="${entry.type}"] .type-node-detail`)).toContainText("根板卡");
    if (config === manifest.topology) {
      const upm = page.locator('.type-node[data-code="UPM"]');
      await expect(upm.locator(".type-node-detail")).toContainText("CSU、UPM_DEMO");
      await expect(page.locator('.type-connection-line[data-parent="UPM_DEMO"][data-child="UPM"] title')).toContainText("MODBUS / RS485");
      await upm.click();
      await expect.poll(() => page.evaluate(() => window.selectedBoard)).toBe("UPM");
    }
    await page.getByLabel("布局方向", { exact: true }).selectOption("DOWN");
    await expect(page.getByRole("button", { name: "自动整理", exact: true })).toBeEnabled({ timeout: 30000 });
    await expect(page.locator(".type-node")).toHaveCount(config.board_types.length);
    const vertical = await page.locator(".type-node").evaluateAll(nodes => nodes.map(node => ({
      code: node.getAttribute("data-code"), y: Number(node.querySelector("rect").getAttribute("y")),
    })));
    for (const link of config.mounts) assert(vertical.find(node => node.code === link.parent).y < vertical.find(node => node.code === link.child).y);
    await page.getByRole("button", { name: "自动整理", exact: true }).click();
    await expect(page.getByRole("button", { name: "自动整理", exact: true })).toBeEnabled({ timeout: 30000 });
    // Rapid switches must discard old worker results rather than restore them.
    await page.getByLabel("布局方向", { exact: true }).selectOption("RIGHT");
    await page.getByLabel("布局方向", { exact: true }).selectOption("DOWN");
    await page.getByLabel("布局方向", { exact: true }).selectOption("RIGHT");
    await expect(page.getByRole("button", { name: "自动整理", exact: true })).toBeEnabled({ timeout: 30000 });
    const horizontal = await page.locator(".type-node").evaluateAll(nodes => nodes.map(node => ({
      code: node.getAttribute("data-code"), x: Number(node.querySelector("rect").getAttribute("x")),
    })));
    for (const link of config.mounts) assert(horizontal.find(node => node.code === link.parent).x < horizontal.find(node => node.code === link.child).x);
  }
  assert.deepEqual(requests, [], "Rearranging a diagram never requests or writes project data");
  assert.deepEqual(errors, []);
  console.log("PASS: worker layout, direction/rearrange controls, stale-result cancellation, readonly view, shared nodes/counts and legacy topology");
} finally {
  await browser?.close();
  await server.close();
}
