---
name: repokernel
description: Operate safely inside a repository governed by RepoKernel. Use rk commands as the single source of truth for sprint, queue, review, run, registry, lane, and worktree state — never infer lifecycle from prose, never edit state files directly. Use the six verbs (status, next, run, review, doctor, plan) to drive daily work; load reference/quick-reference.md for command syntax.
version: 0.1.0
---

# RepoKernel Operator

Agent skill for working inside an RK-governed repo. Drive the state machine through `rk`. Never reason about lifecycle from markdown.

## 1. Authority

`rk` is source of truth for: epics, sprints, queues, lanes, reviews, runs, registry, worktrees.

- Use `rk` commands. Do not infer state from prose, tables, or commit history.
- Do not hand-edit generated files (`.repokernel/registry.json`, run logs, review artifacts).
- Do not mutate sprint/epic frontmatter unless no `rk` command exists for the change.
- If unsure of state, run `rk validate --fail-on P0,P1` first.

## 2. State rules

- Never run `rk validate` bare or `rk status` at session start — they dump P2 noise. Use `rk validate --fail-on P0,P1`.
- Never substitute `grep`/`ls` on sprint/epic files for `rk` state queries — bypasses the state machine.
- Never invent IDs. If `rk ls` doesn't show it, it doesn't exist.

## 3. Six verbs (DISPATCH)

Map user intent to a slash command. Do not call `rk` directly until you've identified the verb.

| User intent | Verb | Slash | What it does |
|---|---|---|---|
| "where are we", "status" | status | `/repokernel:rk-status` | Read-only dashboard: epics, next sprint, P0/P1, lanes |
| "what's next", "what should I work on" | next | `/repokernel:rk-next` | Resolve next runnable sprint with tier hint |
| "ship it", "run this", "do the next sprint" | run | `/repokernel:rk-run` | Execute sprint or epic; pause on review or failure |
| "review", "verdict accepted/rejected" | review | `/repokernel:rk-review` | Parallel review panel; merge findings; record verdict |
| "fix the errors", "doctor", "what's broken" | doctor | `/repokernel:rk-doctor` | Drift triage; never auto-applies fixes |
| "plan an epic for X", "scaffold sprints" | plan | `/repokernel:rk-plan` | Author epic + 3-6 sprints; validate; do not auto-execute |

Anything outside the six verbs falls back to direct `rk` invocation. See `reference/quick-reference.md` for the underlying CLI surface.

## 4. Cost-aware tier mapping

`rk route <ID> --profile <implement|review|wave>` emits JSON with `routing_hint.tier` (default values: `light`, `standard`, `heavy`). Map that tier through your harness's local table:

```
light    → your cheapest reasoning-capable model
standard → your default coding model
heavy    → your strongest reasoning model
```

Concrete vendor examples (replace with your harness's current model IDs) live in `reference/quick-reference.md`. If `routing_hint.fanout` is present, dispatch one agent per entry in parallel (single message, multiple tool calls). If `reason: "pinned"`, do not override.

The mapping table is consumer-side. `rk` is vendor-neutral; never edit `repokernel.config.yaml` to encode model IDs.

## 5. Top anti-patterns

- Editing `.repokernel/registry.json` by hand → use `rk fix --preview` or `rk registry --write`.
- Marking a sprint shipped by changing `status:` in frontmatter → use `rk close <ID>`.
- Running `rk validate` bare at session start → use `rk validate --fail-on P0,P1`.

Full list: `reference/quick-reference.md` (Phase 1.3 will move this to `reference/anti-patterns.md`).

## 6. Stop rules

Halt and surface to user when any of these fire:

- `rk validate --fail-on P0,P1` exits non-zero.
- `rk next` returns `blocked`.
- `rk doctor` reports unhealthy state that `rk fix --apply --yes` cannot resolve.
- A path-safety violation surfaces during agent output validation.

Never silence validation by editing files or deleting findings. `--fail-on P0,P1` is the correct default; `--fail-on P2` is stricter and allowed when intentionally treating P2 warnings as blockers. Using `--only P2` or `--only P3` to hide P0/P1 blockers is forbidden.

## 7. Reference

For command syntax, tier→model examples, and the full anti-pattern list: `reference/quick-reference.md`.
