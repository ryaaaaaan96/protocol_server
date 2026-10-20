// Real PostgreSQL + HTTP tests in an isolated, disposable database.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkDspPoints } from "./dsp-points.mjs";
import { checkDspTransmitRules } from "./dsp-transmit-rules.mjs";
import { checkProjectFolders } from "./project-folders.mjs";
import { checkExcelBatch } from "./excel-batch.mjs";
import { checkProjectDatabases } from "./project-databases.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const env = Object.fromEntries(fs.readFileSync(".env", "utf8").split(/\r?\n/)
  .filter(line => line.includes("=") && !line.startsWith("#"))
  .map(line => { const index=line.indexOf("="); return [line.slice(0,index),line.slice(index+1)]; }));
if (process.env.TEST_MIGRATION_DATABASE_URL) env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_DATABASE_URL;
if (process.env.TEST_DATABASE_URL) env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const {default:pg}=await import(path.join(root,".runtime/db-tools/node_modules/pg/lib/index.js"));
const adminUrl=new URL(env.MIGRATION_DATABASE_URL);adminUrl.pathname="/postgres";
const adminDb=new pg.Client({connectionString:adminUrl.toString()});await adminDb.connect();
const runKey=Date.now().toString(36);
const fixtureKey=name=>`${name}_${runKey}`;
const dbname=`protocol_test_${runKey}`;
await adminDb.query(`CREATE DATABASE "${dbname}"`);
const migration=new URL(env.MIGRATION_DATABASE_URL),appUrl=new URL(env.DATABASE_URL);
migration.pathname=`/${dbname}`;appUrl.pathname=`/${dbname}`;
const password=crypto.randomBytes(20).toString("hex");
const projectConfigs=fs.mkdtempSync(path.join(root,".runtime/test-project-configs-"));
const fixtureSource=path.join(root,"config/dc-ups");
for(const [baseKey,workbook] of [["dsp_native",true],["dsp_native_other",false],["dsp_rules",false],["cli",false],["excel",false],["broken",true]]){
  const key=fixtureKey(baseKey);
  const directory=path.join(projectConfigs,key);fs.cpSync(fixtureSource,directory,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,"project.json"),"utf8"));
  manifest.key=key;manifest.name=key;
  if(!workbook)manifest.workbook=null;
  if(baseKey==="broken") { manifest.workbook="sources/invalid.xlsx"; fs.writeFileSync(path.join(directory,manifest.workbook),"not an xlsx file"); }
  fs.writeFileSync(path.join(directory,"project.json"),JSON.stringify(manifest));
}
const testEnv={...process.env,...env,MIGRATION_DATABASE_URL:migration.toString(),DATABASE_URL:appUrl.toString(),
  ADMIN_PASSWORD:password,ADMIN_USERNAME:"test_admin",BIND_ADDR:"127.0.0.1:18081",RUST_LOG:"warn",PROJECT_CONFIG_DIR:projectConfigs};
const base="http://127.0.0.1:18081/api";
let server,assertions=0;
const equal=(actual,expected)=>{assert.equal(actual,expected);assertions++;};
const ok=(value,message)=>{assert.ok(value,message);assertions++;};
const projectRequestQueues=new Map();
class Client {
  cookie = "";
  async raw(p, method = "GET", body, extra = {}) {
    const project = /^\/projects\/(\d+)\/(?!edit-lock(?:\/|$)|members(?:\/|$)|sql(?:\/|$))/.exec(p)?.[1];
    if (method === "GET" || !project) return this.rawUnlocked(p, method, body, extra);
    // Ordinary edits own a lease per request. Security tests use rawUnlocked
    // to verify that the server rejects missing leases and competing writers.
    const previous = projectRequestQueues.get(project) || Promise.resolve();
    let unlock;
    const pending = new Promise(resolve => { unlock = resolve; });
    projectRequestQueues.set(project, pending);
    await previous;
    let acquired = false;
    try {
      acquired = (await this.rawUnlocked(`/projects/${project}/edit-lock/acquire`, "POST", {})).status === 200;
      return await this.rawUnlocked(p, method, body, extra);
    } finally {
      if (acquired) await this.rawUnlocked(`/projects/${project}/edit-lock/release`, "POST", {});
      unlock();
      if (projectRequestQueues.get(project) === pending) projectRequestQueues.delete(project);
    }
  }
  async rawUnlocked(p, method = "GET", body, extra = {}) {
    const response = await fetch(base + p, {
      method,
      headers: {
        "X-Requested-With": "protocol-studio",
        ...(body instanceof FormData
          ? {}
          : body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...extra,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    if (response.headers.get("set-cookie"))
      this.cookie = response.headers.get("set-cookie").split(";")[0];
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data };
  }
  async call(p, method = "GET", body) {
    const r = await this.raw(p, method, body);
    assert.equal(r.status, 200, `${method} ${p}: ${JSON.stringify(r.data)}`);
    assertions++;
    return r.data;
  }
}
async function runIntegration(){
  execFileSync("target/debug/protocol-server",["migrate"],{env:testEnv,stdio:"inherit"});
  const log=fs.openSync(".runtime/integration-server.log","w");
  server=spawn("target/debug/protocol-server",[],{env:testEnv,stdio:["ignore",log,log]});
  const client=new Client(); let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    try { ready=(await client.raw("/health")).status===200;if(ready)break; }catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  ok(ready,"server ready");
  equal((await client.raw("/projects")).status,401);
  equal((await client.raw("/auth/login","POST",{username:"test_admin",password},{"X-Requested-With":""})).status,403);
  await client.call("/auth/login","POST",{username:"test_admin",password});
  equal((await client.call("/projects")).length,0);
  const createFromFile=key=>execFileSync("target/debug/protocol-server",["create-project",key],{env:testEnv,encoding:"utf8"});
  ok(createFromFile(fixtureKey("cli")).includes("已创建项目"));
  ok(createFromFile(fixtureKey("cli")).includes("未覆盖任何数据"));
  equal((await client.raw("/projects","POST",{config_key:fixtureKey("cli")})).status,409);
  equal((await client.raw("/projects","POST",{config_key:fixtureKey("broken")})).status,400);
  equal((await client.call("/projects")).length,1);
  const templates=await client.call("/project-templates");
  ok(templates.some(template=>template.key===fixtureKey("dsp_native")));
  equal((await new Client().raw("/project-templates")).status,401);
  const engineer=await client.call("/users","POST",{username:"engineer",display_name:"工程师",password});
  const viewer=await client.call("/users","POST",{username:"viewer",display_name:"只读",password});
  const e=new Client(),v=new Client();
  await e.call("/auth/login","POST",{username:"engineer",password});
  await v.call("/auth/login","POST",{username:"viewer",password});
  const secondViewer = new Client();
  await secondViewer.call("/auth/login","POST",{username:"viewer",password});
  equal((await secondViewer.call("/auth/me")).id, viewer.id);
  await secondViewer.call("/auth/logout","POST",{});
  equal((await secondViewer.raw("/auth/me")).status,401);
  equal((await v.call("/auth/me")).id,viewer.id);
  const unknown = new Client();
  for(let attempt=0;attempt<10;attempt++) equal((await unknown.raw("/auth/login","POST",{username:"nonexistent",password})).status,401);
  equal((await unknown.raw("/auth/login","POST",{username:"nonexistent",password})).status,429);
  equal((await e.raw("/projects","POST",{config_key:fixtureKey("dsp_native")})).status,403);
  if (!process.argv.some(arg=>["--folders","--excel","--databases"].includes(arg))) await checkDspPoints({client,engineer:e,viewer:v,engineerId:engineer.id,viewerId:viewer.id,equal,ok,
    migrationUrl:migration.toString(),appUrl:appUrl.toString(),testEnv,projectConfigs,fixtureKey});
  if (!process.argv.some(arg=>["--folders","--excel","--databases"].includes(arg))) await checkDspTransmitRules({client,engineer:e,engineerId:engineer.id,equal,ok,fixtureKey});
  if (!process.argv.some(arg=>["--excel","--databases"].includes(arg))) await checkProjectFolders({client,engineer:e,viewer:v,engineerId:engineer.id,viewerId:viewer.id,password,
    makeClient:()=>new Client(),projectConfigs,fixtureSource,testEnv,equal,ok,fixtureKey});
  if (!process.argv.some(arg=>["--folders","--databases"].includes(arg))) await checkExcelBatch({client,equal,ok,fixtureKey});
  if (!process.argv.some(arg=>["--folders","--excel"].includes(arg))) await checkProjectDatabases({client,engineer:e,viewer:v,engineerId:engineer.id,viewerId:viewer.id,
    migrationUrl:migration.toString(),testEnv,projectConfigs,fixtureSource,fixtureKey,equal,ok});
  const inspection=new pg.Client({connectionString:migration.toString()});await inspection.connect();
  try{
    const rows=(await inspection.query("SELECT tablename FROM pg_tables WHERE schemaname IN ('public','auth','meta','history') ORDER BY tablename")).rows.map(row=>row.tablename);
    const platformTables=(await inspection.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN ('public','auth','meta','history') ORDER BY 1")).rows.map(row=>row.name);
    equal(platformTables.length,8);
    for(const name of ["auth.users","auth.sessions","auth.login_attempts","meta.projects","meta.project_members","meta.project_member_grants","history.audit_logs","public._sqlx_migrations"])
      ok(platformTables.includes(name),`platform contains ${name}`);
    for(const removed of ["board_models","boards","signal_groups","signals","data_items","signal_bindings","protocol_fields","protocol_contracts","endpoints","device_contexts","signal_ranges","source_records"]){
      ok(!rows.includes(removed),`obsolete table removed: ${removed}`);
    }
    for(const present of ["projects","users","sessions","project_members","project_member_grants"]){
      ok(rows.includes(present),`required table retained: ${present}`);
    }
    for(const absent of ["process_points","transmit_points","point_history","releases","project_state"])
      ok(!rows.includes(absent),`platform contains no business table: ${absent}`);
    const registry=(await inspection.query("SELECT id,config_key,database_name,project_uid,status FROM meta.projects")).rows;
    ok(registry.length >= 2,"multiple independently routed projects");
    equal(new Set(registry.map(row=>row.database_name)).size,registry.length);
    for(const entry of registry){
      if(entry.status!=="ready")continue;
      equal(entry.database_name,`protocol_project_${entry.config_key.replaceAll("-","_")}`);
      const url=new URL(migration);url.pathname=`/${entry.database_name}`;
      const business=new pg.Client({connectionString:url.toString()});await business.connect();
      try{
        const tables=(await business.query("SELECT schemaname||'.'||tablename AS name FROM pg_tables WHERE schemaname IN ('public','points','history','meta') ORDER BY 1")).rows.map(row=>row.name);
        equal(tables.length,7);
        for(const name of ["public._sqlx_migrations","meta.project_state","meta.previews","points.process_points","points.transmit_points","history.events","history.releases"])
          ok(tables.includes(name),`project contains ${name}`);
        const state=(await business.query("SELECT id,config_key,project_uid FROM meta.project_state")).rows;
        equal(state.length,1);equal(state[0].id,entry.id);equal(state[0].config_key,entry.config_key);equal(state[0].project_uid,entry.project_uid);
      }finally{await business.end();}
    }
  }finally{await inspection.end();}
  console.log(`PASS: ${assertions} assertions; JSON organization, DSP editing, history, scopes, RLS, locks, merge, Dump, import and generated output`);
}
try{await runIntegration();}finally{
  if(server && server.exitCode===null && server.signalCode===null){server.kill("SIGTERM");await new Promise(resolve=>server.once("exit",resolve));}
  const platform=new pg.Client({connectionString:migration.toString()});
  try{
    await platform.connect();
    const exists=(await platform.query("SELECT to_regclass('meta.projects') IS NOT NULL AS present")).rows[0].present;
    if(exists)for(const entry of (await platform.query("SELECT database_name,project_uid FROM meta.projects")).rows){
      const marker=(await adminDb.query("SELECT shobj_description(oid,'pg_database') AS owner FROM pg_database WHERE datname=$1",[entry.database_name])).rows[0]?.owner;
      if(marker===`protocol-project:${entry.project_uid}`){
        const quoted='"'+entry.database_name.replaceAll('"','""')+'"';
        await adminDb.query(`DROP DATABASE ${quoted} WITH (FORCE)`);
      }
    }
  }finally{await platform.end();}
  await adminDb.query(`DROP DATABASE IF EXISTS "${dbname}" WITH (FORCE)`);await adminDb.end();
  fs.rmSync(projectConfigs,{recursive:true,force:true});
}
