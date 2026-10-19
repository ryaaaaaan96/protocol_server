// Physical database routing and cross-database authorization integration checks.
// All connection strings and fixture directories belong to integration.mjs.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const quote = identifier => `"${identifier.replaceAll('"', '""')}"`;
const databaseName = key => `protocol_project_${key.replaceAll("-", "_")}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Observe actual PostgreSQL blocking instead of assuming HTTP requests reached
// the critical section after an arbitrary sleep.
async function waitForBlocked(observer, database, blocker, label, finished = () => false) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await observer.query(`
      SELECT pid FROM pg_stat_activity
      WHERE datname=$1 AND wait_event_type='Lock'
        AND cardinality(pg_blocking_pids(pid))>0
        AND ($2::int IS NULL OR $2=ANY(pg_blocking_pids(pid)))`, [database, blocker]);
    if (result.rows.length) return;
    if (finished()) throw new Error(`${label}: request completed before the required lock was released`);
    await delay(25);
  }
  throw new Error(`${label}: PostgreSQL did not reach the expected blocked state`);
}

function tracked(request) {
  const state = { finished: false, promise: null };
  state.promise = request.then(
    response => { state.finished = true; return response; },
    error => { state.finished = true; return { status: 0, data: { error: error.message } }; },
  );
  return state;
}

export async function checkProjectDatabases({
  client, engineer, viewer, engineerId, viewerId, migrationUrl, testEnv,
  projectConfigs, fixtureSource, fixtureKey, equal, ok,
}) {
  const { default: pg } = await import(fileURLToPath(new URL("../.runtime/db-tools/node_modules/pg/lib/index.js", import.meta.url)));
  const platform = new pg.Client({ connectionString: String(migrationUrl) });
  const platformName = decodeURIComponent(new URL(migrationUrl).pathname.slice(1));
  const fixture = base => {
    const key = fixtureKey(base);
    const directory = path.join(projectConfigs, key);
    fs.cpSync(fixtureSource, directory, { recursive: true, errorOnExist: true, force: false });
    const filename = path.join(directory, "project.json");
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    manifest.key = key;
    manifest.name = key;
    manifest.workbook = null;
    delete manifest.dump;
    for (const entry of fs.readdirSync(directory)) {
      if (entry.toLowerCase().endsWith(".dump")) fs.rmSync(path.join(directory, entry));
    }
    fs.writeFileSync(filename, JSON.stringify(manifest));
    return key;
  };
  const openBusiness = async name => {
    const url = new URL(migrationUrl);
    url.pathname = `/${name}`;
    const connection = new pg.Client({ connectionString: url.toString() });
    await connection.connect();
    return connection;
  };
  const foreignDatabases = [];
  const businessConnections = [];
  await platform.connect();
  try {
    // Neither an occupied database nor an unrelated empty database may be
    // adopted merely because its name matches the new project's key.
    for (const occupied of [true, false]) {
      const key = fixture(occupied ? "foreign_data" : "foreign_empty");
      const name = databaseName(key);
      const marker = `integration-foreign:${randomUUID()}`;
      const exists = (await platform.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount;
      equal(exists, 0);
      await platform.query(`CREATE DATABASE ${quote(name)}`);
      foreignDatabases.push({ name, marker });
      await platform.query(`COMMENT ON DATABASE ${quote(name)} IS '${marker}'`);
      const foreign = await openBusiness(name);
      try {
        if (occupied) {
          await foreign.query("CREATE TABLE sentinel(value TEXT NOT NULL)");
          await foreign.query("INSERT INTO sentinel VALUES($1)", [marker]);
        }
        equal((await client.raw("/projects", "POST", { config_key: key })).status, 409);
        const tables = (await foreign.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
        equal(JSON.stringify(tables), JSON.stringify(occupied ? ["sentinel"] : []));
        if (occupied) equal((await foreign.query("SELECT value FROM sentinel")).rows[0].value, marker);
        equal((await platform.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name])).rows[0].marker, marker);
        ok(!(await client.call("/projects")).some(project => project.config_key === key), "failed foreign-database creation stays hidden");
      } finally { await foreign.end(); }
    }

    // Keys remain distinct; two keys normalizing to one physical database must
    // never bind to the same existing project's data.
    const firstKey = fixture("collision-a");
    const secondKey = fixture("collision_a");
    equal(databaseName(firstKey), databaseName(secondKey));
    const first = await client.call("/projects", "POST", { config_key: firstKey });
    equal((await client.raw("/projects", "POST", { config_key: secondKey })).status, 409);
    equal((await platform.query("SELECT count(*)::int AS count FROM projects WHERE config_key=$1", [secondKey])).rows[0].count, 0);
    const registry = (await platform.query("SELECT * FROM projects WHERE id=$1", [first.id])).rows[0];
    const isolated = await openBusiness(registry.database_name);
    businessConnections.push(isolated);
    const topologyUrl = `/projects/${first.id}/topology`;
    equal((await client.call(topologyUrl)).process_points.length, 0);

    // Warm the route cache, alter each side's immutable identity independently,
    // and require rejection even though the same id, key and database still exist.
    for (const [connection, table] of [[platform, "projects"], [isolated, "meta.project_state"]]) {
      try {
        await connection.query(`UPDATE ${table} SET project_uid=$2 WHERE id=$1`, [first.id, randomUUID()]);
        equal((await client.raw(topologyUrl)).status, 409);
      } finally {
        await connection.query(`UPDATE ${table} SET project_uid=$2 WHERE id=$1`, [first.id, registry.project_uid]);
      }
      equal((await client.call(topologyUrl)).process_points.length, 0);
    }

    const securityKey = fixture("auth_serial");
    const security = await client.call("/projects", "POST", { config_key: securityKey });
    const url = `/projects/${security.id}`;
    for (const [user_id, role] of [[engineerId, "engineer"], [viewerId, "viewer"]]) {
      await client.call(`${url}/members`, "PUT", { user_id, role, edit_scope: "all", grants: [] });
    }
    const business = await openBusiness(databaseName(securityKey));
    businessConnections.push(business);
    const create = await client.call(`${url}/boards/DSP/point-tables/process/preview`, "POST", {
      revision: (await client.call(`${url}/topology`)).revision,
      operation: "create", values: { group_key: "LOCAL", name: "独立业务库测试点", enum_name: "AUTH_GUARD_POINT", internal_type: "U16", element_count: 1 },
    });
    ok(create.allowed, JSON.stringify(create.errors));
    const point = (await client.call(`${url}/changes/${create.id}/commit`, "POST", {})).record;
    equal((await isolated.query("SELECT count(*)::int AS count FROM points.process_points")).rows[0].count, 0);
    equal((await viewer.call(`${url}/topology`)).process_points.length, 1);
    equal((await viewer.raw(topologyUrl)).status, 403);

    // Exceed the platform pool size: each authorized project read must progress
    // without needing a second platform connection while holding the first.
    const reads = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      client.raw(index % 2 ? topologyUrl : `${url}/topology`)));
    for (const response of reads) equal(response.status, 200);

    equal((await engineer.rawUnlocked(`${url}/edit-lock/acquire`, "POST", {})).status, 200);
    const graph = await engineer.call(`${url}/topology`);
    const proposal = await engineer.rawUnlocked(`${url}/boards/DSP/point-tables/process/preview`, "POST", {
      revision: graph.revision, operation: "update", id: point.id, values: { name: "撤权前已经授权的提交" },
    });
    equal(proposal.status, 200);
    ok(proposal.data.allowed, JSON.stringify(proposal.data.errors));
    const historyBefore = (await business.query("SELECT count(*)::int AS count FROM history.events WHERE kind='point'")).rows[0].count;
    let writing, revoking;
    try {
      await business.query("BEGIN");
      await business.query("SELECT id FROM meta.project_state WHERE id=$1 FOR UPDATE", [security.id]);
      const blocker = (await business.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      writing = tracked(engineer.rawUnlocked(`${url}/changes/${proposal.data.id}/commit`, "POST", {}));
      await waitForBlocked(platform, databaseName(securityKey), blocker, "point commit", () => writing.finished);
      revoking = tracked(client.rawUnlocked(`${url}/members`, "PUT", { user_id: engineerId, role: "viewer" }));
      await waitForBlocked(platform, platformName, null, "membership revocation", () => revoking.finished);
      equal(writing.finished, false);
      equal(revoking.finished, false);
      await business.query("COMMIT");
      equal((await writing.promise).status, 200);
      equal((await revoking.promise).status, 200);
      equal((await business.query("SELECT name FROM points.process_points WHERE id=$1", [point.id])).rows[0].name, "撤权前已经授权的提交");
      equal((await business.query("SELECT count(*)::int AS count FROM history.events WHERE kind='point'")).rows[0].count, historyBefore + 1);
      equal((await viewer.call(`${url}/topology`)).revision, graph.revision + 1);
      equal((await engineer.rawUnlocked(`${url}/edit-lock/acquire`, "POST", {})).status, 403);
      equal((await engineer.rawUnlocked(`${url}/boards/DSP/point-tables/process/preview`, "POST", {
        revision: graph.revision + 1, operation: "update", id: point.id, values: { name: "撤权后不得写入" },
      })).status, 403);
      equal((await business.query("SELECT name FROM points.process_points WHERE id=$1", [point.id])).rows[0].name, "撤权前已经授权的提交");
      equal((await business.query("SELECT count(*)::int AS count FROM history.events WHERE kind='point'")).rows[0].count, historyBefore + 1);
    } finally {
      await business.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([writing?.promise, revoking?.promise].filter(Boolean));
      await client.call(`${url}/members`, "PUT", { user_id: engineerId, role: "engineer", edit_scope: "all", grants: [] });
      await engineer.rawUnlocked(`${url}/edit-lock/release`, "POST", {});
    }
    console.log("PASS: foreign database preservation, normalized-key collisions, routing identity, concurrent pool access and serialized permission revocation");
  } finally {
    await Promise.allSettled(businessConnections.map(connection => connection.end()));
    for (const { name, marker } of foreignDatabases) {
      const current = (await platform.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [name])).rows[0]?.marker;
      if (current === marker) await platform.query(`DROP DATABASE ${quote(name)} WITH (FORCE)`);
    }
    await platform.end();
  }
}
