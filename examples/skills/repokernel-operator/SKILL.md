---
name: repokernel-operator
description: Operate safely inside a repository governed by RepoKernel. Use rk commands as the single source of truth for sprint, queue, review, run, registry, lane, and worktree state — never infer lifecycle from prose, never edit state files directly.
---

# RepoKernel Operator

Skill for AI coding agents working inside an RK-governed repo. Drive the state machine through `rk`. Do not reason about lifecycle from markdown.

## 1. Authority

`rk` is source of truth for: epics, sprints, queues, lanes, reviews, runs, registry, worktrees.

Rules:
- Use `rk` commands. Do not infer state from prose, tables, or commit history.
- Do not hand-edit generated files (`.repokernel/registry.json`, run logs, review artifacts).
- Do not mutate sprint/epic frontmatter unless no `rk` command exists for the change.
- If unsure of state, run `rk validate --fail-on P0,P1` first.

## 2. Pre-work checks

Three cost tiers. Use the cheapest tier that answers the question.

### Tier 1 — session start / state query (default)

```bash
rk epic status <EPIC_ID>   # 5-line summary: status, progress, blocking
rk ls epics                # one row per epic
rk next                    # next runnable sprint in default lane
rk inspect <ID>            # full entity detail when needed
```

Use Tier 1 at session start and for any "what's the state?" question. Never skip straight to Tier 2 or 3 to "be thorough".

### Tier 2 — pre-code check (run before touching code or schema)

```bash
rk validate --fail-on P0,P1   # blocks on blockers only; P2 noise suppressed
```

Run Tier 2 before editing code. If it exits non-zero, stop and fix the root cause. Do not bypass.

### Tier 3 — full audit (explicit request only, never at session start)

```bash
rk validate   # all findings including P2 base_sha warnings — high context cost
rk status     # full health report — use only when diagnosing systemic drift
```

Never run Tier 3 at session start or as a default pre-work step. Only run when the user explicitly asks for a full audit or when Tier 2 returns unexpected P0/P1 findings that need more context.

### Rules

- **Never** run `rk validate` bare or `rk status` at session start.
- **Never** substitute `grep` / `ls` on sprint/epic files for `rk` state queries — even if it looks cheaper, it bypasses the canonical state machine and may read stale or partial state.
- P2 `SHIPPED_SPRINT_MISSING_BASE_SHA` is background noise on mature repos; `--fail-on P0,P1` is the correct default threshold.

## 3. Run an epic (default path)

```bash
rk run <EPIC_ID>
```

Execution strategy lives in the epic file (`execution_strategy: sequential | parallel`), not on the command line. Flags `--lane`, `--limit`, `--dry-run`, `--resume`, `--agent` scope or debug — they must not override project authority. `--parallel` / `--sequential` are CI assertions, not toggles.

## 4. Manual sprint lifecycle

When driving a single sprint by hand:

```bash
rk start <SPRINT_ID>            # records base_sha, acquires worktree
# ...edit code within allowed_paths, run tests...
rk review <SPRINT_ID>           # creates review artifact
rk review-verdict <REVIEW_ID> approved   # or: changes_requested | rejected
rk close <SPRINT_ID>            # ships; updates registry
```

After all sprints are shipped or cancelled, you **must** close the epic:

```bash
rk epic close <EPIC_ID>         # sets status: done, records closed_at
```

Recovery:
```bash
rk reopen <SPRINT_ID>           # reopen a shipped sprint
rk run abort <RUN_ID>           # halt an active run
```

## 5. Debug / drift

```bash
rk doctor                       # diagnose; --fix for safe auto-repair
rk fix --preview                # show mechanical fixes (deprecated fields, missing base_sha)
rk fix --apply                  # apply them
rk registry --check             # detect registry drift
rk registry --write             # regenerate registry from entity files
rk explain <CODE>               # explain any validation finding code
rk runs                         # list runs
rk run inspect <RUN_ID>
rk run logs <RUN_ID>
```

## 6. Stop rules

Halt and surface to user:
- Any `P0` or `P1` finding from `rk validate` (default `severityFailThreshold: P1`).
- `rk next` returns `blocked`.
- `rk doctor` reports unhealthy state that `rk fix --apply` cannot resolve.
- Path-safety violation during agent output validation.

Never silence validation by editing files or deleting findings. `--fail-on P0,P1` is the correct default (suppresses P2 noise only); using `--fail-on P2` or `--only` to hide genuine P0/P1 blockers is forbidden. Fix the cause or call `rk fix`.

## 7. Path discipline

Each sprint declares `allowed_paths` and `denied_paths` (globs) in frontmatter. RepoKernel enforces these on agent output.

- Stay inside `allowed_paths`. Avoid `denied_paths`.
- Never `git add .` or `git add -A`. Stage explicit paths only.
- Do not touch unrelated dirty files in the worktree.
- A path violation produces a finding — abort the sprint, do not work around it.

## 8. Parallel / epic execution

- `rk run <EPIC_ID>` reads `execution_strategy` from the epic file and runs waves automatically. No extra flag needed.
- For parallel epics: each sprint runs in its own worktree under the epic; dependency waves resolve from `depends_on:`.
- Discover state, never guess:

```bash
rk lane ls                      # list lanes (don't invent names)
rk sprint ls --epic <EPIC_ID>   # sprints in an epic
rk ls reviews                   # existing reviews (don't fabricate review IDs)
rk queue add <SPRINT_ID> --lane <NAME>   # explicit enqueue when needed
rk gate ls                      # blocking gates
```

## 9. Anti-patterns — never do this

- Edit `.repokernel/registry.json` by hand
- Mark a sprint shipped by changing `status:` in frontmatter
- Set `status: done` in epic frontmatter directly — use `rk epic close <EPIC_ID>` instead
- Infer "next sprint" from a markdown table, README, or prose
- Create lanes ad-hoc — use `rk lane acquire <EPIC_ID>`
- Skip `rk review` / `rk close`; "just commit and move on"
- Use `--fail-on P2` or `--only` to suppress genuine P0/P1 blockers (P2-only suppression via `--fail-on P0,P1` is correct behavior, not an anti-pattern)
- Run `rk validate` bare or `rk status` at session start on mature repos (use Tier 1 instead)
- `git add .` inside an RK worktree
- Run two sprints concurrently in the same worktree — let `rk run` manage worktrees per sprint

## 10. Quick reference

| Need | Command |
|---|---|
| What's safe to do? | `rk validate --fail-on P0,P1` |
| What runs next? | `rk next` |
| Run the whole epic | `rk run <EPIC_ID>` |
| Single sprint by hand | `rk start` → edit → `rk review` → `rk close` |
| Close a finished epic | `rk epic close <EPIC_ID>` |
| Why is state broken? | `rk doctor`, `rk explain <CODE>` |
| Fix safe drift | `rk fix --preview` then `rk fix --apply` |
| Inspect anything | `rk inspect <ID>` |
| List runs | `rk runs` |
