#!/usr/bin/env bash
# RepoKernel PostToolUse hook — surface what's unblocked after `rk close`.
#
# When the model just ran `rk close <ID>` (or `rk epic close`), surface a
# one-line "next up" suggestion so the model can offer it to the user.
#
# Input  : JSON on stdin with tool_name, tool_input.command, tool_response, cwd.
# Output : stdout text (printed to transcript) when a suggestion fires.
#          Empty stdout otherwise. Always exit 0.
#
# Spec: https://github.com/anthropics/claude-code (PostToolUse hook event)

set -euo pipefail

INPUT="$(cat)"

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Match `rk close ...` or `rk epic close ...`. Avoid false positives on
# `rk close --help` (which doesn't ship anything) and on subcommands that
# happen to contain the word "close".
if ! [[ "$COMMAND" =~ ^[[:space:]]*rk[[:space:]]+(close|epic[[:space:]]+close)([[:space:]]|$) ]]; then
  exit 0
fi

# Skip if the command included --help or --dry-run.
if [[ "$COMMAND" =~ --help|--dry-run ]]; then
  exit 0
fi

CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')"
if [[ -z "$CWD" ]]; then
  CWD="$PWD"
fi

if ! command -v rk >/dev/null 2>&1; then
  exit 0
fi

# Resolve next runnable. Stay silent on any failure — never surface hook
# noise to the user.
if ! NEXT_JSON="$(cd "$CWD" && rk next --json 2>/dev/null)"; then
  exit 0
fi

NEXT_RESULT="$(printf '%s' "$NEXT_JSON" | jq -r '.result // empty' 2>/dev/null || true)"
NEXT_SPRINT="$(printf '%s' "$NEXT_JSON" | jq -r '.sprintId // empty' 2>/dev/null || true)"
NEXT_LANE="$(printf '%s' "$NEXT_JSON" | jq -r '.lane // empty' 2>/dev/null || true)"

case "$NEXT_RESULT" in
  runnable)
    if [[ -n "$NEXT_SPRINT" ]]; then
      printf 'RepoKernel: %s unblocked (lane %s). Use /rk-next to start.\n' \
        "$NEXT_SPRINT" "${NEXT_LANE:-default}"
    fi
    ;;
  none)
    printf 'RepoKernel: no runnable sprints. Use /rk-plan to scaffold new work.\n'
    ;;
  blocked|*)
    # Don't surface blocked status as a suggestion — let the user decide.
    ;;
esac
