// Optional local PostgreSQL for Linux x64 development; no system installation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  startPostgres,
  stopPostgres,
  connectPostgres,
} from "./postgres-control.mjs";

try {
  await main();
} catch (error) {
  console.error(`本地数据库启动/停止失败：${error.message}`);
  process.exitCode = 1;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.chdir(root);
  const command = process.argv[2] || "start";
  if (!["init", "start", "stop"].includes(command))
    throw new Error("用法：node scripts/local-db.mjs init|start|stop");
  const initialize = command === "init";
  const runtime = path.join(root, ".runtime");
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) {
    if (!initialize)
      throw new Error("尚未配置数据库，请先执行 ./scripts/init-db.sh。");
    const admin = crypto.randomBytes(18).toString("hex"),
      app = crypto.randomBytes(18).toString("hex"),
      password = crypto.randomBytes(18).toString("hex");
    fs.writeFileSync(
      envPath,
      `DATABASE_URL=postgres://protocol_app:${app}@127.0.0.1:55432/protocol_platform\nMIGRATION_DATABASE_URL=postgres://postgres:${admin}@127.0.0.1:55432/protocol_platform\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${password}\nBIND_ADDR=127.0.0.1:8080\nCOOKIE_SECURE=false\n`,
      { mode: 0o600, flag: "wx" },
    );
  }
  if (initialize) fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const config = Object.fromEntries(
    fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
  const adminUrl = new URL(config.MIGRATION_DATABASE_URL),
    appUrl = new URL(config.DATABASE_URL);
  if (adminUrl.hostname !== "127.0.0.1" || adminUrl.port !== "55432")
    throw new Error(
      "Existing .env uses an external database. Use your PostgreSQL service instead of local-db.",
    );
  let native = path.join(runtime, "pg-package/package/native");
  const tooling = path.join(runtime, "db-tools");
  if (!fs.existsSync(path.join(native, "bin/pg_ctl"))) {
    native = path.join(
      tooling,
      "node_modules/@embedded-postgres/linux-x64/native",
    );
    if (!fs.existsSync(path.join(native, "bin/pg_ctl"))) {
      if (!initialize)
        throw new Error(
          "缺少本地 PostgreSQL 工具，请先执行 ./scripts/init-db.sh。",
        );
      execFileSync(
        "npm",
        [
          "install",
          "--prefix",
          tooling,
          "--no-audit",
          "--no-fund",
          "--silent",
          "pg",
          "@embedded-postgres/linux-x64@18.4.0-beta.17",
        ],
        { stdio: "inherit" },
      );
    }
  }
  if (!fs.existsSync(path.join(tooling, "node_modules/pg"))) {
    if (!initialize)
      throw new Error("缺少数据库连接工具，请先执行 ./scripts/init-db.sh。");
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        tooling,
        "--no-audit",
        "--no-fund",
        "--silent",
        "pg",
      ],
      { stdio: "inherit" },
    );
  }
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: `${path.join(native, "lib")}:${process.env.LD_LIBRARY_PATH || ""}`,
  };
  const data = path.join(runtime, "pgdata"),
    socket = path.join(runtime, "pgsocket");
  const control = {
    native,
    data,
    socket,
    env,
    log: path.join(runtime, "postgres.log"),
  };
  if (command === "stop") {
    if (!fs.existsSync(path.join(data, "PG_VERSION")) || !stopPostgres(control))
      console.log("Local PostgreSQL is already stopped.");
    return;
  }
  if (!fs.existsSync(path.join(data, "PG_VERSION"))) {
    if (!initialize)
      throw new Error(
        "本地数据库未初始化，请先执行 ./scripts/init-db.sh。启动不会自动建库。",
      );
    const pw = path.join(runtime, "init-password");
    fs.writeFileSync(pw, decodeURIComponent(adminUrl.password), {
      mode: 0o600,
    });
    try {
      execFileSync(
        path.join(native, "bin/initdb"),
        [
          "-D",
          data,
          "-U",
          "postgres",
          "--auth=scram-sha-256",
          `--pwfile=${pw}`,
          "--encoding=UTF8",
          "--locale=C",
        ],
        { env, stdio: "inherit" },
      );
    } finally {
      fs.unlinkSync(pw);
    }
  }
  fs.mkdirSync(socket, { recursive: true, mode: 0o700 });
  startPostgres(control);
  const { default: pg } = await import(
    path.join(tooling, "node_modules/pg/lib/index.js")
  );
  const { Client } = pg;
  if (!initialize) {
    const db = await connectPostgres(Client, appUrl.toString());
    await db.end();
    console.log(
      "Local PostgreSQL started. Existing database and projects preserved.",
    );
    return;
  }
  const connection = new URL(adminUrl);
  connection.pathname = "/postgres";
  const db = await connectPostgres(Client, connection.toString());
  try {
    const exists = await db.query(
      "SELECT 1 FROM pg_roles WHERE rolname='protocol_app'",
    );
    if (!exists.rowCount) {
      // Values are quoted by PostgreSQL itself; passwords never enter shell commands.
      const { rows } = await db.query("SELECT quote_literal($1) AS password", [
        decodeURIComponent(appUrl.password),
      ]);
      await db.query(
        `CREATE ROLE protocol_app LOGIN PASSWORD ${rows[0].password} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    }
    const name = adminUrl.pathname.slice(1);
    if (name !== "protocol_platform") {
      throw new Error("现有 .env 指向旧版或自定义数据库；不会自动替换。旧单库请先停止服务并运行 node scripts/split-databases.mjs --maintenance，验证后再将两个 URL 的数据库名改为 protocol_platform。自定义平台库请直接使用 cargo run -- migrate。");
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(name))
      throw new Error("Invalid database name");
    if (
      !(await db.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
        .rowCount
    )
      await db.query(`CREATE DATABASE "${name}"`);
  } finally {
    await db.end();
  }
  console.log(
    "Local PostgreSQL ready at 127.0.0.1:55432. Credentials are in .env (mode 600).",
  );
}
