#!/usr/bin/env bash
# PostToolUse hook: lint the single .ts/.tsx file just edited, using that
# workspace's own eslint (flat config). Detection only — no --fix, so the
# hook never mutates files mid-session. On lint errors it exits 2 so the
# output is fed back to Claude and must be fixed before claiming "done".
set -uo pipefail

# Hooks run in a fresh shell that may default to an old node (project needs >=22).
export PATH="/Users/biu/.nvm/versions/node/v22.21.1/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

file="$(jq -r '.tool_input.file_path // empty')"
[ -z "$file" ] && exit 0

case "$file" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac

case "$file" in
  "$ROOT"/apps/backend/*) ws="$ROOT/apps/backend" ;;
  "$ROOT"/apps/frontend/*) ws="$ROOT/apps/frontend" ;;
  *) exit 0 ;;
esac

bin="$ws/node_modules/.bin/eslint"
[ -x "$bin" ] || exit 0

out="$(cd "$ws" && "$bin" "$file" 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  {
    echo "⛔ eslint 在刚改动的文件中发现问题（pnpm lint 检查），请修复后再继续："
    echo "$file"
    echo "$out"
  } >&2
  exit 2
fi
exit 0
