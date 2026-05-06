---
ac:
  - RepoKernel creates a task alias
  - The fake agent runs in an isolated worktree
  - Closing T-001 records the shipped audit trail
allow:
  - workspace/issue
---
Simulate a GitHub issue asking the agent to make a tiny visible change in the issue workspace.

This file is intentionally offline-friendly. Swap it for `rk run --from-tracker gh:owner/repo#42 --agent fake` when you want to exercise real tracker ingest.
