#!/usr/bin/env bash
# Explicit, repeatable local database setup. Does not create any business project.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/local-db.mjs init
cargo build --locked
./target/debug/protocol-server migrate
printf '平台数据库初始化完成，未创建项目库。可运行 ./scripts/create-project.sh <项目目录名>，然后 ./scripts/dev.sh。\n'
