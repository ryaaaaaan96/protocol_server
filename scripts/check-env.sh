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

printf 'Protocol Studio 迁移环境检查\n\n'
info "操作系统：$(uname -s) / $(uname -m)；本地数据库脚本支持 Linux x64。"
printf '\n开发与测试工具\n'
check_tool node '前端、数据库工具与集成测试' '安装 Node.js；使用 fnm/nvm 时先在当前终端激活已安装版本。'
check_tool npm '前端与本地数据库依赖安装' '安装或激活 Node.js 自带的 npm。'
check_tool rustc 'Rust 编译器' '安装 Rust 工具链，需支持 Rust 2024 edition。'
check_tool cargo '后端构建与测试' '安装 Rust 工具链并使 cargo 位于 PATH。'
check_tool python3 '工作簿导入与生成文件测试' '安装 Python 3。'
check_tool cc 'Rust 链接' 'Ubuntu/Debian 可安装 build-essential。'
check_tool gcc '生成 C 文件测试' 'Ubuntu/Debian 可安装 build-essential。'

printf '\n配置与数据迁移\n'
if [[ ! -f .env && -n "${DATABASE_URL:-}" ]]; then
  ready '未使用 .env；检测到 DATABASE_URL 环境变量（未检查连接或其他配置项）'
else
  check_file .env '按 .env.example 配置新机器；现有部署环境变量也可提供配置。'
fi
check_file "${POINT_TABLE_CONFIG:-config/point-tables.json}" '随仓库迁移公共展示配置。'
check_file config/project.example.json '随仓库迁移项目拓扑示例。'
project_directory=${PROJECT_CONFIG_DIR:-config/projects}
if [[ -d "$project_directory" ]]; then ready "$project_directory 项目配置目录";
else need "$project_directory" '迁移项目目录，或配置 PROJECT_CONFIG_DIR。'; fi
if [[ -f .runtime/pgdata/PG_VERSION ]]; then
  ready "本地 PostgreSQL 数据目录，版本 $(cat .runtime/pgdata/PG_VERSION)"
else
  info '未发现本地数据库；使用外部 PostgreSQL 时无需本地数据目录。'
fi
info '数据库连接、账号权限和已恢复的数据未验证；已有项目需另行 pg_dump/pg_restore，不能仅复制 config/。'
info '迁移 .env 时单独安全传递；完整流程见 docs/operations.md。'
pg_native=''
for candidate in .runtime/pg-package/package/native .runtime/db-tools/node_modules/@embedded-postgres/linux-x64/native; do
  if [[ -x "$candidate/bin/pg_ctl" ]]; then pg_native=$candidate; break; fi
done
if [[ -n "$pg_native" ]]; then
  ready "本地 PostgreSQL 工具：$pg_native/bin"
elif command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
  ready 'PATH 中有 pg_dump / pg_restore'
else
  need '本地 PostgreSQL 工具 / 备份恢复客户端' '使用外部数据库可安装对应版本客户端；首次创建新本地数据库用 ./scripts/init-db.sh，恢复旧数据按 docs/operations.md。'
fi
if [[ -f .runtime/db-tools/node_modules/pg/lib/index.js ]]; then ready '集成测试所需 Node PostgreSQL 客户端';
else need '集成测试所需 pg 客户端' 'npm install --prefix .runtime/db-tools pg'; fi

printf '\n前端与浏览器测试\n'
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
