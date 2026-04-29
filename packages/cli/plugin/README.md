# RepoKernel Plugin

Agent-operated workflow for RepoKernel. Six verbs drive the `rk` CLI.

## Install

```bash
npm i -g repokernel
rk install-skill            # default target ~/.claude
rk install-skill --dry-run  # preview
rk install-skill --force    # overwrite divergent install
```

For local dev (no install): `claude --plugin-dir packages/cli/plugin`.

## Verbs

| Slash | Use |
|---|---|
| `/repokernel:rk-status`  | Read-only dashboard |
| `/repokernel:rk-next`    | Next runnable sprint with tier hint |
| `/repokernel:rk-run`     | Execute sprint / epic / fastpath |
| `/repokernel:rk-review`  | Parallel review panel; record verdict |
| `/repokernel:rk-doctor`  | Drift triage (read-only plan) |
| `/repokernel:rk-plan`    | Scaffold an epic |

## Hooks

- **PreToolUse** — blocks direct edits to `.repokernel/**`; routes to the matching `rk` command.
- **SessionStart** — injects a one-line dashboard (`rk status --brief`) on RK repos.
- **PostToolUse** — after `rk close`, surfaces what's now unblocked.

All hooks exit silently on missing dependencies. License: MIT.
