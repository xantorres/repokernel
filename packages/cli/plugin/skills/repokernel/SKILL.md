---
name: repokernel
description: Operate a RepoKernel-governed repo. Seven verbs (plan, status, next, run, review, doctor, reject) map to slash commands that drive the rk CLI. Lifecycle order — plan first, doctor only on drift.
version: 1.24.0
---

# RepoKernel Operator

Seven verbs. Each verb is a slash command.

| Intent | Slash |
|---|---|
| "plan an epic", "new feature", "scope this work" | `/rk-plan` |
| "status", "where are we" | `/rk-status` |
| "what's next" | `/rk-next` |
| "run this", "ship it", "fix bug X" | `/rk-run` |
| "review" | `/rk-review` |
| "doctor", "what's broken" | `/rk-doctor` |
| "reject this", "won't fix", "out of scope", "we already said no to X" | `/rk-reject` |

For one-line CLI lookups: `reference/cheatsheet.md`.

## Cold-start check

Before any verb other than `/rk-status` or `/rk-doctor`, run `rk status --brief --json` once. If `initialized: false`, halt and tell the user:

> Repo not initialized. Run `rk init --commit` (or `rk init --example --commit` to scaffold a starter epic), then re-invoke.

Do not proceed past this check until init exists. `/rk-status` and `/rk-doctor` are safe to run uninitialized — both handle the case explicitly.

## Operational preflight

Once per session — before the first verb that dispatches work — run `rk preflight --json` (or `rk team status --json` until preflight ships). Surface any non-empty `operational.collection_errors`, `operational.live_claims`, or `operational.leaked_worktrees`. The preflight is session-scoped: do not re-run it per command. If the user reports state drift mid-session, run it again. Plugin commands (`/rk-next`, `/rk-run`, `/rk-review`) trust this single preflight; they do not invoke `rk team status` themselves.

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
- `rk next` returns `blocked` → surface the reason. If the user asks what can be planned next, use `rk next --include-planned --json`.
- A run reaches `merge_conflict` / `agent_failed` / `path_violation` → run `rk run inspect <RUN_ID>`, surface to user.
- `rk doctor` surfaces operational corruption → run `rk recover --preview` then `rk recover --apply`.

## Ceremony commands

Prefer the high-level CLI when the user asks for the safe boring flow:

| Need | Command |
|---|---|
| Ship one accepted sprint | `rk ship <S-NNN>` |
| Run all sprint gates | `rk gates <S-NNN>` |
| Close a completed epic | `rk epic ship <E-NNN>` |
| Author and enqueue a straightforward epic sprint | `rk plan <E-NNN> --create-sprint --enqueue` |
| Preview dependency order across epics | `rk wave <E-NNN[..E-NNN]>` |
| Apply eligible planned work in a wave | `rk wave <selector> --apply --enqueue` |
| Record manual command proof | `rk review-evidence <S-NNN|R-NNN> --label <name> --command "<cmd>" --exit-code <n>` |

`rk ship` runs review, review-sprint, accepted-verdict check, close, validate, and registry check. `rk gates` runs `automation.checksCmd` when configured, path checks, validation, and registry drift check. Both print `allowed_paths` / `denied_paths` and append review `command_evidence` when a review is linked.

Review stubs default `reviewer:` from `automation.defaultReviewer`. Do not patch review files just to change `agent` to `codex`; update config or pass a command override where available.

## Tracker bridge

When `/rk-plan` runs against a JIRA / Linear / GitHub Issues ticket, pass `--from-tracker <source>:<ref>` to `rk create epic` to seed title + body from the ticket and record `extras.tracker_*`. When `/rk-run` is a one-shot from a ticket, pass `--from-tracker <source>:<ref>` directly to `rk run`. Tracker ingest fails closed on offline / 401 / 404 before writing state. Use `--allow-tracker-fallback` only after explicit user approval. See `reference/cheatsheet.md` for forms.

## Custom branch naming

`worktrees.branchPattern` is compatibility shorthand: without `{sprintId}` it applies to epic branches only; with `{sprintId}` it applies to sprint branches only. Prefer explicit `worktrees.epicBranchPattern` + `worktrees.sprintBranchPattern` for custom naming. Tokens: `{branchPrefix}`, `{epicId}`, `{sprintId}`. Skill should not inspect or override pattern — config-driven, no skill-level branching.
