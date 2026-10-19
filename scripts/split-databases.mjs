#!/usr/bin/env node
// One-time, resumable v15 migration. Source and backups are never deleted.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceTables = ["users", "sessions", "login_attempts", "projects", "project_members", "project_member_grants", "process_points", "transmit_points", "point_history", "imports", "releases", "audit_logs", "project_edit_locks", "import_previews", "change_previews"];
const pointTables = ["process_points", "transmit_points", "point_history", "imports", "releases", "audit_logs", "project_edit_locks"];
const sqlxTable = "CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)";
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = rows => hash(canonical(rows.map(row => canonical(row)).sort()));

export function environment() {
  const filename = path.join(root, ".env");
  const values = fs.existsSync(filename) ? Object.fromEntries(fs.readFileSync(filename, "utf8")
    .split(/\r?\n/).filter(line => line.includes("=") && !line.trimStart().startsWith("#"))
    .map(line => { const i = line.indexOf("="); return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2")]; })) : {};
  return { ...values, ...process.env };
}

export function projectDatabaseName(key) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(key || "")) throw new Error("项目 key 必须是 1–40 位小写字母、数字、下划线或连字符，并以字母开头。");
  return `protocol_project_${key.replaceAll("-", "_")}`;
}

function safeName(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value || "")) throw new Error("数据库名称格式无效。");
  return value;
}
function dbUrl(source, name) { const url = new URL(source); url.pathname = `/${name}`; return url.toString(); }
function writeJournal(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
function sanitize(error) { return String(error?.message || error).replace(/(postgres(?:ql)?:\/\/)[^\s@]*@/g, "$1[credentials]@"); }
async function connect(pg, url) {
  const client = new pg.Client({ connectionString: url, application_name: "protocol-studio-split", connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}
async function rows(db, table) { return (await db.query(`SELECT * FROM ${quote(table)}`)).rows; }
async function serialSequence(db, table) {
  return (await db.query("SELECT pg_get_serial_sequence($1,'id') AS name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'", [table])).rows[0]?.name;
}
async function insertRows(db, table, records) {
  if (!records.length) return;
  const columns = Object.keys(records[0]);
  for (let start = 0; start < records.length; start += 100) {
    const batch = records.slice(start, start + 100), values = [];
    const tuples = batch.map(row => `(${columns.map(key => { values.push(row[key]); return `$${values.length}`; }).join(",")})`);
    await db.query(`INSERT INTO ${quote(table)}(${columns.map(quote).join(",")}) VALUES ${tuples.join(",")}`, values);
  }
  const sequence = await serialSequence(db, table);
  if (sequence) await db.query(`SELECT setval($1::regclass,COALESCE((SELECT max(id) FROM ${quote(table)}),1),(SELECT count(*)>0 FROM ${quote(table)}))`, [sequence]);
}
async function preserveSequence(db, table, previous) {
  if (!previous) return;
  const sequence = await serialSequence(db, table);
  if (!sequence) return;
  const maximum = (await db.query(`SELECT max(id)::text AS id FROM ${quote(table)}`)).rows[0].id;
  const value = maximum && BigInt(maximum) > BigInt(previous.value) ? maximum : previous.value;
  await db.query("SELECT setval($1::regclass,$2::bigint,$3)", [sequence, value, maximum != null || previous.is_called]);
}
async function grantRuntime(db, kind, role) {
  const mutable = kind === "platform" ? ["users", "sessions", "login_attempts", "project_members", "project_member_grants"] : ["process_points", "transmit_points", "imports", "import_previews", "change_previews", "project_edit_locks"];
  const appendOnly = kind === "platform" ? ["audit_logs"] : ["point_history", "audit_logs", "releases"];
  await db.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}; GRANT SELECT,INSERT,UPDATE,DELETE ON ${mutable.map(quote).join(",")} TO ${quote(role)}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quote(role)}; GRANT SELECT,INSERT ON ${appendOnly.map(quote).join(",")} TO ${quote(role)}; REVOKE UPDATE,DELETE,TRUNCATE ON ${appendOnly.map(quote).join(",")} FROM ${quote(role)}; REVOKE ALL ON _sqlx_migrations FROM ${quote(role)}`);
  await db.query(kind === "platform" ? `GRANT SELECT,INSERT,UPDATE ON projects TO ${quote(role)}` : `GRANT SELECT,UPDATE ON project_state TO ${quote(role)}`);
}
async function migrate(db, kind) {
  await db.query(sqlxTable);
  const directory = path.join(root, "migrations", kind);
  for (const file of fs.readdirSync(directory).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
    const sql = fs.readFileSync(path.join(directory, file));
    await db.query(sql.toString());
    await db.query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES($1,$2,true,$3,0)", [Number(file.split("_")[0]), file.replace(/^\d+_/, "").replace(/\.sql$/, "").replaceAll("_", " "), crypto.createHash("sha384").update(sql).digest()]);
  }
}

/** Requires a stopped application and no other source DB connections. */
export async function splitDatabases(options = {}) {
  if (!options.maintenance) throw new Error("先停止服务和数据库查看工具，然后指定 --maintenance。拆分期间不得启动旧服务。");
  const env = { ...environment(), ...options.env };
  const sourceUrl = new URL(options.sourceUrl || env.SPLIT_SOURCE_DATABASE_URL || env.MIGRATION_DATABASE_URL || "");
  const sourceName = decodeURIComponent(sourceUrl.pathname.slice(1));
  const platformName = safeName(options.platformName || env.SPLIT_PLATFORM_DATABASE_NAME || "protocol_platform");
  if (sourceName === platformName) throw new Error("源数据库与平台目标数据库不能相同；旧单库请设置 SPLIT_SOURCE_DATABASE_URL。");
  const runtimeRole = decodeURIComponent(new URL(options.runtimeUrl || env.DATABASE_URL).username);
  let { default: pg } = await import(pathToFileURL(path.join(root, ".runtime/db-tools/node_modules/pg/lib/index.js")));
  // Preserve PostgreSQL timestamps and JSON integer values byte-for-byte.
  const types = { getTypeParser: (oid, format) => [1184, 1114, 114, 3802].includes(oid) ? value => value : pg.types.getTypeParser(oid, format) };
  const Client = pg.Client;
  pg = { ...pg, Client: class extends Client { constructor(config) { super({ ...config, types }); } } };
  const identity = { host: sourceUrl.hostname, port: sourceUrl.port || "5432", database: sourceName, platform: platformName, runtimeRole };
  const requestedJournal = options.journalPath && path.resolve(options.journalPath);
  const backupDirectory = requestedJournal ? path.dirname(requestedJournal) : path.resolve(options.backupDirectory || path.join(root, ".runtime/backups", `split-${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomBytes(3).toString("hex")}`));
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const journalPath = requestedJournal || path.join(backupDirectory, "journal.json");
  const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : { version: 1, run: crypto.randomUUID(), source: identity, status: "planned", created_at: new Date().toISOString(), databases: {}, backup: null };
  if (journal.version !== 1 || canonical(journal.source) !== canonical(identity)) throw new Error("迁移日志与源实例、目标平台或运行账号不匹配，拒绝继续。");
  const save = () => writeJournal(journalPath, journal);
  save();
  const admin = await connect(pg, dbUrl(sourceUrl, "postgres"));
  let source, limited = false, originalLimit, sourceTransaction = false;
  const clients = [];
  try {
    const privileged = (await admin.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
    if (!privileged?.rolsuper) throw new Error("一次性分库迁移需要 PostgreSQL 管理员（superuser）执行备份、连接隔离和完整数据校验；运行账号不需要此权限。");
    const runtime = (await admin.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1", [runtimeRole])).rows[0];
    if (!runtime || Object.values(runtime).some(Boolean)) throw new Error("运行账号必须已存在，且无 superuser、BYPASSRLS、CREATEDB 或 CREATEROLE 权限。");
    if (journal.status === "complete") {
      for (const [name, entry] of Object.entries(journal.databases)) {
        const current = (await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name])).rows[0];
        if (!current || current.marker !== entry.marker) throw new Error(`已完成迁移的目标库 ${name} 标记不匹配，请人工检查。`);
      }
      const platform = await connect(pg, dbUrl(sourceUrl, platformName));
      clients.push(platform);
      for (const project of journal.projects) {
        const registration = (await platform.query("SELECT project_uid,config_key,database_name,status FROM projects WHERE id=$1", [project.id])).rows[0];
        if (!registration || registration.project_uid !== project.uid || registration.config_key !== project.key || registration.database_name !== project.database || registration.status !== "ready") throw new Error("已迁移的项目登记身份发生变化，请人工检查。");
        const db = await connect(pg, dbUrl(sourceUrl, project.database));
        clients.push(db);
        const states = (await db.query("SELECT id,project_uid,config_key FROM project_state")).rows;
        if (states.length !== 1 || states[0].id !== project.id || states[0].project_uid !== project.uid || states[0].config_key !== project.key) throw new Error("已迁移的项目数据库身份与登记不一致，请人工检查。");
      }
      return { journalPath, backup: journal.backup?.file, platformName, projects: journal.projects, alreadyComplete: true };
    }
    source = await connect(pg, sourceUrl.toString());
    const pid = (await source.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const others = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND pid<>$2", [sourceName, pid])).rows[0].n;
    if (others) throw new Error(`源库仍有 ${others} 个其他连接；请停止旧服务并断开 DBeaver 后重试。`);
    originalLimit = journal.originalSourceLimit ?? (await admin.query("SELECT datconnlimit FROM pg_database WHERE datname=$1", [sourceName])).rows[0].datconnlimit;
    journal.originalSourceLimit = originalLimit;
    save();
    await admin.query(`ALTER DATABASE ${quote(sourceName)} CONNECTION LIMIT 0`);
    limited = true;
    if ((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND pid<>$2", [sourceName, pid])).rows[0].n) throw new Error("源库出现新的连接，已停止迁移，请保持维护状态。");
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout='10s'");
    sourceTransaction = true;
    await source.query(`LOCK TABLE ${[...sourceTables, "_sqlx_migrations"].map(quote).join(",")} IN SHARE MODE`);
    const version = (await source.query("SELECT max(version)::int AS version FROM _sqlx_migrations WHERE success")).rows[0].version;
    if (version !== 15) throw new Error("源库必须已完成旧版 v15 迁移；新平台库不能再次拆分。");
    const actualTables = (await source.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows.map(r => r.table_name).sort();
    if (canonical(actualTables) !== canonical([...sourceTables, "_sqlx_migrations"].sort())) throw new Error("源库含未识别的数据表，拒绝遗漏这些数据；请先人工确认其迁移方式。");
    const data = {};
    for (const table of sourceTables) data[table] = await rows(source, table);
    const sequences = {};
    for (const table of sourceTables) {
      const sequence = await serialSequence(source, table);
      if (sequence) sequences[table] = (await source.query(`SELECT last_value::text AS value,is_called FROM ${sequence}`)).rows[0];
    }
    const sourceDigest = hash(canonical({ rows: Object.fromEntries(Object.entries(data).map(([table, values]) => [table, digest(values)])), sequences }));
    if (journal.sourceDigest && journal.sourceDigest !== sourceDigest) throw new Error("失败后源数据发生变化，不能接续旧迁移；旧目标库与备份已保留，请人工检查。");
    const projects = data.projects.map(project => {
      const key = project.config_key === "upm" ? "dc-ups" : project.config_key;
      if (project.schema_version !== 3) throw new Error(`项目 ${project.id} 不是 v3，不能拆分。`);
      return { ...project, project_uid: journal.projects?.find(p => p.id === project.id)?.uid || crypto.randomUUID(), config_key: key, name: project.config_key === "upm" ? "DC-UPS" : project.name, database_name: projectDatabaseName(key) };
    });
    const names = [platformName, ...projects.map(p => p.database_name)];
    if (names.includes(sourceName) || new Set(names).size !== names.length) throw new Error("项目 key 转换后的数据库名冲突，请先处理重复或歧义命名。");
    // Preflight every target before creating any of them.
    for (const name of names) {
      const existing = (await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name])).rows[0];
      if (existing && existing.marker !== journal.databases[name]?.marker) throw new Error(`目标库 ${name} 已存在且不属于本次迁移，未覆盖。`);
    }
    journal.sourceDigest = sourceDigest;
    journal.projects = projects.map(p => ({ id: p.id, uid: p.project_uid, key: p.config_key, name: p.name, database: p.database_name }));
    journal.counts = Object.fromEntries(Object.entries(data).map(([table, records]) => [table, records.length]));
    journal.discardedPreviews = { change_previews: data.change_previews.length, import_previews: data.import_previews.length };
    save();
    if (!journal.backup) {
      const file = path.join(backupDirectory, "source.dump"), backupUrl = new URL(sourceUrl);
      if (fs.existsSync(file)) throw new Error("备份目录已有 source.dump，拒绝覆盖；请选择新的备份目录或使用对应迁移日志。");
      const stagingFile = path.join(backupDirectory, `.source-${crypto.randomUUID()}.partial.dump`);
      fs.writeFileSync(stagingFile, "", { flag: "wx", mode: 0o600 });
      const password = decodeURIComponent(backupUrl.password);
      backupUrl.password = "";
      const snapshot = (await source.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
      try {
        execFileSync(options.pgDumpBin || env.PG_DUMP_BIN || "pg_dump", ["--format=custom", `--snapshot=${snapshot}`, `--file=${stagingFile}`, `--dbname=${backupUrl}`], { env: { ...env, PGPASSWORD: password }, stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
        if (!fs.readFileSync(stagingFile).subarray(0, 5).equals(Buffer.from("PGDMP"))) throw new Error("备份不是 PostgreSQL custom Dump。");
        // link is exclusive: another process cannot be overwritten between checks.
        fs.linkSync(stagingFile, file);
      } catch (error) {
        throw new Error(`备份失败，尚未创建目标库：${error.code === "ENOENT" ? "缺少 pg_dump，请设置 PG_DUMP_BIN" : sanitize(error)}`);
      } finally {
        fs.rmSync(stagingFile, { force: true });
      }
      journal.backup = { file, sha256: hash(fs.readFileSync(file)) };
      journal.status = "backed_up";
      save();
    } else if (!fs.existsSync(journal.backup.file) || hash(fs.readFileSync(journal.backup.file)) !== journal.backup.sha256) {
      throw new Error("原始备份丢失或校验失败，不能继续迁移。");
    }
    const userMap = new Map(data.users.map(user => [user.id, user]));
    const actor = id => userMap.get(id)?.display_name || userMap.get(id)?.username || "";
    const audit = records => records.map(row => ({ ...row, actor_name: actor(row.user_id) }));
    const platformRows = {
      users: data.users, sessions: data.sessions, login_attempts: data.login_attempts,
      projects: projects.map(p => ({ id: p.id, project_uid: p.project_uid, config_key: p.config_key, name: p.name, description: p.description, database_name: p.database_name, status: "ready", created_by: null, created_at: p.created_at, updated_at: p.updated_at })),
      project_members: data.project_members, project_member_grants: data.project_member_grants,
      audit_logs: audit(data.audit_logs.filter(row => row.project_id == null || row.action.startsWith("member.") || row.action.startsWith("user."))),
    };
    const expected = new Map([[platformName, { kind: "platform", tables: platformRows }]]);
    for (const project of projects) {
      const { database_name, ...state } = project;
      state.schema_version = 4;
      state.revision += 1;
      const tables = { project_state: [state] };
      for (const table of pointTables) {
        const subset = data[table].filter(row => row.project_id === project.id);
        tables[table] = table === "audit_logs" ? audit(subset) : ["imports", "releases"].includes(table) ? subset.map(row => ({ ...row, created_by_name: actor(row.created_by) })) : table === "project_edit_locks" ? subset.map(row => ({ ...row, owner_name: actor(row.user_id), owner_username: userMap.get(row.user_id)?.username || "" })) : subset;
      }
      tables.import_previews = [];
      tables.change_previews = [];
      expected.set(database_name, { kind: "project", tables });
    }
    for (const [name, target] of expected) {
      let entry = journal.databases[name];
      const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount;
      if (!exists) {
        if (entry?.status === "copied") throw new Error(`已校验的目标库 ${name} 丢失，不能自动重建。`);
        entry = { marker: `protocol-studio-split:${journal.run}:${target.kind}`, status: "creating" };
        journal.databases[name] = entry;
        save();
        await admin.query(`CREATE DATABASE ${quote(name)} CONNECTION LIMIT 0`);
        const marker = (await admin.query("SELECT quote_literal($1) AS value", [entry.marker])).rows[0].value;
        await admin.query(`COMMENT ON DATABASE ${quote(name)} IS ${marker}`);
      }
      const db = await connect(pg, dbUrl(sourceUrl, name));
      clients.push(db);
      const initialized = (await db.query("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL AS yes")).rows[0].yes;
      if (!initialized) {
        await db.query("BEGIN");
        try {
          await migrate(db, target.kind);
          for (const [table, records] of Object.entries(target.tables)) {
            await insertRows(db, table, records);
            // Never reuse an ID belonging to a deleted row in immutable history.
            await preserveSequence(db, table, sequences[table]);
          }
          await grantRuntime(db, target.kind, runtimeRole);
          await db.query("COMMIT");
        } catch (error) { await db.query("ROLLBACK"); throw error; }
      }
      for (const [table, records] of Object.entries(target.tables)) {
        if (digest(await rows(db, table)) !== digest(records)) throw new Error(`目标库 ${name}.${table} 与源数据不一致，已保留现场；不会覆盖已有记录。`);
        const sequence = await serialSequence(db, table), previous = sequences[table];
        if (sequence && previous) {
          const current = (await db.query(`SELECT last_value::text AS value,is_called FROM ${sequence}`)).rows[0];
          const maximum = records.reduce((value, row) => row.id && BigInt(row.id) > value ? BigInt(row.id) : value, BigInt(previous.value));
          if (BigInt(current.value) < maximum || ((records.length || previous.is_called) && !current.is_called)) throw new Error(`目标库 ${name}.${table} 的序列可能复用旧 ID，拒绝启用。`);
        }
      }
      entry.status = "copied";
      entry.rows = Object.fromEntries(Object.entries(target.tables).map(([table, records]) => [table, records.length]));
      save();
    }
    // Do not expose partially copied databases to runtime connections.
    for (const name of names) await admin.query(`ALTER DATABASE ${quote(name)} CONNECTION LIMIT -1`);
    journal.status = "complete";
    journal.completed_at = new Date().toISOString();
    save();
    return { journalPath, backup: journal.backup.file, platformName, projects: journal.projects, discardedPreviews: journal.discardedPreviews, alreadyComplete: false };
  } catch (error) {
    journal.lastError = sanitize(error);
    save();
    throw new Error(`${sanitize(error)}\n迁移日志：${journalPath}；失败目标库和源库均已保留。`, { cause: error });
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    if (sourceTransaction) await source.query("ROLLBACK").catch(() => {});
    if (limited) await admin.query(`ALTER DATABASE ${quote(sourceName)} CONNECTION LIMIT ${originalLimit}`);
    await source?.end();
    await admin.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--maintenance") options.maintenance = true;
      else if (args[i] === "--journal" && args[i + 1]) options.journalPath = args[++i];
      else if (args[i] === "--backup-dir" && args[i + 1]) options.backupDirectory = args[++i];
      else throw new Error("用法：node scripts/split-databases.mjs --maintenance [--journal <journal.json>] [--backup-dir <目录>]");
    }
    const result = await splitDatabases(options);
    console.log(`${result.alreadyComplete ? "此前已完成拆分，本次未修改数据" : "拆分完成并校验全部记录"}。\n平台库：${result.platformName}\n${result.projects.map(p => `${p.name}：${p.database}`).join("\n")}\n备份：${result.backup}\n日志：${result.journalPath}\n旧源库已保留。确认后将 .env 中 DATABASE_URL 和 MIGRATION_DATABASE_URL 的数据库名改为 ${result.platformName}，保持账号密码不变，再执行 cargo run -- migrate 并启动新版服务。`);
  } catch (error) { console.error(`数据库拆分失败：${sanitize(error)}`); process.exitCode = 1; }
}
