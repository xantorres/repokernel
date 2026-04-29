#!/usr/bin/env bash
# RepoKernel SessionStart hook — cold-start dashboard.
#
# When a session starts inside an RK-governed repo, inject a one-line summary
# (active epic, next sprint, lane status) into the model context via
# additionalContext. The cost target is <200ms; we use `rk status --brief`,
# which skips full validators.
#
# If the repo has no `repokernel.config.yaml`, do nothing — silent on
# non-RK repos.
#
# Spec: https://github.com/anthropics/claude-code (SessionStart hook event)

set -euo pipefail

INPUT="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')"
if [[ -z "$CWD" ]]; then
  CWD="$PWD"
fi

# Walk up looking for repokernel.config.yaml. Bounded depth (no infinite walk).
find_config() {
  local dir="$1"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -f "$dir/repokernel.config.yaml" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    local parent
    parent="$(dirname "$dir")"
    if [[ "$parent" == "$dir" ]]; then
      return 1
    fi
    dir="$parent"
  done
  return 1
}

PROJECT_ROOT="$(find_config "$CWD" || true)"
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

# Run rk status --brief --json. If rk is not on PATH or the command fails,
# stay silent — never surface a hook failure to the user.
if ! command -v rk >/dev/null 2>&1; then
  exit 0
fi

if ! BRIEF_JSON="$(cd "$PROJECT_ROOT" && rk status --brief --json 2>/dev/null)"; then
  exit 0
fi

# Read the brief shape. If parsing fails, stay silent.
if ! BRIEF_TEXT="$(printf '%s' "$BRIEF_JSON" | jq -r '
  if .initialized then
    "RK | "
    + (.active_epic // "no active epic")
    + " active · "
    + (.next_sprint // "no runnable sprint")
    + " next · lanes "
    + (.lanes_free | tostring)
    + "/"
    + (.lanes_total | tostring)
    + " free"
  else
    empty
  end
' 2>/dev/null)"; then
  exit 0
fi

if [[ -z "$BRIEF_TEXT" ]]; then
  exit 0
fi

# Inject as additionalContext so the model sees the dashboard.
jq -nc \
  --arg ctx "$BRIEF_TEXT" \
  '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ("RepoKernel cold-start: " + $ctx + "\n\nUse /repokernel:rk-status for the full dashboard, /repokernel:rk-next to start work.")
    }
  }'
