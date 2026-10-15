// Real temporary PostgreSQL cluster: stale PID recovery must preserve stored data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  startPostgres,
  stopPostgres,
  postgresRunning,
  connectPostgres,
} from "../scripts/postgres-control.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { default: pg } = await import(
  path.join(root, ".runtime/db-tools/node_modules/pg/lib/index.js")
);
const native = [
  path.join(root, ".runtime/pg-package/package/native"),
  path.join(
    root,
    ".runtime/db-tools/node_modules/@embedded-postgres/linux-x64/native",
  ),
].find((p) => fs.existsSync(path.join(p, "bin/pg_ctl")));
assert.ok(native, "Run scripts/local-db.mjs once to install PostgreSQL");
const env = {
  ...process.env,
  LD_LIBRARY_PATH: `${native}/lib:${process.env.LD_LIBRARY_PATH || ""}`,
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "protocol pg ' recovery-"));
const data = path.join(temp, "data"),
  socket = path.join(temp, "socket");
fs.mkdirSync(socket, { mode: 0o700 });
const listener = net.createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const options = {
  native,
  data,
  socket,
  env,
  port,
  log: path.join(temp, "postgres.log"),
  stdio: "pipe",
};
const connection = `postgres://postgres@127.0.0.1:${port}/postgres`;
let db;
try {
  execFileSync(
    path.join(native, "bin/initdb"),
    [
      "-D",
      data,
      "-U",
      "postgres",
      "--auth=trust",
      "--encoding=UTF8",
      "--locale=C",
    ],
    { env, stdio: "pipe" },
  );
  assert.equal(postgresRunning(options), false);
  // Begin connecting before startup to exercise the bounded readiness retry.
  const ready = connectPostgres(pg.Client, connection, 5000);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(startPostgres(options), true);
  db = await ready;
  await db.query(
    "CREATE TABLE keep_data(value TEXT); INSERT INTO keep_data VALUES('preserve-existing-project')",
  );
  await db.end();
  db = null;
  const pidFile = path.join(data, "postmaster.pid"),
    original = fs.readFileSync(pidFile, "utf8");
  assert.equal(
    startPostgres(options),
    false,
    "second start reuses the running process",
  );
  assert.equal(fs.readFileSync(pidFile, "utf8"), original);
  assert.equal(stopPostgres(options), true);
  // Recreate a postmaster.pid from the dead process, like an interrupted shutdown.
  fs.writeFileSync(pidFile, original, { mode: 0o600 });
  assert.equal(
    postgresRunning(options),
    false,
    "stale PID does not mean running",
  );
  assert.equal(stopPostgres(options), false, "stale PID stop is idempotent");
  assert.equal(
    startPostgres(options),
    true,
    "stale PID does not skip PostgreSQL startup",
  );
  db = await connectPostgres(pg.Client, connection);
  assert.equal(
    (await db.query("SELECT value FROM keep_data")).rows[0].value,
    "preserve-existing-project",
  );
  await db.end();
  db = null;
  assert.equal(stopPostgres(options), true);
  assert.equal(stopPostgres(options), false);
  await assert.rejects(
    connectPostgres(pg.Client, connection, 300),
    /等待 PostgreSQL 就绪超时/,
  );
  console.log(
    "PASS: readiness retry, repeated start/stop, stale PID recovery, stored data preserved, quoted paths and bounded connection failure.",
  );
} catch (error) {
  if (fs.existsSync(options.log))
    console.error(
      fs.readFileSync(options.log, "utf8").split("\n").slice(-15).join("\n"),
    );
  throw error;
} finally {
  if (db) await db.end().catch(() => {});
  if (fs.existsSync(path.join(data, "PG_VERSION"))) stopPostgres(options);
  fs.rmSync(temp, { recursive: true, force: true });
}
