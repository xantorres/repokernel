# RepoKernel Plugin

Agent-operated workflow for RepoKernel. Seven verbs drive the `rk` CLI.

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
| `/rk-status`  | Read-only dashboard |
| `/rk-next`    | Next runnable sprint with tier hint |
| `/rk-run`     | Execute sprint / epic / fastpath |
| `/rk-review`  | Parallel review panel; record verdict |
| `/rk-doctor`  | Drift triage (read-only plan) |
| `/rk-plan`    | Scaffold an epic |
| `/rk-reject`  | Record an out-of-scope decision |

## Hooks

- **PreToolUse** — blocks direct edits to `.repokernel/**`; routes to the matching `rk` command.
- **SessionStart** — injects a one-line dashboard (`rk status --brief`) on RK repos.
- **PostToolUse** — after `rk close`, `rk ship`, `rk epic close`, or `rk epic ship`, surfaces what's now unblocked.

## Ceremony helpers

The skill now prefers the high-level CLI flows when they fit: `rk ship <S-NNN>` for sprint review/close/validate/registry, `rk gates <S-NNN>` for full gates, `rk plan <E-NNN> --create-sprint --enqueue` for straightforward epic authoring, and `rk wave <E-NNN[..E-NNN]>` for dependency-order previews.

All hooks exit silently on missing dependencies. License: MIT.
