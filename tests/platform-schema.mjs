// Callers own populated, disposable v1 databases and run the real SQLx migrator.
import assert from "node:assert/strict";
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";

const schemas = {
  users: "auth", sessions: "auth", login_attempts: "auth",
  projects: "meta", project_members: "meta", project_member_grants: "meta",
  audit_logs: "history",
};
const rowValues = async (db, table) => (await db.query(
  `SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY 1`,
)).rows.map(row => row.value);
async function sequenceValues(db, grouped) {
  const values = {};
  for (const table of ["users", "projects", "audit_logs"]) {
    values[table] = (await db.query(`SELECT last_value::text AS value,is_called FROM ${grouped ? schemas[table] : "public"}.${table}_id_seq`)).rows[0];
  }
  return values;
}
async function allRows(db, grouped) {
  const values = {};
  for (const [table, schema] of Object.entries(schemas)) {
    values[table] = await rowValues(db, `${grouped ? schema : "public"}.${table}`);
  }
  return values;
}
const relationIdentities = async db => (await db.query(
  "SELECT c.oid::text,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth','meta','history') AND c.relkind IN ('r','i','S') AND c.relname NOT LIKE '_sqlx_migrations%' ORDER BY c.oid",
)).rows;

/** Capture v1 before a shared platform/project migration, then return its check. */
export async function preparePlatformSchema({ platform, runtimeUrl, runtimeRole }) {
  await platform.query("INSERT INTO public.users(id,username,display_name,password_hash,active,created_at) VALUES(2,'split_viewer','Viewer','fixture-viewer',true,'2026-01-02 00:00:00.123456+00'),(3,'split_disabled','Disabled','fixture-disabled',false,'2026-01-03 00:00:00.654321+00')");
  await platform.query("INSERT INTO public.project_members(project_id,user_id,role) VALUES(42,2,'viewer'),(41,3,'engineer')");
  await platform.query("INSERT INTO public.sessions(token_hash,user_id,expires_at) VALUES('viewer-session',2,'2030-01-02 12:34:56.123456+00')");
  await platform.query("SELECT setval('public.users_id_seq',9007199254750993,true),setval('public.projects_id_seq',6001,true),setval('public.audit_logs_id_seq',7001,true)");
  const before = {
    rows: await allRows(platform, false),
    sequences: await sequenceValues(platform, false),
    relations: await relationIdentities(platform),
    checksum: (await platform.query("SELECT encode(checksum,'hex') AS value FROM public._sqlx_migrations WHERE version=1")).rows[0].value,
  };
  assert.equal((await platform.query("SELECT count(*)::int AS n FROM public.users WHERE username='unknown'")).rows[0].n, 0, "failed-login fixture refers to no account");

  return async function verifyPlatformSchema(migrate) {
    const names = (await platform.query("SELECT table_schema||'.'||table_name AS name FROM information_schema.tables WHERE table_schema IN ('public','auth','meta','history') AND table_type='BASE TABLE' ORDER BY 1")).rows.map(row => row.name);
    assert.deepEqual(names, [
      "auth.login_attempts", "auth.sessions", "auth.users", "history.audit_logs",
      "meta.project_member_grants", "meta.project_members", "meta.projects", "public._sqlx_migrations",
    ], "platform retains exactly eight tables grouped by responsibility");
    assert.deepEqual(await allRows(platform, true), before.rows, "accounts, sessions, unknown-user attempts, registry, grants and audit preserve every field, ID and microsecond timestamp");
    assert.deepEqual(await sequenceValues(platform, true), before.sequences, "moving platform tables preserves exact sequence high-water marks");
    assert.deepEqual(await relationIdentities(platform), before.relations, "table, index and sequence OIDs and RLS settings survive schema moves");
    assert.equal((await platform.query("SELECT encode(checksum,'hex') AS value FROM public._sqlx_migrations WHERE version=1")).rows[0].value, before.checksum, "applied platform v1 remains unchanged");
    assert.equal((await platform.query("SELECT max(version)::int AS version FROM public._sqlx_migrations WHERE success")).rows[0].version, 2);
    for (const schema of ["auth", "meta", "history", "public"]) {
      assert.equal((await platform.query("SELECT has_schema_privilege($1,$2,'USAGE') AS yes", [runtimeRole, schema])).rows[0].yes, true);
      assert.equal((await platform.query("SELECT has_schema_privilege($1,$2,'CREATE') AS yes", [runtimeRole, schema])).rows[0].yes, false);
    }
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
      assert.equal((await platform.query("SELECT has_table_privilege($1,'history.audit_logs',$2) AS yes", [runtimeRole, privilege])).rows[0].yes, false);
    }
    assert.equal((await platform.query("SELECT has_table_privilege($1,'public._sqlx_migrations','SELECT') AS yes", [runtimeRole])).rows[0].yes, false);
    const protectedTables = (await platform.query("SELECT n.nspname||'.'||c.relname AS name,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('meta','history') AND c.relkind='r'")).rows;
    assert.equal(protectedTables.length, 4);
    assert.ok(protectedTables.every(table => table.relrowsecurity && table.relforcerowsecurity));

    // Cross-schema FKs, key uniqueness and scope checks remain database rules.
    await assert.rejects(platform.query("INSERT INTO auth.sessions(token_hash,user_id) VALUES('bad-reference',999999)"), { code: "23503" });
    await assert.rejects(platform.query("INSERT INTO meta.project_members(project_id,user_id,role) VALUES(999999,2,'viewer')"), { code: "23503" });
    await assert.rejects(platform.query("INSERT INTO meta.project_members(project_id,user_id,role) VALUES(41,2,'unknown')"), { code: "23514" });
    await assert.rejects(platform.query("INSERT INTO meta.project_members(project_id,user_id,role) VALUES(42,2,'viewer')"), { code: "23505" });
    await assert.rejects(platform.query("INSERT INTO meta.project_member_grants(project_id,user_id,board_key,scope) VALUES(42,9007199254740993,'DSP','internal')"), { code: "23503" });
    await assert.rejects(platform.query("INSERT INTO meta.project_member_grants(project_id,user_id,board_key,scope) VALUES(41,9007199254740993,'DSP','protocol')"), { code: "23514" });
    await assert.rejects(platform.query("INSERT INTO meta.project_member_grants(project_id,user_id,board_key,scope) VALUES(41,9007199254740993,'DSP','internal')"), { code: "23505" }, "NULL endpoint keys retain NULLS NOT DISTINCT uniqueness");
    await assert.rejects(platform.query("UPDATE meta.projects SET config_key='INVALID KEY' WHERE id=41"), { code: "23514" });
    await assert.rejects(platform.query("UPDATE meta.projects SET config_key=(SELECT config_key FROM meta.projects WHERE id=41) WHERE id=42"), { code: "23505" });
    await assert.rejects(platform.query("UPDATE auth.users SET username='split_admin' WHERE id=2"), { code: "23505" });

    const runtime = new pg.Client({ connectionString: runtimeUrl });
    await runtime.connect();
    const user = id => runtime.query("SELECT set_config('app.user_id',$1,false),set_config('app.project_id','',false)", [id]);
    try {
      for (const table of ["meta.projects", "meta.project_members", "meta.project_member_grants", "history.audit_logs"]) {
        assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, "no authorization context reveals no protected platform rows");
      }
      await user("9007199254740993");
      assert.deepEqual((await runtime.query("SELECT id::text FROM meta.projects ORDER BY id")).rows, [{ id: "41" }]);
      assert.equal((await runtime.query("SELECT public.app_can_access(41,true) AS yes")).rows[0].yes, true);
      assert.equal((await runtime.query("SELECT public.app_can_access(42,false) AS yes")).rows[0].yes, false);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM public.app_lock_project(41)")).rows[0].n, 1);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM public.app_lock_project(42)")).rows[0].n, 0);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM meta.project_member_grants")).rows[0].n, 1);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM history.audit_logs")).rows[0].n, 1, "members see project audit but no global login records");
      assert.equal((await runtime.query("UPDATE meta.projects SET name='forbidden' WHERE id=41")).rowCount, 0);
      await assert.rejects(runtime.query("INSERT INTO meta.project_members(project_id,user_id,role) VALUES(41,2,'engineer')"), { code: "42501" });
      await assert.rejects(runtime.query("INSERT INTO meta.project_member_grants(project_id,user_id,board_key,scope) VALUES(41,9007199254740993,'DSP','board')"), { code: "42501" });
      await assert.rejects(runtime.query("INSERT INTO history.audit_logs(project_id,user_id,action,entity) VALUES(41,1,'forged','users')"), { code: "42501" });
      await runtime.query("BEGIN");
      try {
        const event = (await runtime.query("INSERT INTO history.audit_logs(project_id,user_id,action,entity) VALUES(41,9007199254740993,'migration.test','projects') RETURNING id")).rows[0];
        assert.ok(BigInt(event.id) > 7001n, "new audit IDs cannot reuse historical sequence gaps");
      } finally { await runtime.query("ROLLBACK"); }
      await user("2");
      assert.deepEqual((await runtime.query("SELECT id::text FROM meta.projects ORDER BY id")).rows, [{ id: "42" }]);
      assert.equal((await runtime.query("SELECT public.app_can_access(42,true) AS yes")).rows[0].yes, false, "viewer remains read-only");
      await user("3");
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM meta.projects")).rows[0].n, 0, "disabled accounts cannot use old memberships");
      await user("1");
      assert.equal((await runtime.query("SELECT public.app_is_admin() AS yes")).rows[0].yes, true);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM meta.projects")).rows[0].n, 2);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM public.app_project_registry(41)")).rows[0].n, 1, "router registry helper resolves the moved composite row type");
      await assert.rejects(runtime.query("UPDATE history.audit_logs SET actor_name='overwritten'"), { code: "42501" });
      await assert.rejects(runtime.query("DELETE FROM history.audit_logs"), { code: "42501" });
      await assert.rejects(runtime.query("TRUNCATE history.audit_logs"), { code: "42501" });
      await assert.rejects(runtime.query("SELECT * FROM public._sqlx_migrations"), { code: "42501" });
    } finally { await runtime.end(); }

    // Failed writes and a rolled-back append consume sequence values, never data.
    const after = await allRows(platform, true), sequences = await sequenceValues(platform, true);
    assert.deepEqual(after, before.rows);
    migrate();
    assert.deepEqual(await allRows(platform, true), after, "repeat migrations do not rewrite platform records");
    assert.deepEqual(await sequenceValues(platform, true), sequences, "repeat migrations do not change platform sequence state");
    console.log("PASS: platform v2 retains eight grouped tables, exact rows/IDs/timestamps/sequences, existing sessions and unknown-user login attempts; FK/CHECK/UNIQUE, RLS and append-only audit remain effective; repeat migration is idempotent.");
  };
}
