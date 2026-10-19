// Run the real SQLx upgrade in a disposable database, leaving its source database untouched.
// TEST_MIGRATION_DATABASE_URL can point at an isolated PostgreSQL test instance.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function migrationUrl() {
  if (process.env.TEST_MIGRATION_DATABASE_URL) return process.env.TEST_MIGRATION_DATABASE_URL;
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL;
  const filename = path.join(root, ".env");
  const line = fs.existsSync(filename)
    ? fs.readFileSync(filename, "utf8").split(/\r?\n/).find(line => /^MIGRATION_DATABASE_URL=/.test(line))
    : undefined;
  assert.ok(line, "Set TEST_MIGRATION_DATABASE_URL or MIGRATION_DATABASE_URL before running migration tests");
  return line.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
}
const sourceUrl = new URL(migrationUrl());
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const name = `protocol_migration_test_${crypto.randomBytes(10).toString("hex")}`;
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const db = new pg.Client({ connectionString: testUrl.toString() });
let created = false;
let connected = false;
const testEnv = {
  ...process.env,
  MIGRATION_DATABASE_URL: testUrl.toString(),
  DATABASE_URL: testUrl.toString(),
  RUST_LOG: "warn",
};
function migrate(expectedError) {
  const result = spawnSync(path.join(root, "target/debug/protocol-server"), ["migrate"], {
    cwd: root, env: testEnv, encoding: "utf8", timeout: 120_000,
  });
  assert.ifError(result.error);
  if (expectedError) {
    assert.notEqual(result.status, 0, "Migration should reject this fixture");
    assert.match(result.stderr, expectedError);
  } else {
    assert.equal(result.status, 0, result.stderr || "Migration failed");
  }
}
async function rows(table) {
  return (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row);
}
await admin.connect();
try {
  // Reuse the deployment role; do not alter any cluster-wide user or privileges.
  assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='protocol_app') AS yes")).rows[0].yes, true,
    "The PostgreSQL test instance needs the protocol_app role");
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await db.connect();
  connected = true;
  await db.query("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)");
  for (const file of fs.readdirSync(path.join(root, "migrations")).filter(f => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 14).sort()) {
    const sql = fs.readFileSync(path.join(root, "migrations", file));
    await db.query(sql.toString());
    await db.query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES($1,$2,true,$3,0)", [
      Number(file.slice(0, 4)), file.slice(5, -4).replaceAll("_", " "),
      crypto.createHash("sha384").update(sql).digest(),
    ]);
  }
  const config = {
    version: 2,
    board_types: [{ code: "DSP", name: "DSP 功率板", model_code: "DSP", point_storage: "native", point_groups: [{ code: "LOCAL", name: "DSP 内部数据" }] }],
    root: { type: "DSP", quantity: 1 }, mounts: [],
  };
  await db.query("INSERT INTO users(id,username,display_name,password_hash,is_admin) VALUES(1,'migration_admin','Admin','unused',true),(2,'migration_member','Member','unused',false)");
  await db.query("INSERT INTO projects(id,name,config_key,topology_config) VALUES(1,'DC-UPS fixture','migration_test',$1),(2,'Other project','other',$1)", [config]);
  await db.query("INSERT INTO project_members(project_id,user_id,role,edit_scope) VALUES(1,2,'engineer','scoped')");
  await db.query("INSERT INTO sessions(token_hash,user_id) VALUES('migration-session',2)");
  await db.query("INSERT INTO project_edit_locks(project_id,user_id,expires_at) VALUES(1,2,now()+interval '5 minutes')");
  await db.query("INSERT INTO board_models(id,project_id,name,code) VALUES(7,1,'DSP','DSP')");
  await db.query("INSERT INTO protocol_contracts(id,project_id,name,code,protocol) VALUES(5,1,'Shared UPP','DSP_UPP','UPP')");
  await db.query("INSERT INTO endpoints(id,project_id,model_id,contract_id,name,code,role,transport) VALUES(10,1,7,5,'Primary','UPP_SERVICE','server','UNSPECIFIED'),(11,1,7,5,'Backup','UPP_BACKUP','server','UNSPECIFIED')");
  await db.query("INSERT INTO project_member_grants(project_id,user_id,model_id,scope,contract_id) VALUES(1,2,7,'internal',NULL),(1,2,7,'protocol',5)");
  await db.query("INSERT INTO process_points(id,project_id,board_key,group_key,name,enum_name,internal_type,byte_length) VALUES(88,1,'DSP','LOCAL','Saved point','SAVED_POINT','U16',2),(89,2,'DSP','LOCAL','Other project point','OTHER_POINT','U16',2)");
  await db.query("INSERT INTO transmit_points(id,project_id,board_key,process_point_id,name,upp_model,address,wire_type,wire_length) VALUES(99,1,'DSP',88,'Saved forwarding',1,6,'U16',2)");
  await db.query("INSERT INTO point_history(id,project_id,batch_id,batch_label,entity_type,record_id,board_key,action,after_data,actor_id,actor_name,project_revision,config_snapshot) VALUES(100,1,'00000000-0000-0000-0000-000000000001','fixture','process',88,'DSP','insert','{}',1,'Admin',1,$1)", [config]);
  await db.query("INSERT INTO audit_logs(project_id,user_id,action,entity,after_data) VALUES(1,1,'fixture.create','process_points','{}')");
  await db.query("INSERT INTO imports(project_id,filename,sha256,report,created_by) VALUES(1,'source.xlsx','fixture','{}',1)");
  await db.query("INSERT INTO releases(project_id,name,revision,snapshot,files,sha256,created_by) VALUES(1,'saved-release',1,'{}','{}','fixture',1)");
  await db.query("INSERT INTO change_previews(project_id,created_by,revision,change) VALUES(1,1,1,'{}')");
  await db.query("INSERT INTO import_previews(project_id,created_by,filename,sha256,revision,payload) VALUES(1,1,'old.xlsx','fixture',1,'{}')");

  const preservedTables = ["process_points", "transmit_points", "point_history", "users", "sessions", "project_members", "project_edit_locks", "audit_logs", "imports", "releases"];
  const preserved = {};
  for (const table of preservedTables) preserved[table] = await rows(table);
  const oldProjects = await rows("projects");
  const oldGrants = await rows("project_member_grants");
  const previews = { change_previews: await rows("change_previews"), import_previews: await rows("import_previews") };
  const oldLedger = await rows("_sqlx_migrations");
  async function unchangedAfterFailure() {
    assert.deepEqual(await rows("projects"), oldProjects);
    assert.deepEqual(await rows("project_member_grants"), oldGrants);
    assert.deepEqual(await rows("_sqlx_migrations"), oldLedger);
    for (const [table, expected] of Object.entries({ ...preserved, ...previews })) assert.deepEqual(await rows(table), expected, table);
  }

  // Unsupported old business rows must survive a failed upgrade untouched.
  await db.query("INSERT INTO data_items(project_id,name,data_type,byte_length,notes) VALUES(1,'Legacy saved value','U16',2,'must not disappear')");
  const legacy = await rows("data_items");
  migrate(/legacy table data_items contains data/);
  assert.deepEqual(await rows("data_items"), legacy);
  await unchangedAfterFailure();
  await db.query("DELETE FROM data_items");

  // Native endpoint JSON deliberately lacks these legacy connection settings.
  // Reject them explicitly rather than converting only the visible labels.
  for (const [table, change, reset] of [
    ["endpoints", "UPDATE endpoints SET port='/dev/ttyUSB0' WHERE id=10", "UPDATE endpoints SET port='' WHERE id=10"],
    ["endpoints", "UPDATE endpoints SET enabled=false WHERE id=10", "UPDATE endpoints SET enabled=true WHERE id=10"],
    ["endpoints", "UPDATE endpoints SET transport='CAN' WHERE id=10", "UPDATE endpoints SET transport='UNSPECIFIED' WHERE id=10"],
    ["protocol_contracts", "UPDATE protocol_contracts SET description='Saved protocol configuration notes' WHERE id=5", "UPDATE protocol_contracts SET description='' WHERE id=5"],
  ]) {
    await db.query(change);
    const legacyConfiguration = await rows(table);
    migrate(/legacy endpoint transport\/port\/disabled state or contract description has no JSON equivalent/);
    assert.deepEqual(await rows(table), legacyConfiguration);
    await unchangedAfterFailure();
    await db.query(reset);
  }

  // Fail after key conversion, preview deletion and revision updates to verify
  // SQLx wraps the entire DDL/data migration in one transaction.
  await db.query("CREATE VIEW migration_dependency AS SELECT id FROM board_models");
  migrate(/cannot drop .* because other objects depend on/);
  await unchangedAfterFailure();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n, 33);
  await db.query("DROP VIEW migration_dependency");

  migrate();
  const expectedTables = ["_sqlx_migrations", "audit_logs", "change_previews", "import_previews", "imports", "login_attempts", "point_history", "process_points", "project_edit_locks", "project_member_grants", "project_members", "projects", "releases", "sessions", "transmit_points", "users"];
  assert.deepEqual((await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(r => r.table_name), expectedTables);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.views WHERE table_schema='public'")).rows[0].n, 0);
  for (const [table, expected] of Object.entries(preserved)) assert.deepEqual(await rows(table), expected, table);
  for (const table of Object.keys(previews)) assert.deepEqual(await rows(table), []);
  assert.deepEqual((await db.query("SELECT board_key,scope,endpoint_key FROM project_member_grants ORDER BY scope,endpoint_key")).rows, [
    { board_key: "DSP", scope: "internal", endpoint_key: null },
    { board_key: "DSP", scope: "protocol", endpoint_key: "UPP_BACKUP" },
    { board_key: "DSP", scope: "protocol", endpoint_key: "UPP_SERVICE" },
  ]);
  const projects = await rows("projects");
  for (const project of projects) {
    const old = oldProjects.find(p => p.id === project.id);
    assert.equal(project.revision, old.revision + 1);
    assert.equal(project.schema_version, 3);
    for (const key of ["id", "name", "description", "config_key", "created_at"]) assert.deepEqual(project[key], old[key], key);
    assert.equal(project.topology_config.board_types[0].point_endpoints.some(e => e.code === "UPP_SERVICE"), true);
  }
  const first = projects.find(p => p.id === 1);
  assert.deepEqual(first.topology_config.board_types[0].point_endpoints, [
    { code: "UPP_BACKUP", name: "Backup", protocol: "UPP" },
    { code: "UPP_SERVICE", name: "Primary", protocol: "UPP" },
  ]);
  assert.equal((await db.query("SELECT max(version)::int AS n FROM _sqlx_migrations WHERE success")).rows[0].n, 15);
  for (const table of ["point_history", "audit_logs", "releases"]) {
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
      assert.equal((await db.query("SELECT has_table_privilege('protocol_app',$1,$2) AS yes", [table, privilege])).rows[0].yes, false, `${table}: ${privilege}`);
    }
  }
  await db.query("BEGIN; SET LOCAL ROLE protocol_app; SELECT set_config('app.user_id','2',true),set_config('app.project_id','1',true)");
  assert.deepEqual((await db.query("SELECT id FROM process_points ORDER BY id")).rows.map(r => r.id), ["88"]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM process_points WHERE project_id=2")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM point_history")).rows[0].n, 1);
  await db.query("ROLLBACK");

  // Running migrate again must not append histories, clear locks or bump revisions.
  const after = {};
  for (const table of expectedTables) after[table] = await rows(table);
  migrate();
  for (const [table, expected] of Object.entries(after)) assert.deepEqual(await rows(table), expected, `repeat: ${table}`);
  console.log("PASS: SQLx 14→15 leaves 16 tables; retains point IDs, history, accounts, locks and releases; remaps endpoint grants; rolls back unsupported data and late DDL failures; preserves RLS; repeated migration is idempotent.");
} finally {
  if (connected) await db.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
