// Real PostgreSQL + HTTP tests in an isolated, disposable database.
import fs from "node:fs";
import { checkPointEditing } from "./point-editing.mjs";
import { checkPointBatch } from "./point-batch.mjs";
import { checkStringRanges } from "./string-ranges.mjs";
import { checkEditLocks } from "./edit-locks.mjs";
import { checkEditScopes } from "./edit-scopes.mjs";
import { checkProjectFolders } from "./project-folders.mjs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const env = Object.fromEntries(
  fs
    .readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const { default: pg } = await import(
  path.join(root, ".runtime/db-tools/node_modules/pg/lib/index.js")
);
const adminUrl = new URL(env.MIGRATION_DATABASE_URL);
adminUrl.pathname = "/postgres";
const adminDb = new pg.Client({ connectionString: adminUrl.toString() });
await adminDb.connect();
const dbname = `protocol_test_${Date.now()}`;
await adminDb.query(`CREATE DATABASE "${dbname}"`);
const migration = new URL(env.MIGRATION_DATABASE_URL),
  appUrl = new URL(env.DATABASE_URL);
migration.pathname = `/${dbname}`;
appUrl.pathname = `/${dbname}`;
const password = crypto.randomBytes(20).toString("hex");
const projectConfigs = fs.mkdtempSync(
  path.join(root, ".runtime/test-project-configs-"),
);
const fixtureSource = path.join(root, "config/upm");
const workbookPath = path.join(fixtureSource, "sources/UPM项目测点数据表.xlsx");
const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
const writeJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value));
const manifest = readJson(path.join(fixtureSource, "project.json"));
const standardTables = Object.fromEntries(["process", "collect", "transmit"].map((kind) =>
  [kind, readJson(path.join(fixtureSource, "UPM", `${kind}.json`))],
));
function projectFixture(key, name, codes = null, workbook = null) {
  const directory = path.join(projectConfigs, key);
  fs.cpSync(fixtureSource, directory, { recursive: true });
  const config = { ...structuredClone(manifest), key, name, workbook };
  if (codes) {
    for (const board of config.topology.board_types) fs.rmSync(path.join(directory, board.directory), { recursive: true });
    config.topology = {
      version: 2,
      board_types: codes.map(code => ({ code, model_code: code, name: code, directory: code })),
      root: { type: codes[0], quantity: 1 },
      mounts: codes.slice(1).map(child => ({ parent: codes[0], child, quantity: 1, connections: [] })),
    };
    config.workspace.boards = {};
    for (const code of codes) {
      fs.mkdirSync(path.join(directory, code));
      config.workspace.boards[code] = { tables: ["process", "collect", "transmit"] };
      for (const [kind, definition] of Object.entries(standardTables)) {
        writeJson(path.join(directory, code, `${kind}.json`), definition);
      }
    }
  }
  writeJson(path.join(directory, "project.json"), config);
  return config;
}
function updateTable(key, code, kind, update) {
  const filename = path.join(projectConfigs, key, code, `${kind}.json`);
  const definition = readJson(filename);
  update(definition);
  writeJson(filename, definition);
}
const upmManifest = projectFixture("upm", manifest.name, null, manifest.workbook);
upmManifest.workspace.boards.DSP.tables = ["transmit", "process", "fields"];
writeJson(path.join(projectConfigs, "upm/project.json"), upmManifest);
updateTable("upm", "UPM", "process", table => {
  table.fields.name.label = "UPM 自定义名称";
  table.columns = ["name", "sig_id"];
});
updateTable("upm", "DSP", "transmit", table => { table.label = "自定义转发表"; });
const secondManifest = projectFixture("second", "Script second");
// Directory names are explicit and need not equal the board code or model code.
fs.renameSync(path.join(projectConfigs, "second/UPM"), path.join(projectConfigs, "second/controller"));
secondManifest.topology.board_types.find(board => board.code === "UPM").directory = "controller";
for (const code of ["UPM", "DSP"]) secondManifest.workspace.boards[code].tables = ["process", "collect", "transmit", "fields"];
secondManifest.workspace.boards.UPM.labels = { fields: "控制器协议字段" };
writeJson(path.join(projectConfigs, "second/project.json"), secondManifest);
for (const board of secondManifest.topology.board_types) updateTable("second", board.directory, "process", table => {
  table.fields.name.label = "第二项目名称";
  table.columns = ["name", "sig_id"];
});
updateTable("second", "controller", "process", table => {
  Object.assign(table, {
    label: "板卡目录处理表", description: "只配置 UPM 板卡的处理表",
    columns: ["sig_id", "name"], editor: ["name", "sig_id"], inline: {},
    ordering: { mode: "disabled", group_by: [] },
  });
  table.fields.name.label = "UPM 专用信号名";
});
updateTable("second", "controller", "collect", table => {
  Object.assign(table, { enabled: false, columns: ["poll_interval", "signal_name"], editor: ["poll_interval"], inline: { poll_interval: "poll_interval" } });
  table.fields.signal_name.label = "UPM 采集来源";
});
updateTable("second", "DSP", "collect", table => { table.enabled = false; });
updateTable("second", "DSP", "transmit", table => {
  Object.assign(table, {
    enabled: true, label: "DSP 目录转发表", columns: ["effective_address", "signal_name"],
    editor: ["signal_id"], inline: { signal_name: "signal_id" },
    ordering: { mode: "protocol", group_by: ["endpoint_id", "upp_model", "bank"] },
  });
  table.fields.signal_name.label = "DSP 转发来源";
});
projectFixture("web_seed", "HTTP seeded project", null, manifest.workbook);
projectFixture("broken", "Script broken", null, "sources/invalid.xlsx");
fs.writeFileSync(path.join(projectConfigs, "broken/sources/invalid.xlsx"), "invalid workbook archive");
const requestFixtures = new Map();
for (const [key, name, codes] of [
  ["alpha", "Test alpha"], ["beta", "Test beta"],
  ["json", "JSON-created project"], ["legacy", "Legacy JSON import"],
  ["ordering", "Point editing and merging", ["ORDER_PROTOCOL", "ORDER_DISABLED"]],
  ["batch", "Atomic point batches", ["BATCH", "OTHER"]],
  ["foreign_batch", "Foreign batch target"],
  ["strings", "String defaults without numeric bounds", ["STRING_TEST"]],
  ["locks", "Exclusive editing", ["LEASE_BOARD"]],
  ["lock_import", "Exclusive import"],
  ["scopes", "Scoped editors", ["SCOPE_A", "SCOPE_B"]],
  ["foreign_scope", "Foreign grant target"],
]) {
  const config = projectFixture(key, name, codes);
  if (key === "alpha") {
    // Later topology previews expand 12 controllers to the manifest's 24.
    config.topology.mounts[0].quantity = 12;
    writeJson(path.join(projectConfigs, key, "project.json"), config);
  }
  if (key === "scopes") {
    config.topology.mounts[0].connections = [{ protocol: "MODBUS", transport: "CANFD" }];
    writeJson(path.join(projectConfigs, key, "project.json"), config);
  }
  requestFixtures.set(name, key);
}
updateTable("ordering", "ORDER_PROTOCOL", "transmit", table => {
  table.ordering = { mode: "protocol", group_by: ["endpoint_id", "upp_model", "bank"] };
});
updateTable("ordering", "ORDER_DISABLED", "process", table => {
  table.ordering = { mode: "disabled", group_by: [] };
});
let server;
const testEnv = {
  ...process.env,
  ...env,
  MIGRATION_DATABASE_URL: migration.toString(),
  DATABASE_URL: appUrl.toString(),
  ADMIN_PASSWORD: password,
  ADMIN_USERNAME: "test_admin",
  BIND_ADDR: "127.0.0.1:18081",
  RUST_LOG: "warn",
  PROJECT_CONFIG_DIR: projectConfigs,
};
const base = "http://127.0.0.1:18081/api";
let assertions = 0;
const projectRequestQueues = new Map();
const equal = (a, b) => {
  assert.equal(a, b);
  assertions++;
};
const ok = (v, message) => {
  assert.ok(v, message);
  assertions++;
};
class Client {
  cookie = "";
  async raw(p, method = "GET", body, extra = {}) {
    const project = /^\/projects\/(\d+)\/(?!edit-lock(?:\/|$)|members(?:\/|$)|sql(?:\/|$))/.exec(p)?.[1];
    if (method === "GET" || !project) return this.rawUnlocked(p, method, body, extra);
    // Legacy domain tests explicitly take/release a lease around each request.
    // Their old-revision merge scenarios remain valid across editing sessions;
    // dedicated lease tests below use rawUnlocked to exercise real contention.
    const previous = projectRequestQueues.get(project) || Promise.resolve();
    let unlock;
    const pending = new Promise(resolve => { unlock = resolve; });
    projectRequestQueues.set(project, pending);
    await previous;
    let acquired = false;
    try {
      acquired = (await this.rawUnlocked(`/projects/${project}/edit-lock/acquire`, "POST", {})).status === 200;
      return await this.rawUnlocked(p, method, body, extra);
    } finally {
      if (acquired) await this.rawUnlocked(`/projects/${project}/edit-lock/release`, "POST", {});
      unlock();
      if (projectRequestQueues.get(project) === pending) projectRequestQueues.delete(project);
    }
  }
  async rawUnlocked(p, method = "GET", body, extra = {}) {
    // Each named test owns one complete directory; invalid unnamed keys pass through unchanged.
    if (p === "/projects" && method === "POST" && body && !Object.hasOwn(body, "config_key") && requestFixtures.has(body.name)) {
      body = { ...body, config_key: requestFixtures.get(body.name) };
    }
    const response = await fetch(base + p, {
      method,
      headers: {
        "X-Requested-With": "protocol-studio",
        ...(body instanceof FormData
          ? {}
          : body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...extra,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    if (response.headers.get("set-cookie"))
      this.cookie = response.headers.get("set-cookie").split(";")[0];
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data };
  }
  async call(p, method = "GET", body) {
    const r = await this.raw(p, method, body);
    assert.equal(r.status, 200, `${method} ${p}: ${JSON.stringify(r.data)}`);
    assertions++;
    return r.data;
  }
}
try {
  execFileSync("target/debug/protocol-server", ["migrate"], {
    env: testEnv,
    stdio: "inherit",
  });
  const log = fs.openSync(".runtime/integration-server.log", "w");
  server = spawn("target/debug/protocol-server", [], {
    env: testEnv,
    stdio: ["ignore", log, log],
  });
  const client = new Client();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready = (await client.raw("/health")).status === 200;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(ready, "server ready");
  equal((await client.raw("/projects")).status, 401);
  equal(
    (
      await client.raw(
        "/auth/login",
        "POST",
        { username: "test_admin", password },
        { "X-Requested-With": "" },
      )
    ).status,
    403,
  );
  await client.call("/auth/login", "POST", {
    username: "test_admin",
    password,
  });
  equal((await client.call("/projects")).length, 0); // Startup never creates a project.
  const createFromFile = (key) =>
    execFileSync("target/debug/protocol-server", ["create-project", key], {
      env: testEnv,
      encoding: "utf8",
    });
  ok(createFromFile("upm").includes("已创建项目"));
  const seeded = (await client.call("/projects"))[0];
  equal(seeded.config_key, "upm");
  ok(seeded.point_count > 0);
  const seededUrl = `/projects/${seeded.id}`;
  let seededGraph = await client.call(`${seededUrl}/topology`);
  equal(seededGraph.project_config.board_types.length, 5);
  const upmModel = seededGraph.board_models.find((m) => m.code === "UPM_ARM");
  const upmProcess = await client.call(
    `${seededUrl}/board-models/${upmModel.id}/point-tables/process`,
  );
  equal(upmProcess.rows.length, 202);
  equal(upmProcess.definition.fields.name.label, "UPM 自定义名称");
  equal(upmProcess.definition.columns.join(","), "name,sig_id");
  const projectDisplay = await client.call(`${seededUrl}/point-tables/schema`);
  equal(projectDisplay.boards.UPM.process.fields.name.label, "UPM 自定义名称");
  equal(projectDisplay.workspace.boards.DSP.tables.join(","), "forward,process,fields");
  equal(projectDisplay.workspace.boards.DSP.labels.process, "DSP内部数据");
  equal(projectDisplay.workspace.boards.DSP.labels.forward, "自定义转发表");
  equal(Object.hasOwn(projectDisplay, "fields"), false);
  equal(Object.hasOwn(projectDisplay, "tables"), false);
  equal((await client.raw("/point-tables/schema")).status, 404);
  const templates = await client.call("/project-templates");
  ok(templates.some(template => template.key === "upm"));
  ok(templates.some(template => template.key === "second"));
  equal((await new Client().raw("/project-templates")).status, 401);
  equal((await client.raw("/projects", "POST", { name: "Missing directory key" })).status, 400);
  equal((await client.raw("/projects", "POST", { config_key: "unknown_directory" })).status, 400);
  equal((await client.raw("/projects", "POST", { config_key: "upm" })).status, 409);
  const savedEdit = await client.call(`${seededUrl}/changes/preview`, "POST", {
    revision: seededGraph.revision,
    entity: "data_items",
    operation: "update",
    id: seededGraph.data_items[0].id,
    values: { notes: "saved after creation" },
  });
  ok(savedEdit.allowed);
  await client.call(`${seededUrl}/changes/${savedEdit.id}/commit`, "POST", {});
  seededGraph = await client.call(`${seededUrl}/topology`);
  const savedAudit = await client.call(`${seededUrl}/audit`);
  ok(createFromFile("upm").includes("未覆盖任何数据"));
  equal(
    JSON.stringify(await client.call(`${seededUrl}/topology`)),
    JSON.stringify(seededGraph),
  );
  equal(
    JSON.stringify(await client.call(`${seededUrl}/audit`)),
    JSON.stringify(savedAudit),
  );
  const failed = spawnSync(
    "target/debug/protocol-server",
    ["create-project", "broken"],
    { env: testEnv, encoding: "utf8" },
  );
  equal(failed.status, 1);
  ok(failed.stderr.includes("工作簿"));
  equal((await client.call("/projects")).length, 1); // Failed imports roll back project and models.
  const simultaneous = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "target/debug/protocol-server",
        ["create-project", "second"],
        { env: testEnv, stdio: "ignore" },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`create exited ${code}`)),
      );
    });
  await Promise.all([simultaneous(), simultaneous()]);
  const scriptedProjects = await client.call("/projects");
  equal(scriptedProjects.length, 2);
  const second = scriptedProjects.find((p) => p.config_key === "second");
  equal(second.point_count, 0);
  // Explicit directory controller maps topology UPM to model UPM_ARM.
  // Complete table definitions stay isolated between projects and boards.
  const secondUrl = `/projects/${second.id}`;
  const secondGraph = await client.call(`${secondUrl}/topology`);
  const secondDisplay = await client.call(`${secondUrl}/point-tables/schema`);
  equal(secondDisplay.boards.CSU.process.fields.name.label, "第二项目名称");
  equal(secondGraph.project_config.board_types.find(board => board.code === "UPM").directory, "controller");
  equal(secondDisplay.workspace.boards.UPM.labels.fields, "控制器协议字段");
  equal(secondDisplay.workspace.boards.UPM.tables.join(","), "process,forward,fields");
  equal(secondDisplay.workspace.boards.DSP.tables.join(","), "process,forward,fields");
  equal(secondDisplay.boards.UPM.process.label, "板卡目录处理表");
  equal(secondDisplay.boards.DSP.forward.label, "DSP 目录转发表");
  const secondTable = (code, kind) => client.call(
    `${secondUrl}/board-models/${secondGraph.board_models.find((m) => m.code === code).id}/point-tables/${kind}`,
  );
  const boardProcess = (await secondTable("UPM_ARM", "process")).definition;
  const expectedProcess = readJson(path.join(projectConfigs, "second/controller/process.json"));
  delete expectedProcess.version;
  delete expectedProcess.enabled;
  assert.deepEqual(boardProcess, expectedProcess);
  assertions++;
  equal(boardProcess.label, "板卡目录处理表");
  equal(boardProcess.description, "只配置 UPM 板卡的处理表");
  equal(boardProcess.columns.join(","), "sig_id,name");
  equal(boardProcess.editor.join(","), "name,sig_id");
  equal(boardProcess.fields.name.label, "UPM 专用信号名");
  equal(boardProcess.fields.sig_id.type, standardTables.process.fields.sig_id.type);
  equal(JSON.stringify(boardProcess.inline), "{}");
  equal(boardProcess.ordering.mode, "disabled");
  equal(boardProcess.ordering.group_by.length, 0);
  const boardCollect = (await secondTable("UPM_ARM", "collect")).definition;
  equal(boardCollect.columns.join(","), "poll_interval,signal_name");
  equal(boardCollect.editor.join(","), "poll_interval");
  equal(boardCollect.fields.signal_name.label, "UPM 采集来源");
  equal(JSON.stringify(boardCollect.inline), JSON.stringify({ poll_interval: "poll_interval" }));
  const boardForward = (await secondTable("DSP", "forward")).definition;
  equal(boardForward.label, "DSP 目录转发表");
  equal(boardForward.columns.join(","), "effective_address,signal_name");
  equal(boardForward.editor.join(","), "signal_id");
  equal(boardForward.fields.signal_name.label, "DSP 转发来源");
  equal(JSON.stringify(boardForward.inline), JSON.stringify({ signal_name: "signal_id" }));
  equal(boardForward.ordering.mode, "protocol");
  equal(boardForward.ordering.group_by.join(","), "endpoint_id,upp_model,bank");
  for (const code of ["CSU", "DSP"]) {
    const unaffected = (await secondTable(code, "process")).definition;
    equal(unaffected.columns.join(","), "name,sig_id");
    equal(unaffected.fields.name.label, "第二项目名称");
    equal(unaffected.editor.join(","), standardTables.process.editor.join(","));
    ok(Object.keys(unaffected.inline).length > 0);
    equal(unaffected.ordering.mode, "display");
  }
  equal(
    (await secondTable("UPM_ARM", "forward")).definition.fields.signal_name.label,
    standardTables.transmit.fields.signal_name.label,
  );
  equal(JSON.stringify(await client.call(`${seededUrl}/point-tables/schema`)), JSON.stringify(projectDisplay));
  equal(
    JSON.stringify((await client.call(`${seededUrl}/board-models/${upmModel.id}/point-tables/process`)).definition),
    JSON.stringify(upmProcess.definition),
  );
  // HTTP creation and the CLI import the same self-contained workbook atomically.
  const beforeHttpImport = (await client.call("/projects")).length;
  const brokenHttp = await client.raw("/projects", "POST", { config_key: "broken" });
  equal(brokenHttp.status, 400);
  ok(brokenHttp.data.error.includes("工作簿"));
  equal((await client.call("/projects")).length, beforeHttpImport);
  const webSeed = await client.call("/projects", "POST", { config_key: "web_seed" });
  equal(webSeed.name, "HTTP seeded project");
  const webGraph = await client.call(`/projects/${webSeed.id}/topology`);
  const webDsp = webGraph.board_models.find(model => model.code === "DSP");
  equal(webGraph.v_signals.filter(signal => signal.model_id === webDsp.id).length, 552);
  const fixtureDb = new pg.Client({ connectionString: migration.toString() });
  await fixtureDb.connect();
  try {
    equal(Number((await fixtureDb.query("SELECT count(*) FROM imports WHERE project_id=$1", [webSeed.id])).rows[0].count), 1);
    // Old/unbound project rows must surface their missing configuration, never another project's defaults.
    await fixtureDb.query("UPDATE projects SET config_key=NULL WHERE id=$1", [second.id]);
    equal((await client.raw(`${secondUrl}/point-tables/schema`)).status, 400);
  } finally {
    await fixtureDb.query("UPDATE projects SET config_key='second' WHERE id=$1", [second.id]);
    await fixtureDb.end();
  }
  equal((await client.raw("/projects", "POST", { config_key: "web_seed" })).status, 409);
  const wrongDirectory = structuredClone(manifest.topology);
  wrongDirectory.board_types.find(board => board.code === "DSP").directory = "UPM";
  equal((await client.raw("/projects", "POST", { config_key: "json", config: wrongDirectory })).status, 400);
  const wrongModel = structuredClone(manifest.topology);
  wrongModel.board_types.find(board => board.code === "DSP").model_code = "UNKNOWN_MODEL";
  equal((await client.raw("/projects", "POST", { config_key: "json", config: wrongModel })).status, 400);
  const p = await client.call("/projects", "POST", {
      name: "Test alpha",
      description: "integration",
    }),
    other = await client.call("/projects", "POST", { config_key: "beta" });
  equal(other.name, "Test beta");
  equal((await client.call(`/projects/${other.id}/topology`)).board_models.length, 5);
  const url = `/projects/${p.id}`;
  const engineer = await client.call("/users", "POST", {
      username: "engineer",
      display_name: "工程师",
      password,
    }),
    viewer = await client.call("/users", "POST", {
      username: "viewer",
      display_name: "只读",
      password,
    });
  await client.call(`${url}/members`, "PUT", {
    user_id: engineer.id,
    role: "engineer",
  });
  await client.call(`${url}/members`, "PUT", {
    user_id: viewer.id,
    role: "viewer",
  });
  const e = new Client(),
    v = new Client();
  await e.call("/auth/login", "POST", { username: "engineer", password });
  await v.call("/auth/login", "POST", { username: "viewer", password });
  equal((await e.call("/projects")).length, 1);
  equal((await e.raw("/project-templates")).status, 403);
  equal((await e.raw(`${seededUrl}/point-tables/schema`)).status, 403);
  equal((await v.raw(`${seededUrl}/point-tables/schema`)).status, 403);
  await client.call(`${seededUrl}/members`, "PUT", {
    user_id: viewer.id,
    role: "viewer",
  });
  equal(
    (await v.call(`${seededUrl}/point-tables/schema`)).boards.UPM.process.fields.name.label,
    "UPM 自定义名称",
  );
  equal(
    (
      await v.raw(`${seededUrl}/changes/preview`, "POST", {
        revision: seededGraph.revision,
        entity: "data_items",
        operation: "create",
        values: {},
      })
    ).status,
    403,
  );
  equal((await e.raw(`/projects/${other.id}/topology`)).status, 403);
  equal(
    (
      await v.raw(`${url}/changes/preview`, "POST", {
        revision: 1,
        entity: "boards",
        operation: "create",
        values: { name: "Denied" },
      })
    ).status,
    403,
  );
  equal((await e.raw("/users")).status, 403);
  equal(
    (
      await e.raw(`${url}/members`, "PUT", {
        user_id: viewer.id,
        role: "engineer",
      })
    ).status,
    403,
  );

  const graph = () => e.call(`${url}/topology`);
  const preview = async (
    entity,
    values,
    id = null,
    operation = id ? "update" : "create",
    who = e,
    project = url,
  ) => {
    const g = await who.call(`${project}/topology`);
    return who.call(`${project}/changes/preview`, "POST", {
      revision: g.revision,
      entity,
      operation,
      id,
      values,
    });
  };
  const commit = async (p, who = e, project = url) =>
    who.call(`${project}/changes/${p.id}/commit`, "POST", {});
  const edit = async (entity, values, id = null) => {
    const p = await preview(entity, values, id);
    ok(p.allowed, JSON.stringify(p.errors));
    return (await commit(p)).record;
  };
  const initialModels = (await graph()).board_models;
  const am = await edit("board_models", {
    name: "ARM", firmware_profile: "aidc",
  }, initialModels.find(model => model.code === "UPM_ARM").id);
  equal((await e.call(`${url}/overview`)).has_configuration, true);
  const configOnlyForm = new FormData();
  configOnlyForm.append(
    "file",
    new Blob([fs.readFileSync(workbookPath)]),
    "UPM.xlsx",
  );
  const configOnlyPreview = await e.call(
    `${url}/imports/preview`,
    "POST",
    configOnlyForm,
  );
  equal(
    (await e.raw(`${url}/imports/${configOnlyPreview.id}/commit`, "POST", {}))
      .status,
    409,
  );
  const bm = initialModels.find(model => model.code === "DSP");
  const ab = await edit("boards", {
    model_id: am.id,
    name: "控制板",
    code: "ARM_1",
  });
  const bb = await edit("boards", {
    model_id: bm.id,
    name: "DSP 1",
    code: "DSP_1",
  });
  const group = await edit("signal_groups", {
    model_id: am.id,
    name: "DSP代理",
    code: "DSP_PROXY",
  });
  const bg = await edit("signal_groups", {
    model_id: bm.id,
    name: "DSP内部",
    code: "DSP_LOCAL",
  });
  const ctx = await edit("device_contexts", {
    model_id: am.id,
    group_id: group.id,
    name: "DSP代理1",
    code: "CFG_DEV_DSP1",
    dev_id: 11,
    kind: "proxy",
  });
  const bctx = await edit("device_contexts", {
    model_id: bm.id,
    group_id: bg.id,
    name: "本地",
    code: "DSP_LOCAL",
    dev_id: 247,
    kind: "local",
  });
  const savedVir = await edit("device_contexts", {
    model_id: am.id,
    name: "虚拟转发",
    code: "CFG_DEV_VIR",
    dev_id: 1,
    kind: "virtual",
  });
  const data = await edit("data_items", {
    name: "母线电压",
    data_type: "U16",
    byte_length: 2,
    default_value: "10",
    min_value: "0",
    max_value: "65535",
  });
  const d2 = await edit("data_items", {
    name: "状态",
    data_type: "U16",
    byte_length: 2,
  });
  const sig = await edit("signals", {
    group_id: group.id,
    data_item_id: data.id,
    name: "ARM电压",
    enum_name: "ARM_VOLTAGE",
    sig_id: 2501,
  });
  const bsig = await edit("signals", {
    group_id: bg.id,
    data_item_id: data.id,
    name: "DSP电压",
    enum_name: "DSP_VOLTAGE",
    sig_id: 88,
  });
  await edit("signal_ranges", {
    signal_id: sig.id,
    manual_restore: true,
    boot_restore: false,
  });
  const contract = await edit("protocol_contracts", {
    name: "DSP UPP",
    code: "DSP_UPP",
    protocol: "UPP",
  });
  const mb = await edit("protocol_contracts", {
    name: "北向",
    code: "NORTH_MB",
    protocol: "MODBUS",
  });
  const ep = await edit("endpoints", {
    model_id: am.id,
    contract_id: contract.id,
    name: "UPP采集",
    code: "COLLECT",
    role: "client",
    transport: "CAN",
    port: "CAN_PORT1",
  });
  const bep = await edit("endpoints", {
    model_id: bm.id,
    contract_id: contract.id,
    name: "UPP服务",
    code: "SERVE",
    role: "server",
    transport: "CAN",
    port: "CAN_PORT1",
  });
  const nep = await edit("endpoints", {
    model_id: am.id,
    contract_id: mb.id,
    name: "Modbus服务",
    code: "NORTH",
    role: "server",
    transport: "RS485",
    port: "UART_PORT1",
  });
  const pf = await edit("protocol_fields", {
    contract_id: contract.id,
    data_item_id: data.id,
    name: "电压字段",
    model: 99,
    ordinal: 1,
    scale: 0.1,
  });
  const f2 = await edit("protocol_fields", {
    contract_id: contract.id,
    data_item_id: d2.id,
    name: "状态字段",
    model: 99,
    ordinal: 2,
  });
  await edit("signal_bindings", {
    endpoint_id: ep.id,
    context_id: ctx.id,
    field_id: pf.id,
    signal_id: sig.id,
    poll_interval: 3,
  });
  await edit("signal_bindings", {
    endpoint_id: bep.id,
    context_id: bctx.id,
    field_id: pf.id,
    signal_id: bsig.id,
  });
  const north = await edit("protocol_fields", {
    contract_id: mb.id,
    data_item_id: data.id,
    name: "北向电压",
    address_mode: "manual",
    address: 100,
    register_type: 4,
  });
  await edit("signal_bindings", {
    endpoint_id: nep.id,
    context_id: ctx.id,
    field_id: north.id,
    signal_id: sig.id,
  });
  const alias = await edit("protocol_fields", {
    contract_id: mb.id,
    data_item_id: data.id,
    name: "兼容别名",
    address_mode: "manual",
    address: 200,
    register_type: 4,
  });
  await edit("signal_bindings", {
    endpoint_id: nep.id,
    context_id: ctx.id,
    field_id: alias.id,
    signal_id: sig.id,
  });
  const link = await edit("board_links", {
    name: "ARM-DSP",
    client_board_id: ab.id,
    client_endpoint_id: ep.id,
    client_context_id: ctx.id,
    server_board_id: bb.id,
    server_endpoint_id: bep.id,
    remote_address: 1,
    dev_code: 1,
  });
  const route = await edit("passthrough_routes", {
    name: "DSP1透传",
    server_endpoint_id: nep.id,
    client_endpoint_id: ep.id,
    context_id: ctx.id,
    base_address: 50000,
    end_address: 50999,
    callback: "upp_passthrough_dsp1_callback",
  });
  let g = await graph();
  // Business point tables have independent contracts; a process edit spans signal + range atomically.
  const pointUrl = `${url}/board-models/${am.id}/point-tables`;
  const pointPreview = async (
    kind,
    id,
    values,
    operation = "update",
    who = e,
    base = pointUrl,
  ) => {
    const revision = (await who.call(`${base}/${kind}`)).revision;
    return who.call(`${base}/${kind}/preview`, "POST", {
      revision,
      operation,
      id,
      values,
    });
  };
  equal((await new Client().raw(`${url}/point-tables/schema`)).status, 401);
  equal((await e.call(`${url}/point-tables/schema`)).version, 1);
  equal((await e.raw(`${pointUrl}/missing`)).status, 404);
  equal(
    (await e.raw(`${url}/board-models/999999/point-tables/process`)).status,
    404,
  );
  equal(
    (
      await e.raw(
        `/projects/${other.id}/board-models/${am.id}/point-tables/process`,
      )
    ).status,
    403,
  );
  const processing = await v.call(`${pointUrl}/process`);
  equal(processing.rows.length, 1);
  equal(processing.rows[0].collection_count, 1);
  equal(processing.rows[0].forward_count, 2);
  equal(processing.rows[0].default_value, "10");
  equal(processing.rows[0].edit_values.default_value, null);
  equal(processing.rows[0].edit_values.manual_restore, true);
  ok(processing.rows[0].contexts.includes("11"));
  ok(processing.options.signals.every((s) => s.group_id === group.id));
  equal(
    (
      await v.raw(`${pointUrl}/process/preview`, "POST", {
        revision: processing.revision,
        operation: "update",
        id: sig.id,
        values: { sig_id: 2601 },
      })
    ).status,
    403,
  );
  const collected = await e.call(`${pointUrl}/collect`);
  const forwarded = await e.call(`${pointUrl}/forward`);
  equal(collected.rows.length, 1);
  equal(forwarded.rows.length, 2);
  equal(collected.rows[0].signal_name, "ARM电压");
  equal(collected.rows[0].field_name, "电压字段");
  const processChange = await pointPreview("process", sig.id, {
    sig_id: 2601,
    default_value: "12",
    min_value: "1",
    max_value: "99",
  });
  ok(processChange.allowed);
  equal((await graph()).signals.find((s) => s.id === sig.id).sig_id, 2501);
  equal((await e.call(`${pointUrl}/process`)).rows[0].default_value, "10");
  await commit(processChange);
  const pointAudit = (await e.call(`${url}/audit`)).find(
    (a) => a.entity === `process_points:${sig.id}`,
  );
  equal(pointAudit.before_data.record.range.default_value, null);
  equal(pointAudit.after_data.record.range.default_value, "12");
  const updated = await e.call(`${pointUrl}/process`);
  equal(updated.rows[0].resolved_sig_id, 2601);
  equal(updated.rows[0].default_value, "12");
  equal(updated.rows[0].manual_restore, true);
  ok(
    (await e.call(`${pointUrl}/forward`)).rows.every(
      (r) => r.resolved_sig_id === 2601,
    ),
  );
  equal((await graph()).signals.find((s) => s.id === bsig.id).sig_id, 88);
  const invalidRange = await pointPreview("process", sig.id, {
    sig_id: 2602,
    min_value: "100",
    max_value: "50",
  });
  equal(invalidRange.allowed, false);
  equal((await e.call(`${pointUrl}/process`)).rows[0].resolved_sig_id, 2601);
  equal((await e.call(`${pointUrl}/process`)).rows[0].min_value, "1");
  equal(
    (await pointPreview("process", sig.id, { effective_address: 44 })).allowed,
    false,
  );
  equal(
    (await pointPreview("process", bsig.id, { group_id: group.id })).allowed,
    false,
  );
  equal(
    (
      await pointPreview("collect", collected.rows[0].id, {
        context_id: bctx.id,
      })
    ).allowed,
    false,
  );
  equal(
    (
      await pointPreview("collect", collected.rows[0].id, {
        field_id: north.id,
      })
    ).allowed,
    false,
  );
  equal(
    (
      await pointPreview("collect", collected.rows[0].id, {
        endpoint_id: nep.id,
      })
    ).allowed,
    false,
  );
  equal(
    (await pointPreview("forward", collected.rows[0].id, { signal_id: sig.id }))
      .allowed,
    false,
  );
  equal(
    (await pointPreview("forward", forwarded.rows[0].id, { poll_interval: 3 }))
      .allowed,
    false,
  );
  equal((await pointPreview("process", sig.id, {}, "delete")).allowed, false);
  equal((await e.call(`${pointUrl}/process`)).rows[0].default_value, "12");
  const restored = await pointPreview("process", sig.id, {
    sig_id: 2501,
    default_value: null,
    min_value: null,
    max_value: null,
  });
  ok(restored.allowed);
  await commit(restored);
  equal((await e.call(`${pointUrl}/process`)).rows[0].default_value, "10");
  const freshPoint = await pointPreview(
    "process",
    null,
    {
      name: "Temporary point",
      group_id: group.id,
      data_item_id: data.id,
      enum_name: "TEMP_POINT",
      sig_id: 2603,
      default_value: "15",
      manual_restore: true,
    },
    "create",
  );
  ok(freshPoint.allowed);
  const newPoint = (await commit(freshPoint)).record;
  equal(newPoint.range.default_value, "15");
  const extraField = await edit("protocol_fields", {
    contract_id: mb.id,
    data_item_id: data.id,
    name: "Temporary alias",
    address_mode: "manual",
    address: 300,
    register_type: 4,
  });
  const newMappingPreview = await pointPreview(
    "forward",
    null,
    {
      endpoint_id: nep.id,
      context_id: ctx.id,
      field_id: extraField.id,
      signal_id: newPoint.id,
    },
    "create",
  );
  ok(newMappingPreview.allowed);
  const newMapping = (await commit(newMappingPreview)).record;
  equal(
    (await e.call(`${pointUrl}/forward`)).rows.find(
      (r) => r.id === newMapping.id,
    ).signal_name,
    "Temporary point",
  );
  equal(
    (await pointPreview("process", newPoint.id, {}, "delete")).allowed,
    false,
  );
  await commit(await pointPreview("forward", newMapping.id, {}, "delete"));
  await commit(await preview("protocol_fields", {}, extraField.id, "delete"));
  const removePoint = await pointPreview("process", newPoint.id, {}, "delete");
  ok(removePoint.allowed);
  await commit(removePoint);
  equal((await e.call(`${pointUrl}/process`)).rows.length, 1);
  ok(!(await graph()).signal_ranges.some((r) => r.signal_id === newPoint.id));
  const stalePoint = await pointPreview("collect", collected.rows[0].id, {
    poll_interval: 4,
  });
  ok(stalePoint.allowed);
  const anotherChange = await pointPreview("collect", collected.rows[0].id, {
    poll_interval: 5,
  });
  await commit(anotherChange);
  equal(
    (await e.raw(`${url}/changes/${stalePoint.id}/commit`, "POST", {})).status,
    409,
  );
  await commit(
    await pointPreview("collect", collected.rows[0].id, { poll_interval: 3 }),
  );
  g = await graph();
  equal(g.v_protocol_fields.find((f) => f.id === f2.id).effective_address, 8);
  equal(
    g.v_passthrough_fields.find((f) => f.field_id === f2.id).register_address,
    50001,
  );
  const change = await preview(
    "data_items",
    { data_type: "U32", byte_length: 4 },
    data.id,
  );
  ok(change.allowed, "shared shape update allowed");
  equal(change.impact.affected_boards.length, 2);
  ok(
    change.impact.changes.some(
      (c) => c.entity === "v_signals" && c.after.id === bsig.id,
    ),
    "remote signal shape included",
  );
  ok(
    change.impact.changes.some(
      (c) =>
        c.entity === "v_passthrough_fields" &&
        c.after.register_address === 50002,
    ),
    "derived register shift previewed",
  );
  equal(
    (await graph()).data_items.find((d) => d.id === data.id).byte_length,
    2,
  );
  await commit(change);
  g = await graph();
  equal(g.v_protocol_fields.find((f) => f.id === f2.id).effective_address, 10);
  equal(
    g.v_passthrough_fields.find((f) => f.field_id === f2.id).register_address,
    50002,
  );
  equal(g.v_signals.find((s) => s.id === bsig.id).byte_length, 4);
  await edit("signals", { sig_id: 2502 }, sig.id);
  g = await graph();
  equal(g.v_signals.find((s) => s.id === bsig.id).resolved_sig_id, 88);
  ok(
    g.v_bindings
      .filter((b) => b.signal_id === sig.id)
      .every((b) => b.resolved_sig_id === 2502),
    "all local aliases follow stable signal reference",
  );
  const overlap = await preview(
    "protocol_fields",
    { address_mode: "manual", address: 6 },
    f2.id,
  );
  equal(overlap.allowed, false);
  ok(
    overlap.errors.some((i) => i.code === "overlap"),
    "overlap rejected",
  );
  equal(
    (await preview("data_items", { byte_length: 2 }, data.id)).allowed,
    false,
  );
  equal((await preview("data_items", {}, data.id, "delete")).allowed, false);
  equal(
    (await preview("board_links", { server_endpoint_id: nep.id }, link.id))
      .allowed,
    false,
  );
  equal(
    (
      await preview("signal_bindings", {
        endpoint_id: ep.id,
        context_id: bctx.id,
        field_id: pf.id,
        signal_id: bsig.id,
      })
    ).allowed,
    false,
  );
  equal(
    (await preview("passthrough_routes", { end_address: 50000 }, route.id))
      .allowed,
    false,
  );
  const stale = await preview("data_items", { unit: "V" }, data.id);
  await edit("boards", { name: "控制板改名" }, ab.id);
  const mergedUnrelated = await commit(stale);
  equal(mergedUnrelated.merged, true);
  equal((await graph()).boards.find(b => b.id === ab.id).name, "控制板改名");
  const privatePreview = await preview("data_items", { unit: "V" }, data.id);
  equal(
    (await client.raw(`${url}/changes/${privatePreview.id}/commit`, "POST", {}))
      .status,
    400,
  );
  await commit(privatePreview);
  equal(
    (await e.raw(`${url}/changes/${privatePreview.id}/commit`, "POST", {}))
      .status,
    400,
  );
  const ext = await client.call(
    `/projects/${other.id}/changes/preview`,
    "POST",
    {
      revision: (await client.call(`/projects/${other.id}/topology`)).revision,
      entity: "data_items",
      operation: "create",
      values: { name: "Secret", data_type: "U16", byte_length: 2 },
    },
  );
  const secret = (
    await client.call(
      `/projects/${other.id}/changes/${ext.id}/commit`,
      "POST",
      {},
    )
  ).record;
  equal(
    (await preview("signals", { data_item_id: secret.id }, sig.id)).allowed,
    false,
  );
  equal(
    (
      await e.call(`${url}/sql`, "POST", {
        sql: "SELECT count(*) AS n FROM data_items",
      })
    ).rows[0].n,
    2,
  );
  for (const sql of [
    "SELECT * FROM users",
    "SELECT set_config('app.user_id','1',true)",
    "SELECT pg_sleep(5)",
    "SELECT * FROM pg_catalog.pg_authid",
    "DELETE FROM signals",
    "WITH q AS (DELETE FROM signals RETURNING *) SELECT * FROM q",
    "SELECT * FROM signals; SELECT 1",
    "SELECT 'x'::regclass",
    "SELECT (WITH users AS (SELECT 1) SELECT * FROM users) FROM users",
  ]) {
    equal((await e.raw(`${url}/sql`, "POST", { sql })).status, 400);
  }
  equal((await e.call(`${url}/validation`)).errors, 0);
  const stringData = await edit("data_items", {
    name: "设备名称",
    data_type: "STRING",
    byte_length: 8,
    default_value: "OK",
  });
  const stringSig = await edit("signals", {
    group_id: group.id,
    data_item_id: stringData.id,
    name: "设备名称",
    enum_name: "DEVICE_NAME",
    sig_id: 2503,
  });
  await edit("signal_ranges", {
    signal_id: stringSig.id,
    boot_restore: true,
    manual_restore: true,
  });
  const floatData = await edit("data_items", {
    name: "浮点源变量",
    data_type: "F32",
    byte_length: 4,
    default_value: "1.5",
  });
  const floatSig = await edit("signals", {
    group_id: group.id,
    data_item_id: floatData.id,
    name: "浮点信号",
    enum_name: "FLOAT_SIGNAL",
    sig_id: 2504,
  });
  const floatField = await edit("protocol_fields", {
    contract_id: contract.id,
    data_item_id: floatData.id,
    name: "浮点协议",
    model: 99,
    ordinal: 3,
  });
  await edit("signal_bindings", {
    endpoint_id: ep.id,
    context_id: ctx.id,
    field_id: floatField.id,
    signal_id: floatSig.id,
  });
  const explicitGenerated = await e.call(`${url}/generate`);
  equal(explicitGenerated.blocked, false);
  const explicitContexts = JSON.parse(explicitGenerated.files["board_types/UPM/connections.json"]).contexts;
  equal(explicitContexts.find(c => c.kind === "virtual").id, savedVir.id);
  const removeVir = await preview("device_contexts", {}, savedVir.id, "delete");
  ok(removeVir.allowed, JSON.stringify(removeVir.errors));
  await commit(removeVir);
  const generated = await e.call(`${url}/generate`);
  equal(generated.blocked, false);
  const autoContexts = JSON.parse(generated.files["board_types/UPM/connections.json"]).contexts;
  equal(autoContexts.filter(c => c.kind === "virtual").length, 1);
  equal(autoContexts.find(c => c.kind === "virtual").generated, true);
  equal(autoContexts.find(c => c.kind === "virtual").dev_id, 1);
  equal((await graph()).device_contexts.some(c => c.model_id === am.id && c.kind === "virtual"), false);
  equal(generated.files["board_types/UPM/dev_cfg.c"], explicitGenerated.files["board_types/UPM/dev_cfg.c"]);
  const collision = await preview("device_contexts", { dev_id: 1 }, ctx.id);
  equal(collision.allowed, false);
  ok(collision.errors.some(e => e.code === "virtual_service"));
  equal((await graph()).device_contexts.find(c => c.id === ctx.id).dev_id, 11);
  ok(
    generated.files["board_types/UPM/collect.c"].includes(".dec_p=0.1"),
    "fractional conversion retained",
  );
  ok(
    generated.files["board_types/UPM/transmit.c"].includes(".sig_id=2502"),
    "updated stable signal propagated to C",
  );
  ok(
    generated.files["board_types/UPM/dev_cfg.c"].includes(".coll_addr=1"),
    "link address used in registration",
  );
  ok(
    generated.files["board_types/DSP/SERVE.xml"].includes('DevCode="0"'),
    "peer protocol contract generated",
  );
  const staleRelease = await e.raw(`${url}/releases`, "POST", { name: "stale", revision: generated.revision - 1 });
  equal(staleRelease.status, 409);
  equal(staleRelease.data.code, "REVISION_CONFLICT");
  equal((await e.call(`${url}/releases`)).length, 0);
  const release = await e.call(`${url}/releases`, "POST", {
    name: "topology-test",
    revision: generated.revision,
  });
  equal(
    (await v.raw(`${url}/releases`, "POST", { name: "denied", revision: generated.revision })).status,
    403,
  );
  const zipResponse = await fetch(
    `${base}${url}/releases/${release.id}/download`,
    { headers: { Cookie: v.cookie } },
  );
  equal(zipResponse.status, 200);
  const zip = Buffer.from(await zipResponse.arrayBuffer());
  fs.writeFileSync(".runtime/test-release.zip", zip);
  await edit("boards", { name: "修改后的实例" }, ab.id);
  const frozen = Buffer.from(
    await (
      await fetch(`${base}${url}/releases/${release.id}/download`, {
        headers: { Cookie: v.cookie },
      })
    ).arrayBuffer(),
  );
  ok(zip.equals(frozen), "normalized release stays immutable");

  const book = fs.readFileSync(workbookPath),
    digest = crypto.createHash("sha256").update(book).digest("hex");
  const upload = () => {
    const form = new FormData();
    form.append("file", new Blob([book]), "UPM.xlsx");
    return form;
  };
  const ip = await e.call(`${url}/imports/preview`, "POST", upload());
  equal(ip.point_count, 612);
  equal(
    (await e.raw(`${url}/imports/${ip.id}/commit`, "POST", {})).status,
    409,
  );
  await edit("boards", { name: "控制板再次改名" }, ab.id);
  equal(
    (await e.raw(`${url}/imports/${ip.id}/commit`, "POST", { replace: true }))
      .status,
    409,
  );
  const fresh = await e.call(`${url}/imports/preview`, "POST", upload());
  await e.call(`${url}/imports/${fresh.id}/commit`, "POST", { replace: true });
  g = await graph();
  equal(g.boards.length, 9);
  equal(g.board_links.length, 8);
  equal(g.passthrough_routes.length, 8);
  equal(g.v_passthrough_fields.length, 445 * 8);
  ok(
    g.source_records.some((r) => r.sheet === "DSP内部数据"),
    "DSP source sheet preserved",
  );
  ok(
    g.source_records.some(
      (r) => r.sheet === "BMS采样数据" && r.classification === "pending",
    ),
    "unresolved sheet retained",
  );
  ok(
    g.signals.some((s) => s.process_enabled === false),
    "DSP local IDs not fabricated",
  );
  equal(g.v_signals.filter((s) => s.group_code === "DSP_PROXY").length, 41);
  ok(
    g.v_signals.some(
      (s) => s.group_code === "DSP_LOCAL" && s.data_type === "F32",
    ),
    "source float type retained",
  );
  ok(
    g.v_signals.some(
      (s) => s.group_code === "DSP_PROXY" && s.internal_type === "S32",
    ),
    "ARM representation explicitly separated",
  );
  equal(
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(workbookPath))
      .digest("hex"),
    digest,
  );
  ok(
    (await e.call(`${url}/audit`)).some(
      (a) =>
        a.action === "import.commit" && a.before_data.board_links.length === 1,
    ),
    "normalized before snapshot retained",
  );
  // Portable composition is type-based, with no multiplied board/point rows.
  const projectConfig = structuredClone(manifest.topology);
  const beforeConfig = await graph();
  const cp = await preview("project_config", projectConfig, null, "update");
  ok(cp.allowed, JSON.stringify(cp.errors));
  equal((await graph()).board_models.length, beforeConfig.board_models.length);
  equal(cp.impact.affected_types.length, 5);
  equal(cp.impact.affected_types.find((t) => t.code === "IDU_T").quantity, 1);
  equal(cp.impact.affected_types.find((t) => t.code === "IDU_R").quantity, 4);
  equal(cp.impact.affected_types.find((t) => t.code === "DSP").quantity, 192);
  await commit(cp);
  const configured = await graph();
  equal(configured.board_models.length, 5);
  equal(configured.project_config.version, 2);
  equal(configured.project_config.mounts[0].connections.length, 2);
  equal(configured.project_config.mounts[0].quantity, 24);
  const iduModels = configured.board_models.filter((m) =>
    ["IDU_TRANSFORMER", "IDU_RECTIFIER"].includes(m.code),
  );
  equal(iduModels.length, 2);
  ok(
    iduModels.every(
      (m) => !configured.v_signals.some((s) => s.model_id === m.id),
    ),
  );
  equal(configured.boards.length, beforeConfig.boards.length);
  equal(configured.signals.length, beforeConfig.signals.length);
  equal(
    JSON.stringify(await e.call(`${url}/configuration`)),
    JSON.stringify(configured.project_config),
  );
  equal((await e.raw(`/projects/${other.id}/configuration`)).status, 403);
  equal(
    (
      await v.raw(`${url}/changes/preview`, "POST", {
        revision: configured.revision,
        entity: "project_config",
        operation: "update",
        values: projectConfig,
      })
    ).status,
    403,
  );
  const invalid = structuredClone(projectConfig);
  invalid.mounts[0].parent = "DSP";
  ok(!(await preview("project_config", invalid, null, "update")).allowed);
  ok(!(await preview("project_config", wrongDirectory, null, "update")).allowed);
  ok(!(await preview("project_config", wrongModel, null, "update")).allowed);
  const wrongProtocol = structuredClone(projectConfig);
  wrongProtocol.mounts[1].connections[0].protocol = "MODBUS";
  wrongProtocol.mounts[1].connections[0].transport = "RS485";
  ok(!(await preview("project_config", wrongProtocol, null, "update")).allowed);
  const dspModel = configured.board_models.find((m) => m.code === "DSP");
  ok(!(await preview("board_models", { code: "RENAME" }, dspModel.id)).allowed);
  const changed = structuredClone(projectConfig);
  changed.mounts[0].quantity = 12;
  const oldConfigPreview = await preview(
    "project_config",
    changed,
    null,
    "update",
  );
  const currentConfigPreview = await preview(
    "project_config",
    changed,
    null,
    "update",
  );
  await commit(currentConfigPreview);
  equal(
    (await e.raw(`${url}/changes/${oldConfigPreview.id}/commit`, "POST", {}))
      .status,
    409,
  );
  const reimport = await e.call(`${url}/imports/preview`, "POST", upload());
  await e.call(`${url}/imports/${reimport.id}/commit`, "POST", {
    replace: true,
  });
  const importedConfig = await graph();
  equal(importedConfig.project_config.mounts[0].quantity, 12);
  equal(importedConfig.board_models.length, 5);
  ok(importedConfig.board_models.some((m) => m.code === "IDU_TRANSFORMER"));
  ok(importedConfig.board_models.some((m) => m.code === "IDU_RECTIFIER"));
  ok(importedConfig.board_models.some((m) => m.code === "CSU"));
  const jsonProject = await client.call("/projects", "POST", {
    name: "JSON-created project",
    config: projectConfig,
  });
  const jsonGraph = await client.call(`/projects/${jsonProject.id}/topology`);
  equal(jsonGraph.board_models.length, 5);
  equal(jsonGraph.boards.length, 0);
  equal(jsonGraph.project_config.mounts[1].quantity, 8);
  const jsonUrl = `/projects/${jsonProject.id}`;
  async function jsonPreview(entity, values, id = null) {
    const current = await client.call(`${jsonUrl}/topology`);
    return client.call(`${jsonUrl}/changes/preview`, "POST", {
      revision: current.revision,
      entity,
      operation: id === null ? "create" : "update",
      id,
      values,
    });
  }
  async function jsonCreate(entity, values) {
    const result = await jsonPreview(entity, values);
    ok(result.allowed, JSON.stringify(result.errors));
    return (
      await client.call(`${jsonUrl}/changes/${result.id}/commit`, "POST", {})
    ).record;
  }
  const canfdCsu = jsonGraph.board_models.find((m) => m.code === "CSU");
  const canfdUpm = jsonGraph.board_models.find((m) => m.code === "UPM_ARM");
  let firstCanfdEndpoint;
  for (const protocol of ["MODBUS", "UPP"]) {
    const contract = await jsonCreate("protocol_contracts", {
      name: `CSU UPM ${protocol}`,
      code: `CSU_UPM_${protocol}`,
      protocol,
    });
    for (const [model, role] of [
      [canfdCsu, "client"],
      [canfdUpm, "server"],
    ]) {
      const endpoint = await jsonCreate("endpoints", {
        model_id: model.id,
        contract_id: contract.id,
        name: `${protocol} CAN FD`,
        code: `${protocol}_CANFD`,
        role,
        transport: "CANFD",
        port: "TEST_CANFD_PORT",
      });
      if (!firstCanfdEndpoint) firstCanfdEndpoint = endpoint;
      equal(endpoint.transport, "CANFD");
    }
  }
  const missingProtocol = structuredClone(projectConfig);
  missingProtocol.mounts[0].connections.pop();
  ok(
    !(await jsonPreview("project_config", missingProtocol, jsonProject.id))
      .allowed,
    "cannot omit a shared CAN FD protocol",
  );
  ok(
    !(
      await jsonPreview(
        "endpoints",
        { transport: "CAN" },
        firstCanfdEndpoint.id,
      )
    ).allowed,
    "CAN FD is distinct from classic CAN",
  );
  const duplicateProtocol = structuredClone(projectConfig);
  duplicateProtocol.mounts[0].connections.push(
    duplicateProtocol.mounts[0].connections[0],
  );
  ok(
    !(await jsonPreview("project_config", duplicateProtocol, jsonProject.id))
      .allowed,
    "duplicate connection rejected",
  );
  const canfdGraph = await client.call(`${jsonUrl}/topology`);
  equal(canfdGraph.endpoints.length, 4);
  ok(canfdGraph.endpoints.every((e) => e.transport === "CANFD"));
  equal(canfdGraph.signals.length, 0);
  equal(canfdGraph.boards.length, 0);
  const legacyConfig = structuredClone(projectConfig);
  legacyConfig.version = 1;
  for (const mount of legacyConfig.mounts) {
    const first = mount.connections[0];
    delete mount.connections;
    Object.assign(mount, first);
  }
  legacyConfig.mounts[0].protocol = null;
  legacyConfig.mounts[0].transport = null;
  const legacyProject = await client.call("/projects", "POST", {
    name: "Legacy JSON import",
    config: legacyConfig,
  });
  const normalizedLegacy = await client.call(
    `/projects/${legacyProject.id}/configuration`,
  );
  equal(normalizedLegacy.version, 2);
  equal(normalizedLegacy.mounts[0].connections.length, 0);
  equal(normalizedLegacy.mounts[0].quantity, 24);
  equal(normalizedLegacy.mounts[1].connections[0].transport, "CAN");
  const typeGenerated = await client.call(
    `/projects/${jsonProject.id}/generate`,
  );
  equal(typeGenerated.blocked, false);
  equal(
    Object.keys(typeGenerated.files).filter(
      (k) => k.startsWith("board_types/") && k.endsWith("/connections.json"),
    ).length,
    5,
  );
  ok(!Object.keys(typeGenerated.files).some((k) => k.startsWith("boards/")));
  equal(JSON.parse(typeGenerated.files["project.json"]).mounts[0].quantity, 24);
  equal(
    JSON.parse(typeGenerated.files["project.json"]).mounts[0].connections
      .length,
    2,
  );
  const exportedEndpoints = JSON.parse(
    typeGenerated.files["board_types/CSU/connections.json"],
  ).endpoints;
  equal(exportedEndpoints.length, 2);
  ok(exportedEndpoints.every((e) => e.transport === "CANFD"));

  await checkPointEditing({ client, engineer: e, viewer: v, engineerId: engineer.id, viewerId: viewer.id, equal, ok });
  await checkPointBatch({ client, engineer: e, viewer: v, engineerId: engineer.id, viewerId: viewer.id, password, equal, ok });
  await checkStringRanges({ client, engineer: e, viewer: v, engineerId: engineer.id, viewerId: viewer.id, equal, ok });
  await checkEditLocks({ client, engineer: e, viewer: v, engineerId: engineer.id, viewerId: viewer.id, password, migrationUrl: migration.toString(), equal, ok });
  await checkEditScopes({ client, engineer: e, viewer: v, engineerId: engineer.id, viewerId: viewer.id, password, migrationUrl: migration.toString(), equal, ok });
  await checkProjectFolders({ client, engineer: e, viewer: v, engineerId: engineer.id, viewerId: viewer.id, password, makeClient: () => new Client(), projectConfigs, fixtureSource, testEnv, equal, ok });
  const direct = new pg.Client({ connectionString: appUrl.toString() });
  await direct.connect();
  equal(
    Number(
      (await direct.query("SELECT count(*) FROM data_items")).rows[0].count,
    ),
    0,
  );
  await direct.query("BEGIN");
  await direct.query(
    "SELECT set_config('app.user_id',$1,true),set_config('app.project_id',$2,true)",
    [String(viewer.id), String(p.id)],
  );
  equal(
    Number((await direct.query("SELECT count(*) FROM boards")).rows[0].count),
    9,
  );
  let denied = false;
  try {
    await direct.query(
      "INSERT INTO board_models(project_id,name,code) VALUES($1,'deny','DENY')",
      [p.id],
    );
  } catch (err) {
    denied = err.code === "42501";
  }
  ok(denied, "database denies viewer writes");
  await direct.query("ROLLBACK");
  equal(
    Number(
      (await direct.query("SELECT count(*) FROM v_signals")).rows[0].count,
    ),
    0,
  );
  await direct.end();
  await client.call(`${url}/members`, "PUT", {
    user_id: viewer.id,
    role: "remove",
  });
  equal((await v.raw(`${url}/topology`)).status, 403);
  console.log(
    `PASS: ${assertions} assertions; board graph, shared definitions, transactional impact previews, independent sigIDs, address shifts, rollback, stale revision, ownership, RLS and workbook import.`,
  );
} finally {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
  }
  await adminDb.query(`DROP DATABASE IF EXISTS "${dbname}" WITH (FORCE)`);
  await adminDb.end();
  fs.rmSync(projectConfigs, { recursive: true, force: true });
}
