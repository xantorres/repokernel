---
name: rk-status
description: Read-only RepoKernel dashboard. Use for "status", "where are we".
---

# /repokernel:rk-status

1. `rk status --brief --json` — render the one-line summary.
2. If `active_epic` is non-null, also run `rk epic status <E>` for the 5-line progress summary.
3. If the user asks for "tasks" or "what ran today", run `rk task list --json`.
4. If the user wants more state, run `rk validate --fail-on P0,P1 --json` and `rk next --json`. Otherwise stop.

Read-only. No mutations.
