#!/usr/bin/env bash
# Record the canonical skill + fastpath demo.
#
# Story: install plugin → /rk-run one-shot task → /rk-status mid-flight →
#        close → clean git history.
#
# Usage (preview, no recording):
#   ./scripts/record-fastpath-demo.sh
#
# Usage (record + convert to GIF):
#   asciinema rec docs/assets/fastpath-demo.cast \
#     --title "RepoKernel — agent-operated workflow" \
#     --cols 88 --rows 26 \
#     --idle-time-limit 3 \
#     -c './scripts/record-fastpath-demo.sh'
#   agg docs/assets/fastpath-demo.cast docs/assets/fastpath-demo.gif \
#     --idle-time-limit 3 \
#     --last-frame-duration 5 \
#     --font-size 15 \
#     --line-height 1.4
#
# Requires: rk on PATH (npm i -g repokernel, or `pnpm link` from a checkout).

set -euo pipefail

# Ensure rk is on PATH when run inside asciinema (no login shell).
if ! command -v rk >/dev/null 2>&1; then
  for _bin_dir in "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do
    if [ -f "$_bin_dir/rk" ]; then
      export PATH="$_bin_dir:$PATH"
      break
    fi
  done
fi

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

PAUSE="${RK_DEMO_PAUSE:-2.2}"

# Show and run a CLI command.
demo() {
  printf '%s$ %s%s\n' "$BOLD" "$*" "$RESET"
  sleep 0.4
  "$@"
  printf '\n'
  sleep "$PAUSE"
}

# Show one string as the command label, run another.
# Usage: demo_as "label" cmd arg arg ...
demo_as() {
  local label="$1"; shift
  printf '%s$ %s%s\n' "$BOLD" "$label" "$RESET"
  sleep 0.4
  "$@"
  printf '\n'
  sleep "$PAUSE"
}

# Print a dim comment.
comment() {
  printf '%s# %s%s\n\n' "$DIM" "$*" "$RESET"
  sleep 1.2
}

# Simulate a user typing a slash command in Claude Code.
slash() {
  printf '\n%s❯%s ' "$GREEN" "$RESET"
  local text="$1"
  for (( i=0; i<${#text}; i++ )); do
    printf '%s' "${text:$i:1}"
    sleep 0.05
  done
  printf '\n'
  sleep 0.5
  printf '%s→%s %s\n\n' "$CYAN" "$RESET" "$2"
  sleep 0.4
}

main() {
  if ! command -v rk >/dev/null 2>&1; then
    printf '%serror:%s rk not found — install: npm i -g repokernel\n' \
      "$BOLD" "$RESET" >&2
    exit 1
  fi

  local tmp
  tmp="$(mktemp -d -t rk-demo-XXXXXX)"
  trap "rm -rf '$tmp'" EXIT
  cd "$tmp"

  printf '%s# Working directory: %s%s\n\n' "$DIM" "$tmp" "$RESET"
  sleep 0.8

  # ── Bootstrap repo ────────────────────────────────────────────────────────

  git init -q
  git config user.email demo@repokernel.dev
  git config user.name "RepoKernel Demo"
  printf 'function greet(name) { return "hello, " + name; }\nmodule.exports = { greet };\n' >index.js
  git add index.js
  git commit -q -m 'init'
  printf '%s# git repo ready%s\n\n' "$DIM" "$RESET"
  sleep "$PAUSE"

  # ── Step 1: install the Claude Code plugin ────────────────────────────────

  comment "Step 1 — install the plugin for Claude Code (one-time)"
  demo rk install-skill --dry-run

  # ── Step 2: init a RepoKernel project ────────────────────────────────────

  comment "Step 2 — initialize RepoKernel"
  demo rk init
  git add -A
  git commit -q -m 'rk init'

  # ── Step 3: /rk-run — dispatch a one-shot task ────────────────────────────

  printf '%s┌─── Claude Code ────────────────────────────────────────────────────┐%s\n\n' \
    "$DIM" "$RESET"

  slash '/rk-run "Add an add(a,b) function to index.js"' \
    "routing hint: light tier — dispatching fastpath task…"

  demo_as 'rk run -m "Add an add(a,b) function to index.js" --agent fake' \
    rk run -m "Add an add(a,b) function to index.js" --agent fake

  # ── Step 4: /rk-status mid-flight (E-001 now active) ─────────────────────

  slash "/rk-status" "checking project health and lane occupancy…"

  demo rk validate --fail-on P0,P1 --json
  demo rk status --brief

  # ── Step 5: close the task ────────────────────────────────────────────────

  slash "close it" "merging worktree → main, marking T-001 shipped…"
  demo rk close T-001

  printf '\n%s└────────────────────────────────────────────────────────────────────┘%s\n\n' \
    "$DIM" "$RESET"
  sleep "$PAUSE"

  # ── Audit trail ───────────────────────────────────────────────────────────

  comment "clean git history — every action has an audit commit"
  git --no-pager log --oneline | sed 's/^/  /'
  printf '\n'
  sleep "$PAUSE"
}

main "$@"
