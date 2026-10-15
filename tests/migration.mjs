// Exercises the real SQLx upgrade against a disposable v1 database.
// Optional argument: a local JSON backup, never printed or modified.
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";
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
const url = new URL(env.MIGRATION_DATABASE_URL),
  adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const name = `protocol_migration_test_${Date.now()}`;
await admin.query(`CREATE DATABASE "${name}"`);
url.pathname = `/${name}`;
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
try {
  await db.query(
    "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)",
  );
  for (const file of fs
    .readdirSync("migrations")
    .filter((f) => /^000[1-4]_/.test(f))
    .sort()) {
    const sql = fs.readFileSync(`migrations/${file}`);
    await db.query(sql.toString());
    await db.query(
      "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES($1,$2,true,$3,0)",
      [
        Number(file.slice(0, 4)),
        file.slice(5, -4).replaceAll("_", " "),
        crypto.createHash("sha384").update(sql).digest(),
      ],
    );
  }
  if (process.argv[2]) {
    const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    for (const table of ["projects", "platform_signals", "devices", "points"])
      if (data[table].length)
        await db.query(
          `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
          [JSON.stringify(data[table])],
        );
  } else {
    await db.query("INSERT INTO projects(id,name) VALUES(1,'Legacy fixture')");
    await db.query(
      "INSERT INTO devices(project_id,name,code,scope,base_address,end_address) VALUES(1,'Local','CFG_DEV_LOCAL','LOCAL',0,49999),(1,'DSP1','CFG_DEV_DSP1','DSP',50000,50999)",
    );
    await db.query("INSERT INTO platform_signals VALUES(1,'LOCAL_TEST',2201)");
    await db.query(
      "INSERT INTO points(project_id,scope,name,enum_name,signal_id,data_type,byte_length,address_mode,modbus_address,default_value,unit,notes) VALUES(1,'LOCAL','Edited','LOCAL_ENUM','LOCAL_TEST','U16',2,'manual',31234,'17','custom-unit','saved user edits')",
    );
    await db.query(
      "INSERT INTO points(project_id,scope,name,enum_name,signal_id,data_type,byte_length,address_mode,upp_model,upp_offset,poll_interval) VALUES(1,'DSP','DSP saved','DSP_ENUM','2501','S32',4,'auto',99,16,7)",
    );
  }
  const before = (
    await db.query("SELECT to_jsonb(p) AS j FROM points p ORDER BY id")
  ).rows.map((r) => r.j);
  const testEnv = {
    ...process.env,
    ...env,
    MIGRATION_DATABASE_URL: url.toString(),
    ADMIN_USERNAME: "migration_test",
    ADMIN_PASSWORD: crypto.randomBytes(20).toString("hex"),
    RUST_LOG: "warn",
  };
  execFileSync("target/debug/protocol-server", ["migrate"], {
    env: testEnv,
    stdio: "inherit",
  });
  assert.deepEqual(
    (
      await db.query("SELECT to_jsonb(p) AS j FROM points p ORDER BY id")
    ).rows.map((r) => r.j),
    before,
  );
  assert.equal(
    Number(
      (await db.query("SELECT count(*) FROM projects WHERE schema_version<>2"))
        .rows[0].count,
    ),
    0,
  );
  const graph = (await db.query("SELECT count(*)::int AS n FROM boards"))
    .rows[0].n;
  assert.ok(graph >= 2);
  if (!process.argv[2]) {
    assert.equal(
      Number(
        (await db.query("SELECT count(*) FROM source_records")).rows[0].count,
      ),
      0,
    );
    const v = (
      await db.query("SELECT * FROM v_bindings WHERE field_name='Edited'")
    ).rows[0];
    assert.equal(v.resolved_sig_id, 2201);
    assert.equal(Number(v.effective_address), 31234);
    assert.equal(
      (
        await db.query(
          "SELECT default_value FROM data_items WHERE name='Edited'",
        )
      ).rows[0].default_value,
      "17",
    );
    assert.equal(
      (
        await db.query(
          "SELECT poll_interval FROM signal_bindings b JOIN signals s ON s.id=b.signal_id WHERE s.enum_name='DSP_ENUM'",
        )
      ).rows[0].poll_interval,
      7,
    );
  }
  const counts = (await db.query("SELECT count(*)::int AS n FROM signals"))
    .rows[0].n;
  execFileSync("target/debug/protocol-server", ["migrate"], {
    env: testEnv,
    stdio: "inherit",
  });
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM signals")).rows[0].n,
    counts,
  );
  console.log(
    `PASS: v1→v2 migration, ${before.length} archived points unchanged, ${graph} board instances, saved parameters preserved, repeated migration idempotent.`,
  );
} finally {
  await db.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
