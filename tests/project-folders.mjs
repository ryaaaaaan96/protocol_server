// Real project-folder uploads and native PostgreSQL archive round-trips.
// integration.mjs supplies a disposable database and configuration directory.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "../.runtime/db-tools/node_modules/pg/lib/index.js";
import { exportProject } from "../scripts/export-project.mjs";

function folderFiles(directory) {
  const files = new Map();
  const walk = (relative = "") => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else files.set(name, fs.readFileSync(path.join(directory, name)));
    }
  };
  walk();
  return files;
}
function fingerprint(directory) {
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of folderFiles(directory)) hash.update(name).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
}
function form(files, rootName = "downloaded-project") {
  const body = new FormData();
  for (const [relative, bytes] of files) body.append("files", new Blob([bytes]), `${rootName}/${relative}`);
  return body;
}
function json(files, name, update) {
  const value = JSON.parse(files.get(name).toString());
  update(value);
  files.set(name, Buffer.from(JSON.stringify(value)));
  return value;
}

// Modify a trusted archive produced above inside an isolated scratch database,
// then generate real legacy-compatible and incompatible archives for HTTP checks.
async function archiveVariant(source, destination, testEnv, versions) {
  const adminUrl = new URL(testEnv.MIGRATION_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const temporaryName = `protocol_folder_archive_${crypto.randomBytes(8).toString("hex")}`;
  const temporaryUrl = new URL(adminUrl);
  temporaryUrl.pathname = `/${temporaryName}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  const database = new pg.Client({ connectionString: temporaryUrl.toString() });
  const nativeUrl = new URL(temporaryUrl);
  const nativeEnv = { ...testEnv, PGPASSWORD: decodeURIComponent(nativeUrl.password) };
  nativeUrl.password = "";
  const native = (binary, args) => execFileSync(binary, args, { env: nativeEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${temporaryName}"`);
    created = true;
    native(testEnv.PG_RESTORE_BIN || "pg_restore", ["--exit-on-error", "--no-owner", `--dbname=${nativeUrl}`, source]);
    await database.connect();
    await database.query("UPDATE public.protocol_studio_project_dump SET payload=(payload::jsonb || $1::jsonb)::text", [JSON.stringify(versions)]);
    native(testEnv.PG_DUMP_BIN || "pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--table=public.protocol_studio_project_dump", `--file=${destination}`, `--dbname=${nativeUrl}`]);
  } finally {
    await database.end();
    if (created) await admin.query(`DROP DATABASE "${temporaryName}" WITH (FORCE)`);
    await admin.end();
  }
}

export async function checkProjectFolders({ client, engineer, viewer, engineerId, viewerId, password, makeClient, projectConfigs, fixtureSource, testEnv, equal, ok, fixtureKey }) {
  const key = fixtureKey("folder_import");
  const directory = path.join(projectConfigs, key);
  const files = folderFiles(fixtureSource);
  json(files, "project.json", manifest => Object.assign(manifest, { key, name: "Folder import fixture", description: "Original folder" }));
  const preview = (entries = files, who = client, rootName) => who.rawUnlocked("/project-folders/preview", "POST", form(entries, rootName));
  const commit = (token, who = client) => who.rawUnlocked("/project-folders/commit", "POST", { token });
  const checked = async (entries = files) => {
    const result = await preview(entries);
    ok(result.status === 200, `Folder preview: ${JSON.stringify(result)}`);
    return result.data;
  };
  const saved = async token => {
    const result = await commit(token);
    ok(result.status === 200, `Folder commit: ${JSON.stringify(result)}`);
    return result.data;
  };
  const untouched = (await client.call("/projects")).find(project => [fixtureKey("dsp_native"),fixtureKey("cli")].includes(project.config_key));
  const unrelatedBefore = JSON.stringify(await client.call(`/projects/${untouched.id}/topology`));
  const projectsBefore = JSON.stringify(await client.call("/projects"));
  equal((await preview(new Map(), makeClient())).status, 401);
  equal((await preview(new Map(), engineer)).status, 403);
  equal((await preview(new Map(), viewer)).status, 403);
  const initial = await checked();
  equal(initial.key, key);
  equal(initial.existing_project_id, null);
  equal(initial.replace_data, false);
  equal(initial.summary.signal_count, 0); // A workbook is an asset, not a replacement trigger.
  equal(fs.existsSync(directory), false);
  equal(JSON.stringify(await client.call("/projects")), projectsBefore);
  const created = await saved(initial.token);
  equal(created.replace_data, false);
  equal(fs.existsSync(path.join(directory, "project.json")), true);
  equal((await commit(initial.token)).status, 400);
  const url = `/projects/${created.project_id}`;
  const graph = () => client.call(`${url}/topology`);
  equal((await graph()).process_points.length, 0);
  equal((await graph()).transmit_points.length, 0);
  equal((await client.call("/project-templates")).some(project => project.key === key), true);
  const edit = async (entity, values, id = null) => {
    const prepared = await client.call(`${url}/changes/preview`, "POST", { revision: (await graph()).revision, entity, values: {board_key:"DSP",fields:values}, id, operation: id ? "update" : "create" });
    ok(prepared.allowed, JSON.stringify(prepared.errors));
    return (await client.call(`${url}/changes/${prepared.id}/commit`, "POST", {})).record;
  };
  const signal = await edit("process_points", {name:"Portable signal",enum_name:"PORTABLE_VOLTAGE",sig_id:1,
    group_key:"LOCAL",internal_type:"U16",element_count:1,byte_length:2,unit:"V",notes:"Round trip: 中文\tnewline\n\\slash",
    min_value:"0",max_value:"100",default_value:"3",boot_restore:true,category:"系统参数2"});
  await edit("transmit_points", {process_point_id:signal.id,endpoint_key:"UPP_SERVICE",name:"Voltage field",
    upp_model:2,address:6,wire_type:"U16",wire_length:2,scale:1,access:"RO",byte_order:0,conversion:"identity",enabled:true});
  await client.call(`${url}/members`, "PUT", { user_id: engineerId, role: "engineer", edit_scope: "scoped", grants: [
    { board_key: "DSP", scope: "internal" },
    { board_key: "DSP", scope: "protocol", endpoint_key: "UPP_SERVICE" },
  ] });
  await client.call(`${url}/members`, "PUT", { user_id: viewerId, role: "viewer" });
  const release = await client.call(`${url}/releases`, "POST", { revision: (await graph()).revision, name: "Before folder replacement" });
  const releasesBefore = JSON.stringify(await client.call(`${url}/releases`));
  ok(release.sha256);

  // Preview performs the real validation in a rolled-back transaction.
  fs.writeFileSync(path.join(directory, "obsolete.txt"), "remove on replacement");
  json(files, "project.json", manifest => {
    manifest.name = "Replaced folder fixture";
    manifest.description = "Folder config changed without data replacement";
    manifest.topology.board_types.push({ code: "EXTRA", model_code: "EXTRA", name: "Added board", directory: "ExtraBoard" });
    manifest.topology.mounts.push({ parent: manifest.topology.root.type, child: "EXTRA", quantity: 1, connections: [] });
    manifest.workspace.boards.EXTRA = { tables: [] };
  });
  for (const kind of ["process", "collect", "transmit"]) files.set(`ExtraBoard/${kind}.json`, files.get(`UPM/${kind}.json`));
  json(files, "DSP/process.json", table => { table.label = "Imported DSP data"; table.fields.name.label = "Imported name"; });
  const before = await graph(), auditBefore = JSON.stringify(await client.call(`${url}/audit`));
  const hashBefore = fingerprint(directory);
  const replacement = await checked();
  equal(replacement.existing_project_id, created.project_id);
  equal(replacement.replace_data, false);
  equal(JSON.stringify(await graph()), JSON.stringify(before));
  equal(JSON.stringify(await client.call(`${url}/audit`)), auditBefore);
  equal(fingerprint(directory), hashBefore);

  // Preview ownership must hold even when both users are administrators.
  await client.call("/users", "POST", { username: "folder_other_admin", display_name: "Other folder administrator", password, is_admin: true });
  const otherAdmin = makeClient();
  await otherAdmin.call("/auth/login", "POST", { username: "folder_other_admin", password });
  equal((await commit(replacement.token, otherAdmin)).status, 403);
  const installed = await saved(replacement.token);
  equal(installed.revision, before.revision + 1);
  equal(installed.project_id, created.project_id);
  equal(fs.existsSync(path.join(directory, "obsolete.txt")), false);
  const after = await graph();
  equal(JSON.stringify(after.process_points), JSON.stringify(before.process_points));
  equal(JSON.stringify(after.transmit_points), JSON.stringify(before.transmit_points));
  equal(after.project_config.board_types.some(board => board.code === "EXTRA"), true);
  const schema = await client.call(`${url}/point-tables/schema`);
  equal(schema.boards.DSP.process.label, "Imported DSP data");
  equal(schema.boards.DSP.process.fields.name.label, "Imported name");
  equal(Object.hasOwn(schema.boards, "EXTRA"), true);
  equal((await client.call("/projects")).find(project => project.id === created.project_id).name, "Replaced folder fixture");

  // Conflicts in either DB revision or files require a new preview and preserve both resources.
  const staleFiles = await checked();
  const sshTable = path.join(directory, "DSP/process.json");
  const sshDefinition = JSON.parse(fs.readFileSync(sshTable, "utf8"));
  sshDefinition.label = "SSH changed label";
  fs.writeFileSync(sshTable, JSON.stringify(sshDefinition));
  equal((await client.call(`${url}/point-tables/schema`)).boards.DSP.process.label, "SSH changed label");
  equal((await commit(staleFiles.token)).status, 409);
  equal((await graph()).revision, after.revision);
  equal(JSON.parse(fs.readFileSync(sshTable)).label, "SSH changed label");
  const staleData = await checked();
  await edit("process_points", { name: "Concurrent saved signal" }, signal.id);
  const afterConcurrent = await graph(), afterConcurrentFiles = fingerprint(directory);
  equal((await commit(staleData.token)).status, 409);
  equal(JSON.stringify(await graph()), JSON.stringify(afterConcurrent));
  equal(fingerprint(directory), afterConcurrentFiles);
  const leased = await checked();
  equal((await engineer.rawUnlocked(`${url}/edit-lock/acquire`, "POST", {})).status, 200);
  try {
    equal((await preview()).status, 423);
    equal((await commit(leased.token)).status, 423);
    equal(JSON.stringify(await graph()), JSON.stringify(afterConcurrent));
  } finally {
    equal((await engineer.rawUnlocked(`${url}/edit-lock/release`, "POST", {})).status, 200);
  }

  for (const invalidName of ["../escape.json", "/absolute.json", "bad\\path.json", ".hidden/file.json"]) {
    const invalid = new Map(files);
    invalid.set(invalidName, Buffer.from("{}"));
    equal((await preview(invalid)).status, 400);
  }
  const mixed = form(files);
  mixed.append("files", new Blob(["{}"]), "other-root/project.json");
  equal((await client.rawUnlocked("/project-folders/preview", "POST", mixed)).status, 400);
  const duplicated = form(files);
  duplicated.append("files", new Blob(["{}"]), "downloaded-project/project.json");
  equal((await client.rawUnlocked("/project-folders/preview", "POST", duplicated)).status, 400);
  equal(fingerprint(directory), afterConcurrentFiles);

  // A genuine native archive replaces this project's rows; all references receive
  // new IDs, while grants, audit history, releases and the other project survive.
  const exportParent = fs.mkdtempSync(path.resolve(".runtime/folder-export-test-"));
  try {
    const exported = await exportProject(key, exportParent, testEnv);
    const archive = path.join(exported.directory, "project.dump");
    equal(fs.readFileSync(archive).subarray(0, 5).toString(), "PGDMP");
    const dumpFiles = folderFiles(exported.directory);
    const exportedGraph = await graph();
    await edit("process_points", { name: "Must be replaced by Dump" }, signal.id);
    await edit("process_points", { name: "New after export", enum_name: "NEW_AFTER_EXPORT", sig_id: 2 });
    const mutated = await graph(), members = await client.call(`${url}/members`);
    const history = await client.call(`${url}/audit`), filesBeforeDump = fingerprint(directory);
    const legacy = path.join(exportParent, "legacy-v4.dump");
    await archiveVariant(archive, legacy, testEnv, { schema_version: 4, migration_version: 1 });
    const legacyFiles = new Map(dumpFiles);
    legacyFiles.set("project.dump", fs.readFileSync(legacy));
    const dumpPreview = await checked(legacyFiles);
    equal(dumpPreview.replace_data, true);
    equal(dumpPreview.summary.signal_count, exportedGraph.process_points.length);
    equal(JSON.stringify(await graph()), JSON.stringify(mutated));
    equal(fingerprint(directory), filesBeforeDump);
    const restored = await saved(dumpPreview.token);
    equal(restored.replace_data, true);
    equal(restored.revision, mutated.revision + 1);
    const restoredGraph = await graph();
    equal(restoredGraph.process_points.length, exportedGraph.process_points.length);
    equal(restoredGraph.process_points[0].name, exportedGraph.process_points[0].name);
    ok(restoredGraph.process_points[0].id !== exportedGraph.process_points[0].id);
    equal(restoredGraph.process_points[0].notes, exportedGraph.process_points[0].notes);
    equal(restoredGraph.process_points[0].group_key,"LOCAL");
    equal(restoredGraph.process_points[0].default_value,"3");
    equal(restoredGraph.transmit_points[0].process_point_id,restoredGraph.process_points[0].id);
    equal(restoredGraph.transmit_points[0].endpoint_key,"UPP_SERVICE");
    const restoredMembers = await client.call(`${url}/members`);
    equal(restoredMembers.length, members.length);
    const scoped = restoredMembers.find(member => member.id === engineerId);
    equal(scoped.edit_scope, "scoped");
    equal(scoped.grants.length, 2);
    equal(scoped.grants.every(grant => grant.board_key === "DSP"), true);
    equal(scoped.grants.find(grant => grant.scope === "protocol").endpoint_key, "UPP_SERVICE");
    equal(JSON.stringify(await client.call(`${url}/releases`)), releasesBefore);
    const restoredAudit = await client.call(`${url}/audit`);
    equal(restoredAudit.length, history.length + 1);
    equal(history.every(entry => restoredAudit.some(saved => saved.id === entry.id)), true);
    equal(restoredAudit[0].after_data.replace_data, true);

    // Invalid archives and schema mismatches reject the entire folder import.
    const stableGraph = JSON.stringify(await graph()), stableFiles = fingerprint(directory);
    const corrupt = new Map(dumpFiles);
    corrupt.set("project.dump", Buffer.from("not a database archive"));
    equal((await preview(corrupt)).status, 400);
    const incompatible = path.join(exportParent, "incompatible.dump");
    await archiveVariant(archive, incompatible, testEnv, { migration_version: 999999 });
    const mismatched = new Map(dumpFiles);
    mismatched.set("project.dump", fs.readFileSync(incompatible));
    const rejected = await preview(mismatched);
    equal(rejected.status, 400);
    ok(rejected.data.error.includes("迁移版本"), JSON.stringify(rejected.data));
    const ambiguous = new Map(dumpFiles);
    ambiguous.set("another.dump", dumpFiles.get("project.dump"));
    equal((await preview(ambiguous)).status, 400);
    equal(JSON.stringify(await graph()), stableGraph);
    equal(fingerprint(directory), stableFiles);
    equal(JSON.stringify(await client.call(`/projects/${untouched.id}/topology`)), unrelatedBefore);
  } finally {
    fs.rmSync(exportParent, { recursive: true, force: true });
  }
  console.log("PASS: folder create/replace, preview rollback, no-Dump preservation, live config, file/revision/lease conflicts, native Dump restore, ID remapping and stable grants and project isolation");
}
