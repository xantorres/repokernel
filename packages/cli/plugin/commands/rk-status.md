---
name: rk-status
description: Read-only RepoKernel dashboard. Use for "status", "where are we".
---

# /repokernel:rk-status

Run `rk status --brief --json` and render the result.

If the user wants more, also run `rk validate --fail-on P0,P1 --json` and `rk next --json`. Otherwise stop.

Read-only. No mutations.
