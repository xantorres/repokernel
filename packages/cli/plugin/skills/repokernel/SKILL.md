---
name: repokernel
description: Operate a RepoKernel-governed repo. Seven verbs (plan, status, next, run, review, doctor, reject) map to slash commands that drive the rk CLI. Lifecycle order — plan first, doctor only on drift.
version: 1.27.0
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

## Trust check (session start)

If you see `TRUST_DENIED`, `TRUST_FILE_INVALID`, `TRUST_FILE_UNREADABLE`, or `TRUST_FILE_VERSION_UNSUPPORTED`, the user-local trust file at `~/.repokernel/trust.yaml` is missing a grant or malformed. Surface the message verbatim (it includes the file path and remediation) and point the user at `docs/trust.md`. Common fix: `rk trust audit /path/to/repo > ~/.repokernel/trust.yaml`. The plugin's `session-start.sh` hook runs `rk trust check` automatically, so you usually see the hint at session boot, not mid-task.

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
- A `TRUST_*` error kind → see Trust section above; do NOT retry without first seeding grants.

## Ceremony commands

Prefer the high-level CLI when the user asks for the safe boring flow:

| Need | Command |
|---|---|
| Ship one accepted sprint | `rk ship <S-NNN>` |
| Run all sprint gates (target-scoped by default) | `rk gates <S-NNN>` |
| Run gates against the whole-project validator | `rk gates <S-NNN> --target-scope global` |
| Close a completed epic | `rk epic ship <E-NNN>` |
| Author and enqueue a straightforward epic sprint | `rk plan <E-NNN> --create-sprint --enqueue` |
| Preview dependency order across epics | `rk wave <E-NNN[..E-NNN]>` |
| Preview a parallel-execution plan (waves with disjoint paths) | `rk wave --parallel-plan [SELECTOR]` |
| Apply eligible planned work in a wave | `rk wave <selector> --apply --enqueue` |
| Remove a queued sprint and its dependent closure atomically | `rk queue remove <S-NNN> --lane <name> --cascade-dependents` |
| Record manual command proof | `rk review-evidence <S-NNN\|R-NNN> --label <name> --command "<cmd>" --exit-code <n>` |

`rk ship` runs review, review-sprint, accepted-verdict check, close, validate, and registry check. `rk gates` runs `automation.checksCmd` (or `automation.checksPhases` per-phase) when configured, path checks, validation, and registry drift check. Both print `allowed_paths` / `denied_paths` and append review `command_evidence` when a review is linked.

### Target-aware validation (1.20.0+)

`rk gates <S-NNN>` validates in the **target sprint's frame of reference** by default: a queued downstream dependent waiting on this sprint to ship does NOT block the gate. Pass `--target-scope global` only when investigating registry hygiene across all sprints (same surface as `rk validate`).

### Queue cascade (1.20.0+)

`rk queue remove <S-NNN> --lane <name>` refuses by default when removing the sprint would orphan queued dependents. Either remove them first manually or pass `--cascade-dependents` to remove the transitive closure atomically. Failure mid-cascade rolls back the whole transaction — the queue is byte-identical to before the call.

### Path policy (1.22.0+)

`diff-paths` accepts `allowed_paths ∪ generated_paths`. Sprints that touch declared generated files (`.repokernel/registry.json`, etc.) do not need to widen `allowed_paths` to cover metadata — list those files under `generated_paths` and `rk gates` lets them through.

### Parallel wave plan (1.24.0+)

`rk wave --parallel-plan [SELECTOR]` emits a deterministic plan of waves where every sprint in a wave can run concurrently (disjoint `allowed_paths`, deps in strictly prior waves). Accepts `S-NNN`, `S-NNN..S-NNN`, `E-NNN`, `E-NNN..E-NNN`, mixed comma-separated. With no selector, plans every queued/planned sprint. Pure read; never mutates state. Use the JSON envelope to dispatch concurrently from a coordinator.

## Review stub identity

Review stubs default `reviewer:` from `automation.reviewer` (when set) or `automation.defaultReviewer`. Do not patch review files just to change `agent` to `codex`; update config:

```yaml
automation:
  reviewer: codex
```

(1.23.0+ — `automation.reviewer` takes precedence over `defaultReviewer`.)

## Phased checks (1.23.0+)

If a project prefers per-phase visibility (lint vs typecheck vs build vs test) over a single rolled-up command, use `automation.checksPhases`:

```yaml
automation:
  checksPhases:
    check: pnpm check
    typecheck: pnpm typecheck
    build: pnpm -r build
    test: pnpm -r test
```

`checksCmd` and `checksPhases` are mutually exclusive. `rk gates` runs each configured phase in order, stops at the first failure, and records per-phase status in review evidence.

## Binary self-check (1.23.0+)

When multiple `rk` installs coexist (pnpm-link + npm-global), set `automation.binary` to the expected absolute path. `rk doctor` resolves `rk` via `which`/`where` and surfaces a mismatch:

```yaml
automation:
  binary: /Users/me/.local/bin/rk
```

## Tracker bridge

When `/rk-plan` runs against a JIRA / Linear / GitHub Issues ticket, pass `--from-tracker <source>:<ref>` to `rk create epic` to seed title + body from the ticket and record `extras.tracker_*`. When `/rk-run` is a one-shot from a ticket, pass `--from-tracker <source>:<ref>` directly to `rk run`. Tracker ingest fails closed on offline / 401 / 404 before writing state. Use `--allow-tracker-fallback` only after explicit user approval. See `reference/cheatsheet.md` for forms.

## Custom branch naming

`worktrees.branchPattern` is compatibility shorthand: without `{sprintId}` it applies to epic branches only; with `{sprintId}` it applies to sprint branches only. Prefer explicit `worktrees.epicBranchPattern` + `worktrees.sprintBranchPattern` for custom naming. Tokens: `{branchPrefix}`, `{epicId}`, `{sprintId}`. Skill should not inspect or override pattern — config-driven, no skill-level branching.
