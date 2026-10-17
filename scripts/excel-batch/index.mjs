#!/usr/bin/env node
// Example client: Excel -> JSON rows -> batch preview -> explicit atomic commit.
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { readRows, writeTemplate } from "./workbook.mjs";

const help = `点表 Excel 批量追加示例（Node.js 22+）
先安装依赖：npm ci --prefix scripts/excel-batch

生成空模板：node scripts/excel-batch/index.mjs --kind process --template points.xlsx
查询引用：  node scripts/excel-batch/index.mjs --project 1 --model 2 --kind process --references refs.json
校验预览：  node scripts/excel-batch/index.mjs --project 1 --model 2 --kind process --file points.xlsx
正式提交：  上述校验预览命令追加 --commit

--url         服务地址，默认 http://127.0.0.1:8080（也接受 /api 结尾）
--sheet       工作表名，默认等于 --kind；仅处理该工作表
--report      将预览/提交结果写入 JSON 文件（不会覆盖已有文件）
--kind        process（DSP 内部数据/处理点）、collect（采集）、forward（转发）

登录：环境变量 PROTOCOL_USERNAME、PROTOCOL_PASSWORD，或 PROTOCOL_SESSION。
预览不保存业务数据；--commit 会预览并提交一次，不自动重试、覆盖或拆批。
脚本会申请项目编辑权；他人正在编辑时会停止，预览结束或提交成功后释放。
所有引用 ID 必须已存在；单批 1～200 行。详情见 docs/batch-add.md。`;

function positive(value, name) {
  if (!/^\d+$/.test(value || "") || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error(`${name} 必须为正整数 ID`);
  return Number(value);
}
function issues(data) {
  return (data.errors || []).map(e => `${e.row ? `第 ${e.row} 行 ` : ""}${e.field ? `${e.field}：` : ""}${e.message}`).join("\n");
}

async function main() {
  const { values: args } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, commit: { type: "boolean" },
    url: { type: "string", default: "http://127.0.0.1:8080" },
    project: { type: "string" }, model: { type: "string" }, kind: { type: "string", default: "process" },
    file: { type: "string" }, sheet: { type: "string" }, template: { type: "string" },
    references: { type: "string" }, report: { type: "string" },
  } });
  if (args.help) { console.log(help); return; }
  if (!["process", "collect", "forward"].includes(args.kind)) throw new Error("kind 必须为 process、collect 或 forward");
  if ([args.template, args.references, args.file].filter(Boolean).length !== 1) throw new Error("请指定且仅指定 --template、--references 或 --file 中的一项");
  if (args.commit && !args.file) throw new Error("--commit 必须与 --file 一起使用");
  if (args.report && !args.file) throw new Error("--report 必须与 --file 一起使用");
  if (args.template) {
    await writeTemplate(args.template, args.kind);
    console.log(`模板已生成：${args.template}；填写后先运行校验预览。`);
    return;
  }
  const pid = positive(args.project, "project"), mid = positive(args.model, "model");
  const server = new URL(args.url);
  if (!["http:", "https:"].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error("url 必须是不含账号、密码和查询参数的 HTTP(S) 服务地址");
  const base = server.href.replace(/\/$/, "").replace(/\/api$/, "") + "/api";
  const tablePath = `/projects/${pid}/board-models/${mid}/point-tables/${args.kind}`;
  const rows = args.file ? await readRows(args.file, args.kind, args.sheet || args.kind) : null;
  let cookie = "", loggedIn = false, reportHandle;
  let editLease = false, commitAttempted = false, commitResponded = false, heartbeat, leaseError;
  let renewal = Promise.resolve();
  // Reserve the output before any write request; an existing report must not cause a
  // successful commit to be reported as failed and accidentally retried by the caller.
  if (args.report) {
    const { open } = await import("node:fs/promises");
    reportHandle = await open(args.report, "wx");
  }
  async function api(path, method = "GET", body) {
    let response;
    try {
      response = await fetch(base + path, {
        method, redirect: "error", signal: AbortSignal.timeout(60000),
        headers: { "X-Requested-With": "protocol-studio", ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(path.endsWith("/commit")
        ? "提交响应未收到，结果未知。请先在页面或审计记录核实，勿直接重跑 --commit。"
        : `无法访问服务 ${server.origin}，请检查地址、网络和服务状态`);
    }
    const data = await response.json().catch(() => {
      throw new Error(path.endsWith("/commit")
        ? "提交返回了无法解析的响应，结果未知。请先核实页面和审计记录，勿直接重跑 --commit。"
        : `服务返回了非 JSON 响应（HTTP ${response.status}）`);
    });
    if (path.endsWith("/commit")) commitResponded = true;
    if (!response.ok) {
      if (reportHandle && path !== "/auth/logout" && !path.endsWith("/edit-lock/release")) await reportHandle.writeFile(JSON.stringify({ stage: "error", status: response.status, ...data }, null, 2));
      throw new Error([data.error || `HTTP ${response.status}`, issues(data)].filter(Boolean).join("\n"));
    }
    if (path === "/auth/login") cookie = response.headers.getSetCookie().find(c => c.startsWith("protocol_session="))?.split(";")[0] || "";
    return data;
  }
  try {
    if (process.env.PROTOCOL_SESSION) {
      if (!/^[0-9a-f]{64}$/i.test(process.env.PROTOCOL_SESSION)) throw new Error("PROTOCOL_SESSION 必须为 64 位会话令牌");
      cookie = `protocol_session=${process.env.PROTOCOL_SESSION}`;
    } else {
      if (!process.env.PROTOCOL_USERNAME || !process.env.PROTOCOL_PASSWORD) throw new Error("请设置 PROTOCOL_USERNAME、PROTOCOL_PASSWORD，或已有的 PROTOCOL_SESSION");
      await api("/auth/login", "POST", { username: process.env.PROTOCOL_USERNAME, password: process.env.PROTOCOL_PASSWORD });
      if (!cookie) throw new Error("登录未返回会话 Cookie");
      loggedIn = true;
    }
    const table = await api(tablePath);
    if (args.references) {
      await writeFile(args.references, JSON.stringify({ project_id: pid, model_id: mid, kind: args.kind, revision: table.revision, options: table.options }, null, 2), { flag: "wx" });
      console.log(`引用 ID 已导出：${args.references}（分组、数据定义、处理点、端点、上下文和协议字段）`);
      return;
    }
    await api(`/projects/${pid}/edit-lock/acquire`, "POST", {});
    editLease = true;
    heartbeat = setInterval(() => {
      renewal = renewal.then(() => api(`/projects/${pid}/edit-lock/renew`, "POST", {})).catch(error => { leaseError = error; });
    }, 30000);
    const current = await api(tablePath);
    const preview = await api(`${tablePath}/batch/preview`, "POST", { revision: current.revision, rows });
    if (!preview.allowed) {
      if (reportHandle) await reportHandle.writeFile(JSON.stringify({ stage: "preview", ...preview }, null, 2));
      throw new Error(`批量校验未通过，业务数据未保存：\n${issues(preview)}`);
    }
    console.log(`预览通过：项目 ${pid}，板卡 ${mid}，${args.kind}，新增 ${rows.length} 行；关联变化 ${preview.impact.count} 项。`);
    for (const issue of preview.validation?.issues || []) {
      if (issue.level === "warning") console.log(`校验提示（含项目已有问题）：${issue.message}`);
    }
    if (leaseError) throw leaseError;
    let result = preview;
    if (args.commit) {
      clearInterval(heartbeat);
      await renewal;
      if (leaseError) throw leaseError;
      commitAttempted = true;
      result = await api(`/projects/${pid}/changes/${preview.id}/commit`, "POST", {});
      // Commit already relinquished this lease atomically. Never release again:
      // another tab using the same account may have started a new editing session.
      editLease = false;
    }
    console.log(args.commit
      ? `添加成功：${result.record.count} 行，项目版本 ${result.revision}${result.merged ? "（已合并无关的并发修改）" : ""}。`
      : "仅完成预览，业务数据未保存；确认后在同一命令后添加 --commit。该命令会重新校验。正式记录 ID 以提交结果为准。");
    if (reportHandle) {
      try { await reportHandle.writeFile(JSON.stringify({ stage: args.commit ? "commit" : "preview", ...result }, null, 2)); }
      catch { console.error("结果报告写入失败；以上服务端结果仍然有效，请勿因此重复提交。"); }
    }
  } finally {
    clearInterval(heartbeat);
    await renewal;
    if (editLease && (!commitAttempted || commitResponded)) {
      try { await api(`/projects/${pid}/edit-lock/release`, "POST", {}); }
      catch { console.error("项目编辑权未能主动释放，将在租约到期后自动释放。"); }
    }
    if (loggedIn) { try { await api("/auth/logout", "POST", {}); } catch { console.error("临时登录会话未能注销，将按服务端规则过期。"); } }
    await reportHandle?.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
