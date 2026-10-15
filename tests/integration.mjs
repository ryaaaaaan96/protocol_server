// Real PostgreSQL + HTTP tests in an isolated, disposable database.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
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
};
const base = "http://127.0.0.1:18081/api";
let assertions = 0;
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
  const p = await client.call("/projects", "POST", {
      name: "Test alpha",
      description: "integration",
    }),
    other = await client.call("/projects", "POST", { name: "Test beta" });
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
  const am = await edit("board_models", {
    name: "ARM",
    code: "ARM",
    firmware_profile: "aidc",
  });
  equal((await e.call(`${url}/overview`)).has_configuration, true);
  const configOnlyForm = new FormData();
  configOnlyForm.append(
    "file",
    new Blob([fs.readFileSync("UPM项目测点数据表.xlsx")]),
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
  const bm = await edit("board_models", { name: "DSP", code: "DSP" });
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
  await edit("device_contexts", {
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
  equal(
    (await e.raw(`${url}/changes/${stale.id}/commit`, "POST", {})).status,
    409,
  );
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
  const generated = await e.call(`${url}/generate`);
  equal(generated.blocked, false);
  ok(
    generated.files["boards/ARM_1/collect.c"].includes(".dec_p=0.1"),
    "fractional conversion retained",
  );
  ok(
    generated.files["boards/ARM_1/transmit.c"].includes(".sig_id=2502"),
    "updated stable signal propagated to C",
  );
  ok(
    generated.files["boards/ARM_1/dev_cfg.c"].includes(".coll_addr=1"),
    "link address used in registration",
  );
  ok(
    generated.files["boards/DSP_1/SERVE.xml"].includes('DevCode="1"'),
    "peer protocol contract generated",
  );
  const release = await e.call(`${url}/releases`, "POST", {
    name: "topology-test",
  });
  equal(
    (await v.raw(`${url}/releases`, "POST", { name: "denied" })).status,
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

  const book = fs.readFileSync("UPM项目测点数据表.xlsx"),
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
      .update(fs.readFileSync("UPM项目测点数据表.xlsx"))
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
}
