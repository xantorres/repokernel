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

## 10. Cost-aware agent routing (v1.8+)

Before dispatching implement / review / wave work, ask `rk` which tier should run it:

```bash
rk route <ID> [--profile <implement|review|wave>]
```

This emits a JSON payload with a deterministic `routing_hint`:

```json
{
  "profile": "implement",
  "target": "S-104",
  "routing_hint": {
    "tier": "light",
    "tier_set": ["light", "standard", "heavy"],
    "reason": "rule",
    "rule_id": "small-and-uncritical",
    "signals": { "profile": "implement", "estimated_tokens": 2400, "ac_count": 2, "review_required": false, "allowed_paths_count": 1, "depends_on_count": 0 },
    "score": -1
  }
}
```

`rk` is **agent- and vendor-agnostic**: tier names are abstract (defaults: `light`, `standard`, `heavy`; consumers may override in `routing.tiers`). The mapping from tier to a concrete model ID lives **here in the skill or in the consumer's CLAUDE.md**, never in `rk`.

### Tier → model mapping (edit this in your local copy)

```
# Example mapping for a Claude Code consumer (edit when models change):
light    → claude-haiku-<latest>
standard → claude-sonnet-<latest>
heavy    → claude-opus-<latest>

# Example for a Codex consumer:
light    → gpt-mini
standard → gpt-flagship
heavy    → reasoning-model
```

### Dispatch protocol

1. Read `routing_hint.tier`. Map through the table above.
2. **If `routing_hint.fanout` is present**, fanout IS the execution plan: spawn one agent per entry **in parallel** (single message, multiple tool calls), mapping each entry's `tier` through the same table. Ignore the top-level `tier` for dispatch — it is the summary value for fanout-unaware consumers.
3. If `routing_hint.reason === "pinned"`, the sprint author hard-pinned the tier — do **not** override.
4. If `routing_hint.reason === "rule"`, a project-level policy fired. Trust it — the rule was authored intentionally in `repokernel.config.yaml`.
5. Never edit frontmatter mid-session to change routing. Set `extras.routing.*` in the sprint file at planning time only.

### Authoring routing intent on a sprint

```yaml
extras:
  routing:
    complexity: deep            # trivial | standard | deep — ordinal hint
    prefer_tier: standard       # soft preference (scorer may still override)
    pin_tier: heavy             # HARD override (rk will not change it)
    fanout:                     # opt-in custom fanout (review panels, etc.)
      - { id: fast, tier: light }
      - { id: deep, tier: standard }
```

### Project-level routing policy

`repokernel.config.yaml`:

```yaml
routing:
  tiers: [light, standard, heavy]    # cheap → expensive; consumer-defined
  rules:
    - id: small-and-uncritical
      when: { est_tokens_lt: 3000, ac_count_lte: 3, review_required: false }
      then: { tier: light }
    - id: deep-reasoning
      when: { extras_complexity: deep }
      then: { tier: heavy }
```

Allowed `when` keys: `profile`, `est_tokens`, `allowed_paths_count`, `depends_on_count`, `ac_count`, `review_required`, `gate`, `lane`, `extras_complexity`. Operators are key suffixes: `_lt`, `_lte`, `_gt`, `_gte`. Bare key = equality. First matching rule wins; AND across keys. Hard caps: ≤16 rules, ≤8 fanout entries.

The tier names referenced in your `then.tier`, `then.fanout[].tier`, and `extras.routing.*` MUST appear in `routing.tiers`. `rk validate --fail-on P0,P1` will surface mismatches.

### When to call `rk route` vs `rk context --with-routing`

- **`rk route <ID>`** — fast (<50ms), JSON-only, returns just the routing payload. Use when dispatching: you only need to know which tier to pick.
- **`rk context <ID> --with-routing`** — full packet PLUS embedded `routing_hint`. Use when you also need the implement/review/wave context to feed the agent.

Both call the same resolver. Same answer. Two surfaces.

## 11. Quick reference

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
| Compute panel verdict (G/Y/R) | `rk review-aggregate <SPRINT_ID>` or `rk review-aggregate --verdicts GREEN,YELLOW,RED` |
