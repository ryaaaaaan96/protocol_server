import fs from "node:fs";
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";

// Unlike legacy domain tests, every request here bypasses automatic test leases.
export async function checkEditLocks({ client, engineer, viewer, engineerId, viewerId, password, migrationUrl, equal, ok }) {
  const call = async (who, path, method = "GET", body) => {
    const result = await who.rawUnlocked(path, method, body);
    equal(result.status, 200);
    return result.data;
  };
  const project = await call(client, "/projects", "POST", { name: "Exclusive editing" });
  const url = `/projects/${project.id}`, lock = `${url}/edit-lock`;
  for (const [user_id, role] of [[engineerId, "engineer"], [viewerId, "viewer"]]) await call(client, `${url}/members`, "PUT", { user_id, role });
  const status = who => call(who, lock);
  const change = (who, operation) => call(who, `${lock}/${operation}`, "POST", {});
  const graph = () => call(client, `${url}/topology`);
  const draft = { revision: 1, entity: "data_items", operation: "create", values: { name: "Lease point", data_type: "U16", byte_length: 2 } };
  const empty = await status(client);
  equal(empty.locked, false);
  equal(empty.owned, false);
  equal(empty.owner, null);
  equal(empty.lease_seconds, 120);
  for (const [path, body] of [
    [`${url}/changes/preview`, draft],
    [`${url}/board-models/1/point-tables/process/batch/preview`, { revision: 1, rows: [{ row: 1, values: {} }] }],
    [`${url}/changes/99999/commit`, {}],
    [`${url}/releases`, { revision: 1, name: "Cannot publish without lease" }],
  ]) {
    const result = await client.rawUnlocked(path, "POST", body);
    equal(result.status, 423);
    equal(result.data.code, "EDIT_LOCK_REQUIRED");
  }
  equal((await viewer.rawUnlocked(`${lock}/acquire`, "POST", {})).status, 403);
  const acquired = await change(client, "acquire");
  equal(acquired.locked, true);
  equal(acquired.owned, true);
  ok(Date.parse(acquired.expires_at) - Date.now() > 110000);
  const readByOther = await status(engineer);
  equal(readByOther.locked, true);
  equal(readByOther.owned, false);
  equal(readByOther.owner.username, "test_admin");
  equal((await status(viewer)).owner.id, acquired.owner.id);
  for (const [path, body] of [
    [`${lock}/acquire`, {}], [`${lock}/renew`, {}], [`${lock}/release`, {}], [`${url}/changes/preview`, draft],
  ]) {
    const result = await engineer.rawUnlocked(path, "POST", body);
    equal(result.status, 423);
    equal(result.data.code, "PROJECT_EDIT_LOCKED");
    equal(result.data.lock.owner.id, acquired.owner.id);
  }
  equal((await change(client, "acquire")).owned, true); // The same account may resume its lease.
  const renewed = await change(client, "renew");
  ok(Date.parse(renewed.expires_at) >= Date.parse(acquired.expires_at));
  equal((await graph()).revision, 1);

  const preview = await call(client, `${url}/changes/preview`, "POST", draft);
  ok(preview.allowed);
  equal((await status(client)).owned, true);
  const invalid = await call(client, `${url}/changes/preview`, "POST", { ...draft, values: { ...draft.values, min_value: "10", max_value: "1" } });
  equal(invalid.allowed, false);
  equal((await status(client)).owned, true);
  equal((await client.rawUnlocked(`${url}/changes/99999/commit`, "POST", {})).status, 400);
  equal((await status(client)).owned, true);
  const committed = await call(client, `${url}/changes/${preview.id}/commit`, "POST", {});
  equal(committed.revision, 2);
  equal((await status(client)).locked, false);
  equal((await change(engineer, "acquire")).owned, true);
  const conflict = await engineer.rawUnlocked(`${url}/changes/preview`, "POST", draft);
  equal(conflict.status, 409);
  equal((await status(engineer)).owned, true);
  await change(engineer, "release");
  equal((await status(client)).locked, false);

  // Exactly one concurrent contender wins the same project row lock.
  const contenders = [client, engineer];
  const race = await Promise.all(contenders.map(who => who.rawUnlocked(`${lock}/acquire`, "POST", {})));
  equal(race.map(result => result.status).sort().join(","), "200,423");
  await change(contenders[race.findIndex(result => result.status === 200)], "release");

  // Expiry uses the database clock; forcing only this disposable fixture avoids sleeps.
  const database = new pg.Client({ connectionString: migrationUrl });
  await database.connect();
  try {
    await change(client, "acquire");
    await database.query("UPDATE project_edit_locks SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1", [project.id]);
    equal((await status(client)).locked, false);
    const expired = await client.rawUnlocked(`${lock}/renew`, "POST", {});
    equal(expired.status, 423);
    equal(expired.data.code, "EDIT_LOCK_REQUIRED");
    await change(engineer, "acquire");
    equal((await client.rawUnlocked(`${url}/changes/preview`, "POST", { ...draft, revision: 2 })).status, 423);
    await change(engineer, "release");
  } finally { await database.end(); }

  // Administrative membership changes remain available during someone else's edit.
  await change(engineer, "acquire");
  await call(client, `${url}/members`, "PUT", { user_id: engineerId, role: "viewer" });
  equal((await status(client)).locked, false);
  equal((await engineer.rawUnlocked(`${lock}/renew`, "POST", {})).status, 403);
  await change(client, "acquire");
  await call(client, `${url}/members`, "PUT", { user_id: engineerId, role: "engineer" });
  await change(client, "release");
  await change(engineer, "acquire");
  await call(client, `/users/${engineerId}`, "PUT", { active: false, is_admin: false });
  equal((await status(client)).locked, false);
  await change(client, "acquire");
  await call(client, `/users/${engineerId}`, "PUT", { active: true, is_admin: false });
  await call(engineer, "/auth/login", "POST", { username: "engineer", password });
  await change(client, "release");

  // Publishing is a successful configuration action and hands editing to the next user.
  await change(client, "acquire");
  equal((await client.rawUnlocked(`${url}/releases`, "POST", { revision: 2, name: "Missing board" })).status, 400);
  equal((await status(client)).owned, true);
  const create = async (entity, values) => {
    await change(client, "acquire");
    const p = await call(client, `${url}/changes/preview`, "POST", { revision: (await graph()).revision, entity, operation: "create", values });
    ok(p.allowed, JSON.stringify(p.errors));
    return (await call(client, `${url}/changes/${p.id}/commit`, "POST", {})).record;
  };
  const model = await create("board_models", { code: "LEASE_BOARD", name: "Lease board" });
  await create("boards", { model_id: model.id, code: "LEASE_1", name: "Lease board 1" });
  await change(client, "acquire");
  await call(client, `${url}/releases`, "POST", { revision: (await graph()).revision, name: "Lease release" });
  equal((await status(client)).locked, false);

  const imported = await call(client, "/projects", "POST", { name: "Exclusive import" });
  const importUrl = `/projects/${imported.id}`;
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync("UPM项目测点数据表.xlsx")]), "UPM.xlsx");
  equal((await client.rawUnlocked(`${importUrl}/imports/preview`, "POST", form)).status, 423);
  await call(client, `${importUrl}/edit-lock/acquire`, "POST", {});
  await change(engineer, "acquire"); // Different projects can be edited concurrently.
  const importPreview = await call(client, `${importUrl}/imports/preview`, "POST", form);
  equal((await call(client, `${importUrl}/edit-lock`)).owned, true);
  await call(client, `${importUrl}/imports/${importPreview.id}/commit`, "POST", { replace: false });
  equal((await call(client, `${importUrl}/edit-lock`)).locked, false);
  equal((await status(engineer)).owned, true);
  await change(engineer, "release");
  equal((await engineer.rawUnlocked(`${importUrl}/edit-lock`)).status, 403);
  console.log("PASS: explicit exclusive leases, atomic acquisition, renew/expiry, read-only observers, write enforcement, permission revocation and commit/import/release handoff");
}
