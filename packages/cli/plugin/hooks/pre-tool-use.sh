#!/usr/bin/env bash
# RepoKernel PreToolUse hook — state protection.
#
# Blocks Edit/Write on RepoKernel state files. State mutations must go through
# `rk` commands (rk start / review / close / reopen / fix / registry / lane /
# epic close) so the audit trail in the registry stays canonical.
#
# Input  : JSON on stdin with tool_name, tool_input.{file_path, command}, cwd.
# Output : JSON on stdout describing the permission decision.
# Spec   : https://github.com/anthropics/claude-code (PreToolUse hook event)
#
# Path classification is delegated to `rk path-policy <file>` so this hook
# stays correct for repos initialized with a custom `rk init --dir <base>`.
# If `rk` is not on PATH or the call fails, we fail open (allow) — never
# block unrelated edits because of a tooling issue.

set -euo pipefail

INPUT="$(cat)"
if [[ -z "$INPUT" ]]; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

if ! command -v rk >/dev/null 2>&1; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
HOOK_CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')"

# Build the list of file paths to classify, depending on tool.
FILE_PATHS=()
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit)
    FP="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
    [[ -n "$FP" ]] && FILE_PATHS+=("$FP")
    ;;
  MultiEdit)
    # MultiEdit carries tool_input.edits[].file_path. Check each — deny on
    # the first state-file hit so a single bad edit can't slip through.
    while IFS= read -r FP; do
      [[ -n "$FP" ]] && FILE_PATHS+=("$FP")
    done < <(printf '%s' "$INPUT" | jq -r '.tool_input.edits[]?.file_path // empty')
    ;;
  *)
    printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
    exit 0
    ;;
esac

if [[ ${#FILE_PATHS[@]} -eq 0 ]]; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

# Classify each file path via `rk path-policy`. Fail open on rk errors so
# tooling glitches never break unrelated edits. Stop at the first deny.
DENY_REASON=""
DENY_PATH=""
for FP in "${FILE_PATHS[@]}"; do
  RK_ARGS=()
  [[ -n "$HOOK_CWD" ]] && RK_ARGS+=(--cwd "$HOOK_CWD")
  RK_ARGS+=(path-policy "$FP")

  if ! POLICY_JSON="$(rk "${RK_ARGS[@]}" 2>/dev/null)"; then
    continue
  fi

  KIND="$(printf '%s' "$POLICY_JSON" | jq -r '.kind // "none"' 2>/dev/null || echo none)"
  if [[ "$KIND" != "none" && -n "$KIND" ]]; then
    DENY_REASON="$(printf '%s' "$POLICY_JSON" | jq -r '.reason // ""' 2>/dev/null || echo '')"
    DENY_PATH="$FP"
    break
  fi
done

if [[ -z "$DENY_PATH" ]]; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

if [[ -z "$DENY_REASON" ]]; then
  DENY_REASON="RepoKernel state file. Use the matching rk lifecycle command instead of editing it directly."
fi

jq -nc \
  --arg reason "$DENY_REASON" \
  --arg path "$DENY_PATH" \
  '{
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    },
    systemMessage: ("RepoKernel state protection: refused to write " + $path + ". " + $reason)
  }'
