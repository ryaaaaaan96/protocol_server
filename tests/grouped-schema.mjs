// Exercise a populated v1 project upgrade; callers own disposable databases.
import assert from "node:assert/strict";
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";

const pointColumns = "id,project_id,batch_id,batch_label,entity_type,record_id,board_key,group_key,action,before_data,after_data,actor_id,actor_name,project_revision,config_snapshot,created_at";
const rows = async (db, relation, columns = "*", filter = "") => (await db.query(
  `SELECT to_jsonb(row)::text AS value FROM (SELECT ${columns} FROM ${relation} ${filter} ORDER BY id) row`,
)).rows.map(row => row.value);

export async function checkGroupedSchema({ first, second, runtimeUrl, runtimeRole, migrate }) {
  // Equal IDs in the former preview tables, plus gaps from rolled-back inserts,
  // must not become valid preview handles after consolidation.
  await first.query("INSERT INTO change_previews(id,project_id,created_by,revision,change,merge_base) VALUES(7001,41,1,7,'{}','{}')");
  await first.query("INSERT INTO import_previews(id,project_id,created_by,filename,sha256,revision,payload) VALUES(7001,41,1,'pending.xlsx','pending',7,'{}')");
  await first.query("SELECT setval('change_previews_id_seq',8001,true),setval('import_previews_id_seq',9001,true),setval('point_history_id_seq',7001,true)");
  const before = {
    process: await rows(first, "process_points"),
    transmit: await rows(first, "transmit_points"),
    secondProcess: await rows(second, "process_points"),
    points: await rows(first, "point_history", pointColumns),
    audits: await rows(first, "audit_logs", "id,project_id,user_id,actor_name,action,entity,before_data,after_data,created_at"),
    imports: await rows(first, "imports"),
    releases: await rows(first, "releases"),
    lease: (await first.query("SELECT project_id::text,user_id::text,owner_name,owner_username,expires_at::text FROM project_edit_locks")).rows,
    checksum: (await first.query("SELECT encode(checksum,'hex') AS value FROM _sqlx_migrations WHERE version=1")).rows[0].value,
    sequences: await Promise.all([first, second].map(async db => (await db.query("SELECT last_value::text AS value,is_called FROM process_points_id_seq")).rows[0])),
  };
  migrate();
  const expectedTables = [
    "history.events", "history.releases", "meta.previews", "meta.project_state",
    "points.collect_points", "points.process_points", "points.transmit_points", "public._sqlx_migrations",
  ];
  for (const db of [first, second]) {
    const names = (await db.query("SELECT table_schema||'.'||table_name AS name FROM information_schema.tables WHERE table_schema IN ('public','points','history','meta') AND table_type='BASE TABLE' ORDER BY 1")).rows.map(row => row.name);
    assert.deepEqual(names, expectedTables, "project databases contain precisely eight grouped tables");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM meta.previews")).rows[0].n, 0, "old previews are invalidated");
    assert.equal((await db.query("SELECT schema_version FROM meta.project_state")).rows[0].schema_version, 6);
    assert.equal((await db.query("SELECT max(version)::int AS version FROM public._sqlx_migrations WHERE success")).rows[0].version, 3);
    assert.equal((await db.query("SELECT encode(checksum,'hex') AS value FROM public._sqlx_migrations WHERE version=1")).rows[0].value, before.checksum, "already applied migration remains unchanged");
    for (const table of ["history.events", "history.releases"]) {
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
        assert.equal((await db.query("SELECT has_table_privilege($1,$2,$3) AS yes", [runtimeRole, table, privilege])).rows[0].yes, false, `${table} is append-only for runtime`);
      }
    }
    const protectedTables = (await db.query("SELECT n.nspname||'.'||c.relname AS name,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('points','history','meta') AND c.relkind='r'")).rows;
    assert.equal(protectedTables.length, 7);
    assert.ok(protectedTables.every(table => table.relrowsecurity && table.relforcerowsecurity), "all business tables retain forced RLS");
    for (const schema of ["points", "history", "meta", "public"]) {
      assert.equal((await db.query("SELECT has_schema_privilege($1,$2,'CREATE') AS yes", [runtimeRole, schema])).rows[0].yes, false);
    }
  }
  assert.deepEqual(await rows(first, "points.process_points"), before.process, "all point values and IDs survive");
  assert.deepEqual((await first.query("SELECT (to_jsonb(t)-'register_type'-'metadata')::text AS value FROM points.transmit_points t ORDER BY id")).rows.map(row=>row.value), before.transmit);
  assert.deepEqual(await rows(second, "points.process_points"), before.secondProcess);
  assert.deepEqual(await rows(first, "history.events", pointColumns, "WHERE kind='point'"), before.points, "point history retains exact before/after JSON, IDs, times, and snapshots");
  assert.deepEqual(await rows(first, "history.events", "legacy_id AS id,project_id,actor_id AS user_id,actor_name,action,entity,before_data,after_data,created_at", "WHERE kind='audit'"), before.audits, "audit history retains source IDs and actor snapshots");
  assert.deepEqual(await rows(first, "history.events", "legacy_id AS id,project_id,metadata->>'filename' AS filename,metadata->>'sha256' AS sha256,metadata->'report' AS report,actor_id AS created_by,actor_name AS created_by_name,created_at", "WHERE kind='import'"), before.imports, "import history retains all original metadata");
  assert.deepEqual(await rows(first, "history.releases"), before.releases, "release snapshots and generated files remain byte-for-byte equivalent");
  assert.deepEqual((await first.query("SELECT id::text AS project_id,edit_owner_id::text AS user_id,edit_owner_name AS owner_name,edit_owner_username AS owner_username,edit_expires_at::text AS expires_at FROM meta.project_state")).rows, before.lease);
  assert.deepEqual((await first.query("SELECT legacy_source,legacy_id::text FROM history.events ORDER BY legacy_source,legacy_id")).rows, [
    { legacy_source: "audit_logs", legacy_id: "202" },
    { legacy_source: "audit_logs", legacy_id: "203" },
    { legacy_source: "imports", legacy_id: "301" },
    { legacy_source: "point_history", legacy_id: "101" },
  ]);
  assert.equal((await first.query("SELECT revision FROM meta.project_state")).rows[0].revision, 9, "each schema upgrade invalidates stale revision-based drafts");
  assert.deepEqual(await Promise.all([first, second].map(async db => (await db.query("SELECT last_value::text AS value,is_called FROM points.process_points_id_seq")).rows[0])), before.sequences, "moving tables preserves exact sequence high-water marks, including rolled-back IDs");
  assert.ok(BigInt((await first.query("SELECT nextval('history.events_id_seq')::text AS value")).rows[0].value) > 7001n);
  assert.ok(BigInt((await first.query("SELECT nextval('meta.previews_id_seq')::text AS value")).rows[0].value) > 9001n);
  await assert.rejects(first.query("INSERT INTO points.transmit_points(project_id,board_key,process_point_id,name,upp_model,address,wire_type,wire_length) VALUES(41,'UPM',9007199254740995,'Wrong board',1,4,'U16',2)"), /foreign key/, "cross-board reference constraint survives schema moves");
  await assert.rejects(first.query("INSERT INTO history.events(project_id,kind,action,actor_id) VALUES(41,'point','update',1)"), /check constraint/, "point events require meaningful before/after and identity fields");
  await assert.rejects(first.query("INSERT INTO history.events(project_id,kind,action,actor_id) VALUES(41,'import','import.complete',1)"), /check constraint/, "import events require filename/hash/report");

  const runtime = new pg.Client({ connectionString: runtimeUrl });
  await runtime.connect();
  try {
    for (const table of ["points.process_points", "history.events", "history.releases", "meta.project_state", "meta.previews"]) {
      assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, "no authorization context reveals no rows");
    }
    const access = JSON.stringify({ role: "engineer", edit_scope: "all", grants: [] });
    await runtime.query("SELECT set_config('app.user_id','1',false),set_config('app.project_id','41',false),set_config('app.access',$1,false)", [access]);
    assert.equal((await runtime.query("SELECT count(*)::int AS n FROM history.events")).rows[0].n, 4);
    assert.equal((await runtime.query("SELECT count(*)::int AS n FROM points.process_points")).rows[0].n, 1);
    await runtime.query("SELECT set_config('app.project_id','42',false)");
    assert.equal((await runtime.query("SELECT count(*)::int AS n FROM history.events")).rows[0].n, 0, "wrong project context cannot read events");
    await runtime.query("SELECT set_config('app.project_id','41',false)");
    await assert.rejects(runtime.query("UPDATE history.events SET actor_name='overwrite'"), /permission denied/);
    await assert.rejects(runtime.query("DELETE FROM history.releases"), /permission denied/);
    await assert.rejects(runtime.query("TRUNCATE history.events"), /permission denied/);
    await assert.rejects(runtime.query("INSERT INTO history.events(project_id,kind,action,actor_id,legacy_source,legacy_id) VALUES(41,'audit','forged',1,'audit_logs',9999)"), /row-level security/, "runtime cannot forge legacy history identity");
    await assert.rejects(runtime.query("INSERT INTO history.events(project_id,kind,action,actor_id) VALUES(41,'audit','forged',2)"), /row-level security/, "actor identity must match authenticated user");
    const change = (await runtime.query("INSERT INTO meta.previews(project_id,kind,created_by,revision,payload) VALUES(41,'change',1,8,'{}') RETURNING id")).rows[0].id;
    assert.ok(BigInt(change) > 9001n);
    await assert.rejects(runtime.query("INSERT INTO meta.previews(project_id,kind,created_by,revision,payload) VALUES(41,'import',1,8,'{}')"), /check constraint/);
    await runtime.query("SELECT set_config('app.user_id','2',false)");
    assert.equal((await runtime.query("SELECT count(*)::int AS n FROM meta.previews")).rows[0].n, 0, "other editors cannot read a private preview");
    assert.equal((await runtime.query("DELETE FROM meta.previews WHERE id=$1", [change])).rowCount, 0, "other editors cannot consume a preview");
    await runtime.query("SELECT set_config('app.user_id','1',false),set_config('app.access',$1,false)", [JSON.stringify({ role: "viewer", edit_scope: "all", grants: [] })]);
    await assert.rejects(runtime.query("INSERT INTO meta.previews(project_id,kind,created_by,revision,payload) VALUES(41,'change',1,8,'{}')"), /row-level security/);
    await assert.rejects(runtime.query("INSERT INTO history.events(project_id,kind,action,actor_id,metadata) VALUES(41,'import','import.complete',1,'{\"filename\":\"x.xlsx\",\"sha256\":\"x\",\"report\":{}}')"), /row-level security/);
    await runtime.query("SELECT set_config('app.access',$1,false)", [access]);
    await runtime.query("DELETE FROM meta.previews WHERE id=$1", [change]);
  } finally {
    await runtime.end();
  }
  const after = await rows(first, "history.events");
  migrate();
  assert.equal((await first.query("SELECT revision FROM meta.project_state")).rows[0].revision, 9, "repeating migrate must not increment revision");
  assert.deepEqual(await rows(first, "history.events"), after, "repeating migrate creates no duplicate history");
  console.log("PASS: grouped-schema v3 preserves exact point/history/release/lease data, legacy event identities and sequence high-water marks; stale previews expire; eight tables retain RLS and append-only history; repeat migration is idempotent.");
}
