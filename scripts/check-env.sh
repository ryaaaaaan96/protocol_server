#!/usr/bin/env bash
# Read-only migration checklist: no downloads, installs, services, or database writes.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -gt 0 ]]; then
  printf '用法：./scripts/check-env.sh\n只检查当前环境并列出缺项；不安装软件，不输出密码，不连接数据库。\n'
  [[ "$1" == "--help" || "$1" == "-h" ]] && exit 0
  exit 2
fi

missing=0
ready() { printf '[就绪] %s\n' "$1"; }
info() { printf '[说明] %s\n' "$1"; }
need() {
  missing=$((missing + 1))
  printf '[缺少] %s\n       建议：%s\n' "$1" "$2"
}
check_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    local version
    version=$("$1" --version 2>/dev/null) || version='无法读取版本'
    ready "$1：${version%%$'\n'*}"
  else
    need "$1（$2）" "$3"
  fi
}
check_file() {
  if [[ -f "$1" ]]; then ready "$1"; else need "$1" "$2"; fi
}
config_path() {
  local key=$1
  if [[ -n "${!key:-}" ]]; then printf '%s' "${!key}"; return; fi
  if [[ ! -f .env ]] || ! command -v node >/dev/null 2>&1; then return; fi
  # Read only the requested path; never execute .env as shell code or print credentials.
  node --input-type=module - "$key" <<'NODE'
import fs from 'node:fs';
const key = process.argv[2];
if (!['PROJECT_CONFIG_DIR', 'PG_DUMP_BIN', 'PG_RESTORE_BIN'].includes(key)) process.exit(2);
let value = '';
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (match?.[1] === key) value = match[2].replace(/^(["'])(.*)\1$/, '$2');
}
process.stdout.write(value);
NODE
}
check_pg_client() {
  local command=$1 variable=$2 purpose=$3 executable version
  executable=$(config_path "$variable")
  if [[ -n "$executable" ]]; then
    if [[ "$executable" != /* || ! -x "$executable" ]]; then
      need "$command（$purpose）：$variable 未指向可执行的绝对路径" "安装 PostgreSQL 客户端并修正 $variable。"
      return
    fi
  else
    executable=$(command -v "$command" 2>/dev/null) || executable=''
  fi
  if [[ -z "$executable" ]]; then
    need "$command（$purpose）" "安装与数据库及 Dump 版本兼容的 PostgreSQL 客户端，加入 PATH 或设置 $variable 的绝对路径；本地数据库默认 PostgreSQL 18。"
  elif version=$("$executable" --version 2>/dev/null); then
    ready "$command：${version%%$'\n'*}"
  else
    need "$command 无法运行" "检查客户端动态库与 $variable 设置。"
  fi
}

printf 'Protocol Studio 迁移环境检查\n\n'
info "操作系统：$(uname -s) / $(uname -m)；本地数据库脚本支持 Linux x64。"
printf '\n开发与测试工具\n'
check_tool node '前端、数据库工具与集成测试' '安装 Node.js；使用 fnm/nvm 时先在当前终端激活已安装版本。'
check_tool npm '前端与本地数据库依赖安装' '安装或激活 Node.js 自带的 npm。'
check_tool rustc 'Rust 编译器' '安装 Rust 1.87 或更新版本（QuickJS 依赖要求）。'
if command -v rustc >/dev/null 2>&1; then
  rust_version=$(rustc --version | awk '{print $2}')
  if [[ "$rust_version" =~ ^([0-9]+)\.([0-9]+) ]] && (( BASH_REMATCH[1] < 1 || (BASH_REMATCH[1] == 1 && BASH_REMATCH[2] < 87) )); then
    need "Rust $rust_version 低于最低版本 1.87" '运行 rustup update stable。'
  fi
fi
check_tool cargo '后端构建与测试' '安装 Rust 工具链并使 cargo 位于 PATH。'
check_tool python3 '工作簿导入与生成文件测试' '安装 Python 3。'
check_tool cc 'Rust 链接及 QuickJS 引擎编译' 'Ubuntu/Debian 可安装 build-essential；macOS 可运行 xcode-select --install。'

printf '\n配置与数据迁移\n'
if [[ ! -f .env && -n "${DATABASE_URL:-}" ]]; then
  ready '未使用 .env；检测到 DATABASE_URL 环境变量（未检查连接或其他配置项）'
else
  check_file .env '按 .env.example 配置新机器；现有部署环境变量也可提供配置。'
fi
project_directory=$(config_path PROJECT_CONFIG_DIR)
project_directory=${project_directory:-config}
if [[ -d "$project_directory" ]]; then
  ready "$project_directory 项目配置目录"
  if command -v node >/dev/null 2>&1; then
    if node --input-type=module - "$project_directory" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
let failed = false, count = 0;
function requireFile(file, project) {
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(project + path.sep) || !fs.statSync(resolved).isFile()) {
    throw new Error(`文件必须位于项目内：${file}`);
  }
}
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
  count++;
  const directory = path.join(root, entry.name), manifestFile = path.join(directory, 'project.json');
  try {
    const project = fs.realpathSync(directory);
    requireFile(manifestFile, project);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!Array.isArray(manifest.topology?.board_types)) throw new Error('缺少 topology.board_types');
    for (const board of manifest.topology.board_types) {
      if (typeof board.directory !== 'string' || !board.directory) throw new Error(`板卡 ${board.code} 缺少 directory`);
      if (board.workbook_import != null) {
        const reference = board.workbook_import;
        if (typeof reference !== 'string' || path.isAbsolute(reference) || reference.includes('\\') || reference.split('/').includes('..')) throw new Error(`板卡 ${board.code} 的 workbook_import 路径无效`);
        const boardPath = fs.realpathSync(path.resolve(directory, board.directory));
        const mappingFile = path.resolve(boardPath, reference);
        requireFile(mappingFile, boardPath);
        JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
      }
      for (const table of ['process', 'collect', 'transmit']) {
        const tableFile = path.resolve(directory, board.directory, `${table}.json`);
        requireFile(tableFile, project);
        const definition = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
        for (const rule of [definition.calculation, definition.mapping, definition.behavior]) if (rule?.engine === "javascript") {
          const reference = rule.script_file;
          if (typeof reference !== 'string' || path.isAbsolute(reference) || reference.includes('\\')
              || reference.split('/').includes('..') || !reference.endsWith('.js')) {
            throw new Error(`${tableFile}：script_file 必须指向板卡目录内的 .js 文件`);
          }
          requireFile(path.resolve(path.dirname(tableFile), reference), fs.realpathSync(path.dirname(tableFile)));
        }
      }
    }
    if (manifest.workbook != null) {
      if (typeof manifest.workbook !== 'string') throw new Error('workbook 必须为项目内的相对路径');
      requireFile(path.resolve(directory, manifest.workbook), project);
    }
    const archives = fs.readdirSync(directory).filter(name => /\.dump$/i.test(name));
    if (manifest.dump != null) {
      if (typeof manifest.dump !== 'string' || path.isAbsolute(manifest.dump)) throw new Error('dump 必须为项目内的相对路径');
      const selected = path.resolve(directory, manifest.dump);
      requireFile(selected, project);
      if (archives.some(name => fs.realpathSync(path.join(directory, name)) !== fs.realpathSync(selected))) throw new Error('存在多个 Dump，请只保留要导入的归档');
    } else {
      if (archives.length > 1) throw new Error('存在多个 Dump，无法确定要导入的归档');
      if (archives.length) requireFile(path.join(directory, archives[0]), project);
    }
    console.log(`[就绪] ${manifestFile}：板卡表格、计算脚本及可选来源齐全`);
  } catch (error) {
    failed = true;
    console.log(`[缺少] ${manifestFile}：${error.message}`);
  }
}
if (!count) console.log('[说明] 项目配置目录为空；创建项目前需放入完整的项目文件夹。');
process.exitCode = failed ? 1 : 0;
NODE
    then :
    else need '项目配置文件不完整' '按 project.json 指定的目录补齐板卡表格和来源文件，再重跑检查。'; fi
  else
    info 'Node.js 不可用，暂不能检查项目清单引用的板卡表格和来源文件。'
  fi
else
  need "$project_directory" '迁移完整的项目目录，或配置 PROJECT_CONFIG_DIR。'
fi
if [[ -f .runtime/pgdata/PG_VERSION ]]; then
  ready "本地 PostgreSQL 数据目录，版本 $(cat .runtime/pgdata/PG_VERSION)"
else
  info '未发现本地数据库；使用外部 PostgreSQL 时无需本地数据目录。'
fi
info '账号、会话、成员权限保存在平台库；每项目独立业务库。DATABASE_URL 和 MIGRATION_DATABASE_URL 应指向平台库。'
info '数据库连接、账号权限和 Dump 内容未验证；项目导出包含当前点表。完整迁移需分别备份平台库、各项目库及 config 文件夹。'
info '旧 v15 单库升级：先停止服务并断开查看工具，再执行 node scripts/split-databases.mjs --maintenance；脚本保留源库并自动备份。'
info '迁移 .env 时单独安全传递；完整流程见 docs/operations.md。'
pg_native=''
for candidate in .runtime/pg-package/package/native .runtime/db-tools/node_modules/@embedded-postgres/linux-x64/native; do
  if [[ -x "$candidate/bin/pg_ctl" ]]; then pg_native=$candidate; break; fi
done
if [[ -n "$pg_native" ]]; then
  ready "本地 PostgreSQL 工具：$pg_native/bin"
else
  info '未发现本地 PostgreSQL 服务工具；外部数据库无需安装，首次创建本地数据库用 ./scripts/init-db.sh。'
fi
check_pg_client pg_dump PG_DUMP_BIN '导出项目及全库备份'
check_pg_client pg_restore PG_RESTORE_BIN '读取项目 Dump 及恢复全库备份'
if [[ -f .runtime/db-tools/node_modules/pg/lib/index.js ]]; then ready '项目导出与集成测试所需 Node PostgreSQL 客户端';
else need '项目导出与集成测试所需 pg 客户端' 'npm install --prefix .runtime/db-tools pg'; fi

printf '\n前端与浏览器测试\n'
if [[ -f scripts/excel-batch/node_modules/exceljs/excel.js ]]; then
  ready 'Excel 批量追加示例依赖（ExcelJS）'
else
  need 'Excel 批量追加示例依赖（集成测试也使用）' 'npm ci --prefix scripts/excel-batch'
fi
if [[ -x frontend/node_modules/.bin/vite && -x frontend/node_modules/.bin/vue-tsc ]]; then
  ready '前端构建依赖'
else
  need '前端构建依赖' 'npm ci --prefix frontend'
fi
if ! command -v node >/dev/null 2>&1; then
  info 'Node.js 不可用，暂不能检查 Playwright 与 Chromium；补齐后重跑。'
elif [[ ! -x frontend/node_modules/.bin/playwright ]]; then
  need 'Playwright' 'npm ci --prefix frontend'
else
  if browser_path=$(cd frontend && node --input-type=module -e 'import { chromium } from "@playwright/test"; console.log(chromium.executablePath());' 2>/dev/null); then
    if [[ ! -x "$browser_path" ]]; then
      need 'Playwright Chromium 浏览器' 'cd frontend && npx playwright install --with-deps chromium'
      info '浏览器尚未安装，暂不能枚举缺失动态库；安装后重跑检查。'
    else
      ready "Chromium：$browser_path"
      if command -v ldd >/dev/null 2>&1; then
        if dependencies=$(ldd "$browser_path" 2>&1); then
          missing_before=$missing
          while IFS= read -r line; do
            if [[ "$line" == *'not found'* ]]; then
              library=${line%% =>*}
              library=${library//[[:space:]]/}
              need "浏览器动态库 $library" 'cd frontend && npx playwright install-deps chromium（需要系统安装权限）'
            fi
          done <<< "$dependencies"
          if [[ $missing -eq $missing_before ]]; then ready 'Chromium 动态库均可找到'; fi
        else
          need '浏览器动态库检测失败' '确认浏览器版本与操作系统匹配，检查 ldd 是否可用。'
        fi
      else
        need 'ldd（Linux 动态库检查工具）' '在 Linux 上安装系统 libc 工具后重新检查。'
      fi
    fi
  else
    need 'Playwright 模块无法加载' 'npm ci --prefix frontend'
  fi
fi
info '浏览器缓存和系统库需要在目标机器重新检查；临时的 /tmp 路径不会随仓库迁移。'
printf '\n检查完成：%s 项缺失。此报告只检查工具、文件和动态库，不代表构建、数据库连接或浏览器测试已通过。\n' "$missing"
[[ $missing -eq 0 ]]
