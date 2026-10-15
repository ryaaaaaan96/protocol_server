import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// postmaster.pid can survive a shutdown or reboot. Let PostgreSQL check its PID
// and handle stale lock files; never delete locks or reinitialize an existing DB.
export function postgresRunning({ native, data, env }) {
  const result = spawnSync(
    path.join(native, "bin/pg_ctl"),
    ["-D", data, "status"],
    {
      env,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 3) return false;
  throw new Error(
    `无法检查 PostgreSQL 状态（退出码 ${result.status}），请检查数据库目录权限。`,
  );
}

export function startPostgres(options) {
  const {
    native,
    data,
    socket,
    log,
    env,
    port = 55432,
    stdio = "inherit",
  } = options;
  if (postgresRunning(options)) return false;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("无效的数据库端口");
  // pg_ctl passes -o through a shell. Quote socket paths, including spaces/apostrophes.
  const quotedSocket = "'" + socket.replaceAll("'", "'\\''") + "'";
  try {
    execFileSync(
      path.join(native, "bin/pg_ctl"),
      [
        "-D",
        data,
        "-l",
        log,
        "-o",
        `-h 127.0.0.1 -p ${port} -k ${quotedSocket}`,
        "-w",
        "-t",
        "30",
        "start",
      ],
      { env, stdio },
    );
  } catch {
    throw new Error(`PostgreSQL 启动失败，请查看 ${log}。现有数据目录已保留。`);
  }
  return true;
}

export function stopPostgres(options) {
  const { native, data, env, stdio = "inherit" } = options;
  if (!postgresRunning(options)) return false;
  execFileSync(
    path.join(native, "bin/pg_ctl"),
    ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"],
    { env, stdio },
  );
  return true;
}

export async function connectPostgres(
  Client,
  connectionString,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  const transient = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "57P03",
  ]);
  let lastError;
  do {
    const db = new Client({
      connectionString,
      connectionTimeoutMillis: Math.max(
        1,
        Math.min(2000, deadline - Date.now()),
      ),
    });
    try {
      await db.connect();
      return db;
    } catch (error) {
      await db.end().catch(() => {});
      lastError = error;
      if (!transient.has(error.code) && error.message !== "timeout expired") {
        throw new Error(
          `PostgreSQL 连接失败（${error.code || "未知错误"}），请检查 .env 中的数据库连接配置。`,
        );
      }
      if (Date.now() < deadline)
        await delay(Math.min(200, deadline - Date.now()));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `等待 PostgreSQL 就绪超时（${lastError?.code || "连接超时"}），请查看 .runtime/postgres.log。`,
  );
}
