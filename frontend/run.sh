#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  task_node="$(command -v node)"
else
  task_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ ! -x "$task_node" ]; then
  echo 'Node.js is required. Install Node.js 20.9+ and dependencies first.' >&2
  exit 1
fi
export PATH="$(dirname "$task_node"):$PATH"
if [ -f ../node_modules/next/dist/bin/next ]; then
  next_entry="../node_modules/next/dist/bin/next"
elif [ -f node_modules/next/dist/bin/next ]; then
  next_entry="node_modules/next/dist/bin/next"
else
  echo 'Next.js is not installed. Run npm install from the project root.' >&2
  exit 1
fi
exec "$task_node" "$next_entry" "${1:-dev}" --hostname 127.0.0.1
