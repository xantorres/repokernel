#!/usr/bin/env bash
# Example external agent script for RepoKernel.
#
# Called as: ./run-agent.sh <packet_path> <worktree> <sprint_id>
#
# Must output a sentinel-JSON block to stdout.
# Exit 0 = result in stdout. Exit non-zero = agent failure.
set -euo pipefail

PACKET_PATH="$1"
WORKTREE="$2"
SPRINT_ID="$3"

# Do some work in the worktree
mkdir -p "$WORKTREE/workspace"
echo "work done by external agent for $SPRINT_ID" > "$WORKTREE/workspace/output-$SPRINT_ID.txt"

git -C "$WORKTREE" add "$WORKTREE/workspace/output-$SPRINT_ID.txt"
git -C "$WORKTREE" commit -m "feat($SPRINT_ID): external agent output"

CHANGED_FILE="workspace/output-$SPRINT_ID.txt"

# Output sentinel JSON
cat <<EOF
REPOKERNEL_RESULT_START
{"status":"completed","summary":"External agent completed $SPRINT_ID","changed_files":["$CHANGED_FILE"],"needs_human":false}
REPOKERNEL_RESULT_END
EOF
