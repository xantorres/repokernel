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

# Trust-grant pre-flight: if the repo declares any privileged action
# (custom checksCmd, agent envPassthrough, panel reviewer) that the user
# has not granted in ~/.repokernel/trust.yaml, surface a one-line hint up
# front so the agent sees it at session boot rather than mid-task. Stay
# silent when grants are complete or when `rk trust check` is missing
# (older rk binary).
#
# Capture stderr into a shell variable rather than a /tmp file: a
# predictable /tmp path (PID-suffixed) is a TOCTOU/symlink vector on
# shared hosts. The shell variable stays in-process.
TRUST_HINT="$(cd "$PROJECT_ROOT" && rk trust check 2>&1 >/dev/null || true)"

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
TRUST_LINE=""
if [[ -n "$TRUST_HINT" ]]; then
  TRUST_LINE=$'\n'"$TRUST_HINT"
fi
jq -nc \
  --arg ctx "$BRIEF_TEXT" \
  --arg trust "$TRUST_LINE" \
  '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: ("RepoKernel cold-start: " + $ctx + $trust + "\n\nUse /rk-status for the full dashboard, /rk-next to start work.")
    }
  }'
