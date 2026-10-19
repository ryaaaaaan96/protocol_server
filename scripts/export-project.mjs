#!/usr/bin/env node
// Export a self-contained project folder and a genuine pg_dump custom archive.
// The archive carries one portable payload table, never accounts or other projects.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tables = ["process_points", "transmit_points"];

function environment() {
  const filename = path.join(root, ".env");
  const values = fs.existsSync(filename) ? Object.fromEntries(fs.readFileSync(filename, "utf8")
    .split(/\r?\n/).filter(line => line.includes("=") && !line.trimStart().startsWith("#"))
    .map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2")];
    })) : {};
  return { ...values, ...process.env };
}

function native(executable, args, env) {
  try {
    return execFileSync(executable, args, {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("缺少 pg_dump，请安装 PostgreSQL 客户端或设置 PG_DUMP_BIN。");
    throw new Error(`pg_dump 执行失败：${String(error.stderr || error.message).slice(0, 2000)}`);
  }
}

function assertSafeIds(row) {
  for (const [key, value] of Object.entries(row)) {
    if ((key === "id" || key.endsWith("_id")) && typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("数据库包含超过 JavaScript 安全整数范围的标识，不能使用此导出脚本。");
    }
  }
}

function fingerprint(directory) {
  const hash = crypto.createHash("sha256");
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("项目导出不接受符号链接，请使用项目内的普通文件。");
      hash.update(`${path.relative(directory, filename)}\0`);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) hash.update(fs.readFileSync(filename));
      else throw new Error("项目目录包含不支持的特殊文件。");
    }
  }
  visit(directory);
  return hash.digest("hex");
}

function comparableTopology(value) {
  const config = structuredClone(value);
  if (config?.version === 1) {
    config.version = 2;
    for (const mount of config.mounts || []) {
      mount.connections = mount.protocol == null ? [] : [{ protocol: mount.protocol, transport: mount.transport }];
      delete mount.protocol;
      delete mount.transport;
    }
  }
  // Directory locations affect file organization, not the persisted board graph.
  for (const board of config?.board_types || []) delete board.directory;
  function sort(item) {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]));
    return item;
  }
  return JSON.stringify(sort(config));
}

function removeOldDumps(directory, declaredDump) {
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name.toLowerCase().endsWith(".dump")) fs.unlinkSync(filename);
    }
  }
  visit(directory);
  if (declaredDump != null) {
    if (typeof declaredDump !== "string") throw new Error("project.json 的 dump 路径无效。");
    const filename = path.resolve(directory, declaredDump);
    if (!filename.startsWith(`${directory}${path.sep}`)) throw new Error("project.json 的 dump 路径必须在项目目录内。");
    if (fs.existsSync(filename) && !fs.statSync(filename).isFile()) throw new Error("project.json 的 dump 路径必须指向普通文件。");
    fs.rmSync(filename, { force: true });
  }
}

function canonicalParent(filename) {
  let existing = path.resolve(filename);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    const next = path.dirname(existing);
    if (next === existing) throw new Error("无法解析导出目录。");
    existing = next;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function outsideSource(parent, source) {
  if (parent === source || parent.startsWith(`${source}${path.sep}`)) throw new Error("导出目录不能放在源项目文件夹内。");
}

function entryExists(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** Destination is a parent directory; the result is destination/<project key>. */
export async function exportProject(key, destination, overrides = {}) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key || "")) throw new Error("项目 key 格式无效。");
  const env = { ...environment(), ...overrides };
  const configRoot = path.resolve(root, env.PROJECT_CONFIG_DIR || "config");
  const requestedSource = path.join(configRoot, key);
  if (fs.lstatSync(requestedSource).isSymbolicLink()) throw new Error("项目目录不能是符号链接。");
  const source = fs.realpathSync(requestedSource);
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "project.json"), "utf8"));
  if (manifest.key !== key || manifest.version !== 1) throw new Error("项目配置的 key 或版本不匹配。");
  let parent = canonicalParent(destination || path.join(root, ".runtime/exports", new Date().toISOString().replaceAll(":", "-")));
  outsideSource(parent, source);
  if (!env.MIGRATION_DATABASE_URL) throw new Error("请配置 MIGRATION_DATABASE_URL；导出需要创建并清理临时数据库的权限。");
  const executable = env.PG_DUMP_BIN || "pg_dump";
  native(executable, ["--version"], env);
  let pg;
  try {
    ({ default: pg } = await import(pathToFileURL(path.join(root, ".runtime/db-tools/node_modules/pg/lib/index.js")).href));
  } catch {
    throw new Error("缺少 Node.js pg 驱动：npm install --prefix .runtime/db-tools pg");
  }
  if (entryExists(path.join(parent, key))) throw new Error(`导出目录已存在，未覆盖：${path.join(parent, key)}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  parent = fs.realpathSync(parent);
  outsideSource(parent, source);
  const output = path.join(parent, key);
  const staging = fs.mkdtempSync(path.join(parent, ".project-export-"));
  const stagedProject = path.join(staging, key);
  const temporaryDatabase = `protocol_export_${crypto.randomBytes(12).toString("hex")}`;
  const sourceUrl = new URL(env.MIGRATION_DATABASE_URL);
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const temporaryUrl = new URL(sourceUrl);
  temporaryUrl.pathname = `/${temporaryDatabase}`;
  const platformDb = new pg.Client({ connectionString: sourceUrl.toString() });
  let sourceDb;
  const adminDb = new pg.Client({ connectionString: adminUrl.toString() });
  let temporaryDb;
  let created = false;
  try {
    const originalFingerprint = fingerprint(source);
    fs.cpSync(source, stagedProject, {
      recursive: true,
      filter: filename => {
        if (fs.lstatSync(filename).isSymbolicLink()) throw new Error("项目导出不接受符号链接，请使用项目内的普通文件。");
        return filename === source || !path.basename(filename).startsWith(".");
      },
    });
    if (fingerprint(stagedProject) !== originalFingerprint) throw new Error("复制期间项目配置发生变化，请重新导出。");
    if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(stagedProject, "project.json"), "utf8"))) !== JSON.stringify(manifest)) {
      throw new Error("读取期间 project.json 发生变化，请重新导出。");
    }
    await platformDb.connect();
    await platformDb.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: registrations } = await platformDb.query("SELECT id,project_uid,database_name FROM projects WHERE config_key=$1 AND status='ready'", [key]);
    if (registrations.length !== 1) throw new Error("平台数据库中未找到唯一的就绪项目。");
    const registry = registrations[0];
    if (!/^protocol_project_[a-z][a-z0-9_]{0,39}$/.test(registry.database_name)) throw new Error("平台登记的项目数据库名称无效。");
    const projectUrl = new URL(sourceUrl);
    projectUrl.pathname = `/${registry.database_name}`;
    sourceDb = new pg.Client({ connectionString: projectUrl.toString() });
    await sourceDb.connect();
    await sourceDb.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: projects } = await sourceDb.query("SELECT id,project_uid,config_key,revision,schema_version,topology_config FROM project_state");
    if (projects.length !== 1 || projects[0].id !== registry.id || projects[0].project_uid !== registry.project_uid || projects[0].config_key !== key) throw new Error("项目数据库与平台登记的身份不一致。");
    const project = projects[0];
    if (project.schema_version !== 4) throw new Error("请先迁移项目数据库到 v4。");
    if (comparableTopology(manifest.topology) !== comparableTopology(project.topology_config)) {
      throw new Error("服务器 project.json 与已应用的项目拓扑不同，请先在网页检查并导入配置后再导出。");
    }
    const { rows: migrations } = await sourceDb.query("SELECT max(version)::int AS version FROM _sqlx_migrations WHERE success");
    const payload = {
      format: "protocol-studio-project", version: 1, key, schema_version: 4,
      migration_version: migrations[0].version, source_revision: project.revision,
      tables: {},
    };
    let total = 0;
    for (const table of tables) {
      const { rows } = await sourceDb.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE project_id=$1 ORDER BY id`, [project.id]);
      payload.tables[table] = rows.map(({ row }) => { assertSafeIds(row); return row; });
      total += rows.length;
    }
    await sourceDb.query("COMMIT");
    await platformDb.query("COMMIT");
    if (fingerprint(source) !== originalFingerprint) throw new Error("导出期间服务器项目配置发生变化，请重新导出。");
    removeOldDumps(stagedProject, manifest.dump);
    if (total > 100_000) throw new Error("项目超过当前导入支持的 100000 条业务记录限制。");
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > 30 * 1024 * 1024) throw new Error("项目数据超过当前导出大小限制（30 MiB）。");
    await adminDb.connect();
    await adminDb.query(`CREATE DATABASE "${temporaryDatabase}"`);
    created = true;
    temporaryDb = new pg.Client({ connectionString: temporaryUrl.toString() });
    await temporaryDb.connect();
    await temporaryDb.query("CREATE TABLE public.protocol_studio_project_dump(payload text NOT NULL)");
    await temporaryDb.query("INSERT INTO public.protocol_studio_project_dump(payload) VALUES($1)", [serialized]);
    // Credentials stay in the child environment, never shell text or argv.
    const dumpUrl = new URL(temporaryUrl);
    const dumpEnv = { ...env, PGPASSWORD: decodeURIComponent(dumpUrl.password) };
    dumpUrl.password = "";
    native(executable, [
      "--format=custom", "--no-owner", "--no-privileges", "--table=public.protocol_studio_project_dump",
      `--file=${path.join(stagedProject, "project.dump")}`, `--dbname=${dumpUrl}`,
    ], dumpEnv);
    manifest.dump = "project.dump";
    fs.writeFileSync(path.join(stagedProject, "project.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.chmodSync(path.join(stagedProject, "project.dump"), 0o600);
    // Refuse replacement even if another exporter created the destination meanwhile.
    if (entryExists(output)) throw new Error(`导出目录已存在，未覆盖：${output}`);
    fs.renameSync(stagedProject, output);
    return { directory: output, rows: total, revision: project.revision, migrationVersion: payload.migration_version };
  } finally {
    await Promise.allSettled([sourceDb?.end(), platformDb.end(), temporaryDb?.end()]);
    try {
      if (created) await adminDb.query(`DROP DATABASE "${temporaryDatabase}" WITH (FORCE)`);
    } finally {
      await adminDb.end();
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || process.argv.length > 4) throw new Error("用法：node scripts/export-project.mjs <项目 key> [导出父目录]");
    const result = await exportProject(process.argv[2], process.argv[3]);
    console.log(`项目已导出：${result.directory}\n业务记录：${result.rows}；项目版本：${result.revision}；迁移版本：${result.migrationVersion}`);
  } catch (error) {
    console.error(`项目导出失败：${error.message}`);
    process.exitCode = 1;
  }
}
