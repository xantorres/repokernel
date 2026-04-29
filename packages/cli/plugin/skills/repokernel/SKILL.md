---
name: repokernel
description: Operate a RepoKernel-governed repo. Six verbs (status, next, run, review, doctor, plan) map to slash commands that drive the rk CLI.
version: 0.3.0
---

# RepoKernel Operator

Six verbs. Each verb is a slash command.

| Intent | Slash |
|---|---|
| "status", "where are we" | `/rk-status` |
| "what's next" | `/rk-next` |
| "run this", "ship it", "fix bug X" | `/rk-run` |
| "review" | `/rk-review` |
| "doctor", "what's broken" | `/rk-doctor` |
| "plan an epic" | `/rk-plan` |

For one-line CLI lookups: `reference/cheatsheet.md`.

## Cold-start check

Before any verb other than `/rk-status` or `/rk-doctor`, run `rk status --brief --json` once. If `initialized: false`, halt and tell the user:

> Repo not initialized. Run `rk init --commit` (or `rk init --example --commit` to scaffold a starter epic), then re-invoke.

Do not proceed past this check until init exists. `/rk-status` and `/rk-doctor` are safe to run uninitialized — both handle the case explicitly.

## Tier routing

`rk route <ID> --json` returns `routing_hint.tier` (`light` / `standard` / `heavy`). Map to your harness:

```
light    → cheap reasoning model
standard → default coding model
heavy    → strongest reasoning model
```

If `routing_hint.fanout` is present, dispatch one agent per entry in parallel (single message, multiple tool calls). If `reason: "pinned"`, do not override.

## Stop conditions

- `rk status --brief --json` returns `initialized: false` → stop, surface init guidance.
- `rk validate --fail-on P0,P1` exits non-zero → route to `/rk-doctor`.
- `rk next` returns `blocked` → surface the reason.
- A run reaches `merge_conflict` / `agent_failed` / `path_violation` → run `rk run inspect <RUN_ID>`, surface to user.
