#!/usr/bin/env bash
# Record the canonical fastpath demo: rk init → rk run -m → rk close.
#
# Produces a deterministic, reproducible flow suitable for asciinema or video.
# Use the deterministic `fake` agent so the recording works without API
# credentials and looks identical every time.
#
# Usage:
#   ./scripts/record-fastpath-demo.sh                       # prints the flow
#   asciinema rec demo.cast \
#     --title "RepoKernel fastpath" \
#     -c './scripts/record-fastpath-demo.sh'                # records
#
# Requires: rk on PATH (npm i -g repokernel, or `pnpm link` from a checkout).

set -euo pipefail

# Colors that look fine in asciinema and on plain terminals.
BOLD=$'\033[1m'
DIM=$'\033[2m'
RESET=$'\033[0m'

# Pace each command so a viewer can follow.
PAUSE="${RK_DEMO_PAUSE:-0.7}"

# Show a command, then run it.
demo() {
  printf '%s$ %s%s\n' "$BOLD" "$*" "$RESET"
  sleep "$PAUSE"
  "$@"
  printf '\n'
  sleep "$PAUSE"
}

main() {
  if ! command -v rk >/dev/null 2>&1; then
    printf '%serror:%s rk not found on PATH — install with: npm i -g repokernel\n' \
      "$BOLD" "$RESET" >&2
    exit 1
  fi

  local tmp
  tmp="$(mktemp -d -t rk-fastpath-demo-XXXXXX)"
  trap 'rm -rf "$tmp"' EXIT

  printf '%s# Working directory: %s%s\n\n' "$DIM" "$tmp" "$RESET"
  cd "$tmp"

  demo git init -q
  git config user.email demo@repokernel.dev >/dev/null
  git config user.name "RepoKernel Demo" >/dev/null

  cat >index.js <<'JS'
console.log('hello from the fastpath demo');
JS
  demo git add index.js
  git commit -q -m 'init' >/dev/null
  printf '%s# committed initial repo state%s\n\n' "$DIM" "$RESET"
  sleep "$PAUSE"

  demo rk init
  git add -A >/dev/null
  git commit -q -m 'rk init' >/dev/null

  demo rk run -m "Add a function add(a,b) that returns a+b in index.js" --agent fake

  demo rk close T-001

  printf '%s# git log:%s\n' "$DIM" "$RESET"
  git --no-pager log --oneline | sed 's/^/  /'
}

main "$@"
