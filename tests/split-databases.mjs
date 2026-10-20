// Disposable databases only: v15 source, platform, and two independent projects.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";
import { splitDatabases, environment, projectDatabaseName } from "../scripts/split-databases.mjs";
import { exportProject } from "../scripts/export-project.mjs";
import { checkGroupedSchema } from "./grouped-schema.mjs";
import { preparePlatformSchema } from "./platform-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = environment();
const original = new URL(process.env.TEST_MIGRATION_DATABASE_URL || env.MIGRATION_DATABASE_URL);
const runtime = new URL(process.env.TEST_DATABASE_URL || env.DATABASE_URL);
const suffix = crypto.randomBytes(6).toString("hex");
const sourceName = `protocol_split_source_${suffix}`, platformName = `protocol_split_platform_${suffix}`;
const keys = [`split_a_${suffix}`, `split_b_${suffix}`];
const projectNames = keys.map(projectDatabaseName);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "protocol split-"));
const connection = name => { const url = new URL(original); url.pathname = `/${name}`; return url.toString(); };
const runtimeUrl = name => { const url = new URL(runtime); url.pathname = `/${name}`; return url.toString(); };
const admin = new pg.Client({ connectionString: connection("postgres") });
let source;
const opened = [], created = new Set();
const options = { maintenance: true, sourceUrl: connection(sourceName), runtimeUrl: runtimeUrl(platformName), platformName, backupDirectory: path.join(temporary, "backup"), env };
const quote = value => `"${value.replaceAll('"', '""')}"`;
const originalQuery = pg.Client.prototype.query;
async function connect(name) { const db = new pg.Client({ connectionString: connection(name) }); await db.connect(); opened.push(db); return db; }
const config = {
  version: 2,
  board_types: [{ code: "DSP", name: "DSP", model_code: "DSP", point_storage: "native", point_groups: [{ code: "LOCAL", name: "Internal" }], point_endpoints: [{ code: "UPP_SERVICE", name: "UPP", protocol: "UPP" }] }],
  root: { type: "DSP", quantity: 1 }, mounts: [],
};

await admin.connect();
try {
  assert.equal(projectDatabaseName("dc-ups"), "protocol_project_dc_ups");
  assert.throws(() => projectDatabaseName("DC UPS"), /key/);
  await assert.rejects(splitDatabases({ ...options, maintenance: false }), /maintenance/);
  await admin.query(`CREATE DATABASE ${quote(sourceName)}`);
  created.add(sourceName);
  source = await connect(sourceName);
  await source.query("CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)");
  for (const file of fs.readdirSync(path.join(root, "migrations")).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort()) {
    const sql = fs.readFileSync(path.join(root, "migrations", file));
    await source.query(sql.toString());
    await source.query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES($1,$2,true,$3,0)", [Number(file.slice(0, 4)), file.slice(5, -4).replaceAll("_", " "), crypto.createHash("sha384").update(sql).digest()]);
  }
  await source.query("INSERT INTO users(id,username,display_name,password_hash,is_admin,created_at) VALUES(1,'split_admin','Administrator','sensitive-hash-fixture',true,'2026-01-01 00:00:00.123456+00'),(9007199254740993,'split_member','Member','other-hash',false,DEFAULT)");
  await source.query("INSERT INTO projects(id,name,config_key,topology_config,revision) VALUES(41,'DC-UPS test',$1,$3,6),(42,'Second project',$2,$3,3)", [...keys, config]);
  await source.query("INSERT INTO sessions(token_hash,user_id) VALUES('session-fixture',9007199254740993)");
  await source.query("INSERT INTO login_attempts(username,failures) VALUES('unknown',2)");
  await source.query("INSERT INTO project_members(project_id,user_id,role,edit_scope) VALUES(41,9007199254740993,'engineer','scoped')");
  await source.query("INSERT INTO project_member_grants(project_id,user_id,board_key,scope) VALUES(41,9007199254740993,'DSP','internal')");
  await source.query("INSERT INTO project_edit_locks(project_id,user_id,expires_at) VALUES(41,9007199254740993,now()+interval '5 minutes')");
  await source.query("INSERT INTO process_points(id,project_id,board_key,group_key,name,enum_name,internal_type,byte_length) VALUES(9007199254740995,41,'DSP','LOCAL','First point','FIRST_POINT','U16',2),(88,42,'DSP','LOCAL','Second point','SECOND_POINT','U16',2)");
  await source.query("INSERT INTO transmit_points(id,project_id,board_key,process_point_id,name,upp_model,address,wire_type,wire_length) VALUES(99,41,'DSP',9007199254740995,'Forward',1,4,'U16',2)");
  await source.query("INSERT INTO point_history(id,project_id,batch_id,batch_label,entity_type,record_id,board_key,action,after_data,actor_id,actor_name,project_revision,config_snapshot) VALUES(101,41,'00000000-0000-0000-0000-000000000001','Saved history','process',9007199254740995,'DSP','insert','{\"id\":9007199254740995}',9007199254740993,'Historical name',6,$1)", [config]);
  await source.query("INSERT INTO audit_logs(id,project_id,user_id,action,entity) VALUES(201,NULL,1,'login','users'),(202,41,1,'member.update','project_members'),(203,41,1,'point.update','process_points')");
  await source.query("INSERT INTO imports(id,project_id,filename,sha256,report,created_by) VALUES(301,41,'old.xlsx','fixture','{}',1)");
  await source.query("INSERT INTO releases(id,project_id,name,revision,snapshot,files,sha256,created_by) VALUES(401,41,'Original release',6,'{\"old\":true}','{}','unchanged-hash',1)");
  await source.query("INSERT INTO import_previews(project_id,created_by,filename,sha256,revision,payload) VALUES(41,1,'old.xlsx','fixture',6,'{}')");
  await source.query("INSERT INTO change_previews(project_id,created_by,revision,change) VALUES(41,1,6,'{}')");
  await source.query("SELECT setval('process_points_id_seq',9007199254741995,true)");
  await assert.rejects(splitDatabases(options), /其他连接/);
  await source.end();

  await admin.query(`CREATE DATABASE ${quote(platformName)}`);
  created.add(platformName);
  await assert.rejects(splitDatabases(options), /不属于本次迁移/);
  assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [platformName])).rows[0].marker, null);
  await admin.query(`DROP DATABASE ${quote(platformName)}`);
  created.delete(platformName);
  await assert.rejects(splitDatabases({ ...options, pgDumpBin: path.join(temporary, "missing-pg-dump") }), /备份失败/);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [platformName])).rows[0].n, 0);

  // Simulate interruption after two committed destinations. Resume must verify
  // and reuse those exact records without dropping or overwriting anything.
  pg.Client.prototype.query = function(text, ...args) {
    if (text === `CREATE DATABASE ${quote(projectNames[1])} CONNECTION LIMIT 0`) return Promise.reject(new Error("simulated second project provisioning failure"));
    return originalQuery.call(this, text, ...args);
  };
  try { await assert.rejects(splitDatabases(options), /simulated second project/); }
  finally { pg.Client.prototype.query = originalQuery; }
  for (const name of [platformName, ...projectNames]) created.add(name);
  const journalPath = path.join(options.backupDirectory, "journal.json");
  const failed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(failed.databases[projectNames[0]].status, "copied");
  assert.ok(fs.statSync(failed.backup.file).size > 1000);
  assert.equal(fs.statSync(failed.backup.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(journalPath, "utf8").includes("sensitive-hash-fixture"), false);
  assert.equal((await admin.query("SELECT datconnlimit FROM pg_database WHERE datname=$1", [sourceName])).rows[0].datconnlimit, -1);
  source = await connect(sourceName);
  await source.query("UPDATE process_points SET name='Changed during failed migration' WHERE id=88");
  await source.end();
  await assert.rejects(splitDatabases({ ...options, journalPath }), /源数据发生变化/);
  source = await connect(sourceName);
  await source.query("UPDATE process_points SET name='Second point' WHERE id=88");
  await source.end();

  const result = await splitDatabases({ ...options, journalPath });
  assert.equal(result.alreadyComplete, false);
  assert.deepEqual(result.discardedPreviews, { change_previews: 1, import_previews: 1 });
  const platform = await connect(platformName), first = await connect(projectNames[0]), second = await connect(projectNames[1]);
  source = await connect(sourceName);
  assert.equal((await source.query("SELECT count(*)::int AS n FROM process_points")).rows[0].n, 2);
  assert.equal((await source.query("SELECT revision FROM projects WHERE id=41")).rows[0].revision, 6);
  assert.equal((await platform.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 2);
  assert.equal((await platform.query("SELECT to_regclass('process_points') AS relation")).rows[0].relation, null);
  assert.equal((await first.query("SELECT to_regclass('users') AS relation")).rows[0].relation, null);
  assert.equal((await first.query("SELECT to_regclass('project_members') AS relation")).rows[0].relation, null);
  assert.equal((await first.query("SELECT id FROM process_points")).rows[0].id, "9007199254740995");
  assert.deepEqual((await second.query("SELECT id,name FROM process_points")).rows, [{ id: "88", name: "Second point" }]);
  assert.deepEqual((await first.query("SELECT actor_id,actor_name,after_data::text AS value FROM point_history")).rows, [{ actor_id: "9007199254740993", actor_name: "Historical name", value: '{"id": 9007199254740995}' }]);
  assert.equal((await first.query("SELECT sha256 FROM releases")).rows[0].sha256, "unchanged-hash");
  assert.equal((await first.query("SELECT created_by_name FROM releases")).rows[0].created_by_name, "Administrator");
  assert.equal((await first.query("SELECT owner_name FROM project_edit_locks")).rows[0].owner_name, "Member");
  assert.equal((await platform.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n, 2);
  assert.equal((await first.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n, 2);
  for (const database of [first, second]) assert.equal((await database.query("SELECT last_value::text AS value FROM process_points_id_seq")).rows[0].value, "9007199254741995", "deleted/historical IDs must never be reused");
  assert.equal((await platform.query("SELECT user_id FROM sessions")).rows[0].user_id, "9007199254740993");
  assert.deepEqual((await platform.query("SELECT board_key,scope FROM project_member_grants")).rows, [{ board_key: "DSP", scope: "internal" }]);
  const state = (await first.query("SELECT * FROM project_state")).rows[0];
  assert.equal(state.schema_version, 4);
  assert.equal(state.revision, 7);
  assert.equal(state.project_uid, (await platform.query("SELECT project_uid FROM projects WHERE id=41")).rows[0].project_uid);
  const sourceTime = (await source.query("SELECT created_at::text AS value FROM users WHERE id=1")).rows[0].value;
  assert.equal((await platform.query("SELECT created_at::text AS value FROM users WHERE id=1")).rows[0].value, sourceTime);
  for (const table of ["point_history", "audit_logs", "releases"]) {
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) assert.equal((await first.query("SELECT has_table_privilege($1,$2,$3) AS yes", [decodeURIComponent(runtime.username), table, privilege])).rows[0].yes, false);
  }
  await assert.rejects(first.query("INSERT INTO process_points(project_id,name,enum_name,internal_type,byte_length) VALUES(42,'Wrong project','WRONG','U16',2)"), /foreign key/);
  assert.equal((await splitDatabases({ ...options, journalPath })).alreadyComplete, true);

  const configRoot = path.join(temporary, "config"), configFolder = path.join(configRoot, keys[1]);
  fs.mkdirSync(configFolder, { recursive: true });
  fs.writeFileSync(path.join(configFolder, "project.json"), JSON.stringify({ version: 1, key: keys[1], name: "Second project", topology: config }));
  const exportEnv = { ...env, PROJECT_CONFIG_DIR: configRoot, MIGRATION_DATABASE_URL: connection(platformName) };
  await assert.rejects(exportProject(keys[1], path.join(temporary, "before-upgrade"), exportEnv), /migrate.*v6/, "exports require the current schema rather than guessing missing schemas");
  const migrate = () => {
    const migrated = spawnSync(path.join(root, "target/debug/protocol-server"), ["migrate"], { cwd: root, env: { ...env, DATABASE_URL: runtimeUrl(platformName), MIGRATION_DATABASE_URL: connection(platformName) }, encoding: "utf8", timeout: 120_000 });
    assert.equal(migrated.status, 0, migrated.stderr || "SQLx rejected split-created databases");
  };
  const verifyPlatformSchema = await preparePlatformSchema({ platform, runtimeUrl: runtimeUrl(platformName), runtimeRole: decodeURIComponent(runtime.username) });
  await checkGroupedSchema({ first, second, runtimeUrl: runtimeUrl(projectNames[0]), runtimeRole: decodeURIComponent(runtime.username), migrate });
  await verifyPlatformSchema(migrate);
  assert.equal((await splitDatabases({ ...options, journalPath })).alreadyComplete, true, "completed split journals remain verifiable after grouping both platform and project schemas");
  // An interrupted old copy must not reinterpret already upgraded targets.
  await source.end();
  const incompleteJournal = path.join(options.backupDirectory, "incomplete-grouped.json");
  const incomplete = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  incomplete.status = "backed_up";
  fs.writeFileSync(incompleteJournal, JSON.stringify(incomplete), { mode: 0o600 });
  await assert.rejects(splitDatabases({ ...options, journalPath: incompleteJournal }), /未完成拆分.*已升级/, "unfinished v1 copy refuses a grouped v2 target without overwriting it");
  assert.equal((await admin.query("SELECT datconnlimit FROM pg_database WHERE datname=$1", [sourceName])).rows[0].datconnlimit, -1, "failed resume restores source connection access");
  const exported = await exportProject(keys[1], path.join(temporary, "export"), { ...env, PROJECT_CONFIG_DIR: configRoot, MIGRATION_DATABASE_URL: connection(platformName) });
  assert.equal(exported.rows, 1);
  assert.equal(exported.migrationVersion, 3);
  const listing = execFileSync(env.PG_RESTORE_BIN || "pg_restore", ["--list", path.join(exported.directory, "project.dump")], { env, encoding: "utf8" });
  assert.match(listing, /protocol_studio_project_dump/);
  assert.doesNotMatch(listing, /TABLE public users/);
  const firstConfig = path.join(configRoot, keys[0]);
  fs.mkdirSync(firstConfig);
  fs.writeFileSync(path.join(firstConfig, "project.json"), JSON.stringify({ version: 1, key: keys[0], name: "First project", topology: config }));
  await assert.rejects(exportProject(keys[0], path.join(temporary, "unsafe-export"), { ...env, PROJECT_CONFIG_DIR: configRoot, MIGRATION_DATABASE_URL: connection(platformName) }), /安全整数/);
  assert.equal((await first.query("SELECT revision FROM meta.project_state")).rows[0].revision, 9);
  assert.equal((await first.query("SELECT count(*)::int AS n FROM history.events WHERE kind='point'")).rows[0].n, 1);
  console.log("PASS: v15 splits through reproducible v1 into grouped platform v2/project v3; exact IDs/JSON/timestamps, permissions, locks and history survive; concurrent connections, foreign targets and backup failures are rejected; failed copy resumes safely; source retained; v6 exports and repeat SQLx migrations pass.");
} finally {
  pg.Client.prototype.query = originalQuery;
  await Promise.allSettled(opened.map(db => db.end()));
  for (const name of [platformName, ...projectNames, sourceName]) {
    if (created.has(name)) await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
  }
  await admin.end();
  fs.rmSync(temporary, { recursive: true, force: true });
}
