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
# Exit code 0 + JSON output (preferred path).
# We do not use exit-code 2 — emitting structured JSON lets us include a
# systemMessage that surfaces inside Claude's transcript with actionable advice.

set -euo pipefail

# Read the entire stdin payload. Empty stdin = nothing to do (allow).
INPUT="$(cat)"
if [[ -z "$INPUT" ]]; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

# Extract the file_path from the tool input. We use a portable jq invocation
# and fall back to allow if jq is not on PATH (no harness blocking on tooling).
if ! command -v jq >/dev/null 2>&1; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"

# Only inspect Edit / Write / NotebookEdit / MultiEdit. Everything else: allow.
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  MultiEdit)
    # MultiEdit carries tool_input.edits[].file_path (array). Extract the first
    # .repokernel path so the deny check below handles it uniformly.
    FILE_PATH="$(printf '%s' "$INPUT" | jq -r '
      .tool_input.edits[]?.file_path // empty
      | select(test("\\.repokernel/"))
    ' 2>/dev/null | head -1)"
    if [[ -z "$FILE_PATH" ]]; then
      printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
      exit 0
    fi
    ;;
  *)
    printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
    exit 0
    ;;
esac

# No file path → allow.
if [[ -z "$FILE_PATH" ]]; then
  printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
  exit 0
fi

# Match RepoKernel state paths. The registry, run logs, and the
# generated/ directory are fully off-limits to Edit/Write. Sprint/epic/queue/
# review/lane markdown is also off-limits — `rk` mutates those via lifecycle
# commands, never by hand.
#
# We use case-glob matching on substrings rather than absolute paths so this
# survives nested worktrees, symlinks, and relative paths from the harness.
#
# Limitation: these patterns hardcode the default `.repokernel/` base. Repos
# initialized with `rk init --dir <custom>` are NOT protected by this hook
# yet — agents can edit `<custom>/plan/...` directly without being routed
# through `rk`. Tracked as a follow-up: have the hook delegate path
# classification to a new `rk path-policy <file>` command so it picks up
# the configured base dynamically.
deny_reason=""
case "$FILE_PATH" in
  */.repokernel/registry.json|*.repokernel/registry.json)
    deny_reason="The registry is generated state. Use \`rk registry --write\` or \`rk fix --apply --yes\` to regenerate it."
    ;;
  */.repokernel/runs/*|*.repokernel/runs/*)
    deny_reason="Run logs are immutable. Inspect with \`rk run inspect <RUN_ID>\` or \`rk run logs <RUN_ID>\`."
    ;;
  */.repokernel/generated/*|*.repokernel/generated/*|*/.repokernel/authority.md|*.repokernel/authority.md)
    deny_reason="Generated files are rewritten by rk. Edit the source entity files instead."
    ;;
  *.repokernel/plan/sprints/*.md|*/.repokernel/plan/sprints/*.md)
    deny_reason="Sprint state mutations go through rk. Use \`rk start\`, \`rk review\`, \`rk close\`, \`rk reopen\`, \`rk cancel\`, or \`rk fix --apply --yes\` instead of editing sprint frontmatter directly."
    ;;
  *.repokernel/plan/epics/*.md|*/.repokernel/plan/epics/*.md)
    deny_reason="Epic state mutations go through rk. Use \`rk epic close <E-NNN>\` or \`rk fix --apply --yes\`. Edit epic *body* (markdown after frontmatter) is fine for documentation, but the frontmatter status / closed_at fields are owned by rk."
    ;;
  *.repokernel/plan/queues/*.md|*/.repokernel/plan/queues/*.md)
    deny_reason="Queue mutations go through rk. Use \`rk queue add\` or \`rk fix --apply --yes\` instead of editing queue files directly."
    ;;
  *.repokernel/plan/reviews/*.md|*/.repokernel/plan/reviews/*.md)
    deny_reason="Review mutations go through rk. Use \`rk review-verdict <R-NNN> <verdict>\` or \`rk review-reconcile\` instead of editing review files directly."
    ;;
  *.repokernel/plan/lanes/*.md|*/.repokernel/plan/lanes/*.md)
    deny_reason="Lane state goes through rk. Use \`rk lane acquire\` / \`rk lane release\` instead of editing lane files directly."
    ;;
esac

if [[ -n "$deny_reason" ]]; then
  # Emit a deny decision with a systemMessage. Claude reads systemMessage and
  # can suggest the right rk command to the user.
  jq -nc \
    --arg reason "$deny_reason" \
    --arg path "$FILE_PATH" \
    '{
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      },
      systemMessage: ("RepoKernel state protection: refused to write " + $path + ". " + $reason)
    }'
  exit 0
fi

printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}\n'
