#!/usr/bin/env bash
# Explicit project creation from config/projects/<key>/project.json.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ]; then
  printf '用法：./scripts/create-project.sh <项目目录名>，例如 upm\n' >&2
  exit 1
fi
cargo build --locked
exec ./target/debug/protocol-server create-project "$1"
