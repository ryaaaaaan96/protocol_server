#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ] && [ -z "${DATABASE_URL:-}" ]; then
  printf '尚未配置数据库。请先运行 ./scripts/init-db.sh，或配置已有 PostgreSQL 的连接。\n' >&2
  exit 1
fi
if [ ! -d frontend/node_modules ]; then npm ci --prefix frontend --no-audit --no-fund; fi
npm run build --prefix frontend
cargo build
printf 'Open http://127.0.0.1:8080 — login values are ADMIN_USERNAME / ADMIN_PASSWORD in .env\n'
exec ./target/debug/protocol-server
