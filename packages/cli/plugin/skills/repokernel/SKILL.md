---
name: repokernel
description: Operate a RepoKernel-governed repo. Six verbs (status, next, run, review, doctor, plan) map to slash commands that drive the rk CLI.
version: 0.2.0
---

# RepoKernel Operator

Six verbs. Each verb is a slash command.

| Intent | Slash |
|---|---|
| "status", "where are we" | `/repokernel:rk-status` |
| "what's next" | `/repokernel:rk-next` |
| "run this", "ship it", "fix bug X" | `/repokernel:rk-run` |
| "review" | `/repokernel:rk-review` |
| "doctor", "what's broken" | `/repokernel:rk-doctor` |
| "plan an epic" | `/repokernel:rk-plan` |

For one-line CLI lookups: `reference/cheatsheet.md`.

## Tier routing

`rk route <ID> --json` returns `routing_hint.tier` (`light` / `standard` / `heavy`). Map to your harness:

```
light    → cheap reasoning model
standard → default coding model
heavy    → strongest reasoning model
```

If `routing_hint.fanout` is present, dispatch one agent per entry in parallel (single message, multiple tool calls). If `reason: "pinned"`, do not override.

## Stop conditions

- `rk validate --fail-on P0,P1` exits non-zero → route to `/repokernel:rk-doctor`.
- `rk next` returns `blocked` → surface the reason.
- A run reaches `merge_conflict` / `agent_failed` / `path_violation` → run `rk run inspect`, surface to user.
