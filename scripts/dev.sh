#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/local-db.mjs
if [ ! -d frontend/node_modules ]; then npm ci --prefix frontend --no-audit --no-fund; fi
npm run build --prefix frontend
cargo build
./target/debug/protocol-server migrate
printf 'Open http://127.0.0.1:8080 — login values are ADMIN_USERNAME / ADMIN_PASSWORD in .env\n'
exec ./target/debug/protocol-server
