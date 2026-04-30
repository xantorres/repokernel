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
- **Never derive a next id by listing `.repokernel/plan/**`.** `rk` owns counter allocation (lock-protected, worktree-shared). Always run `rk create <kind>` and parse the printed id. Computing `E-NNN` / `S-NNN` from `ls`/`sed`/file mtime is a path-discipline violation and races against concurrent allocators.
- **Confirm cwd before any mutating call.** Run `rk status --json` and verify `.configPath` resolves to the repo the user actually means. Cross-repo `cd` (e.g. running rk from the repokernel source repo with intent for a sibling project) requires explicit user confirmation.

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
rk validate          # all findings including P2 base_sha warnings — high context cost
rk validate --audit  # also includes audit-scope findings (historical hygiene; e.g. SHIPPED_SPRINT_MISSING_*)
rk status            # full health report — use only when diagnosing systemic drift
```

Never run Tier 3 at session start or as a default pre-work step. Only run when the user explicitly asks for a full audit or when Tier 2 returns unexpected P0/P1 findings that need more context.

### Rules

- **Never** run `rk validate` bare or `rk status` at session start.
- **Never** substitute `grep` / `ls` on sprint/epic files for `rk` state queries — even if it looks cheaper, it bypasses the canonical state machine and may read stale or partial state. This includes deriving the next entity id (`E-NNN`, `S-NNN`, `R-NNN`) by parsing filenames; that's `rk create`'s job.
- P2 `SHIPPED_SPRINT_MISSING_BASE_SHA` is background noise on mature repos; `--fail-on P0,P1` is the correct default threshold.

## 3. Run an epic (default path)

```bash
rk run <EPIC_ID>
```

Execution strategy lives in the epic file (`execution_strategy: sequential | parallel`), not on the command line. Flags `--lane`, `--limit`, `--dry-run`, `--resume`, `--agent` scope or debug — they must not override project authority. `--parallel` / `--sequential` are CI assertions, not toggles.

## 3a. Scaffold an epic + sprints

Use these commands; never compute the id yourself.

```bash
rk create epic "<title>"
# Prints: Allocated E-NNN  (parse this from stdout)

rk create sprint "<first sprint>" --epic <E-NNN> \
  --allowed-path "<glob>" --json
# --json emits: { kind, id, file, updated, next_actions }
# Parse id from JSON — never derive from ls/sed.
# --allowed-path is repeatable (and accepts comma-separated values), not pluralised.

rk create sprint "<next sprint>" --epic <E-NNN> \
  --after S-AAA \
  --allowed-path "<glob>" --json
# --after auto-sets depends_on: [S-AAA] in the new sprint frontmatter.
# --after is repeatable for multiple predecessors. Never hand-author depends_on for
# sequential chains.

rk create sprint "<sprint>" --epic <E-NNN> --enqueue --json
# --enqueue: synthesizes queue slot + sets status: queued in one step.
# Errors loudly if lane has no queue file (pre-flight check, no orphan state).
```

`--json` is available on every `rk create <kind>` — stable `{ kind, id, file, updated, next_actions }` envelope for agent chaining.

For routing intent, see `/rk-plan` — the slash command performs the one frontmatter edit needed (`extras.routing`) when the user signals complexity, hard-pin, or fanout.

## 4. Manual sprint lifecycle

When driving a single sprint by hand:

```bash
rk start <SPRINT_ID>                                # records base_sha, acquires worktree
# ...edit code within allowed_paths, run tests...
rk review-create --sprint <SPRINT_ID>               # allocates R-NNN stub w/ full v2 scaffold (idempotent)
rk review-aggregate <REVIEW_ID> --findings <json>   # compute verdict (GREEN/YELLOW/RED)
rk review-discard <REVIEW_ID>                       # discard stale/aborted review
rk review-verdict <REVIEW_ID> accepted              # or: changes_requested | rejected
rk close <SPRINT_ID>                                # ships; updates registry
rk close <SPRINT_ID> --skip-checks                  # bypass check command (rare; document why)
```

`rk review-create` is idempotent — second call for same sprint returns existing stub with `reused: true`.

After all sprints are shipped or cancelled, you **must** close the epic:

```bash
rk epic close <EPIC_ID>         # sets status: done, records closed_at
```

Recovery:
```bash
rk reopen <SPRINT_ID>           # reopen a shipped sprint
rk run abort <RUN_ID>           # halt an active run
```

### 4a. Fastpath task commands

```bash
rk task list [--status active|review|shipped|cancelled] [--json]
rk task status <T-NNN>      # id, sprint linkage, source, timestamps, review_sha
rk task inspect <T-NNN>     # full alias JSON + resolved paths + synthesized sprint/review markdown
```

## 5. Debug / drift

```bash
rk doctor                       # diagnose; --fix for safe auto-repair
rk fix --preview                # show mechanical fixes
rk fix --apply                  # apply them
rk registry --check             # detect registry drift
rk registry --write             # regenerate registry from entity files
rk explain <CODE>               # explain any validation finding code
rk runs                         # list runs
rk run inspect <RUN_ID>
rk run logs <RUN_ID>
rk recover --preview            # audit operational state for corruption (worktrees.json, RUN-NNN.json, stale lane claims)
rk recover --apply              # quarantine corrupt files as <path>.corrupt.<isoUtc>.<rand> + rebuild worktrees.json
```

`rk doctor` surfaces operational corruption and points at `rk recover`. Use `--preview` first.

### What `rk fix --apply` repairs mechanically (v1.10.2+)

Run `rk fix --preview --json` to see the safe-vs-manual classification.
Categories that auto-apply:

- Missing config / scaffold dirs / registry / default queue file
- Deprecated config fields (strip)
- Duplicate review IDs (renumber the second+ occurrence)
- `SHIPPED_SPRINT_IN_QUEUE` and `CANCELLED_SPRINT_IN_QUEUE` — drop the
  dead slot from the lane queue. (Pre-fix backlog only; the live
  close path already cleans the queue.)
- Ghost worktree records — `worktrees.json` entries whose path no
  longer exists on disk. Record-only cleanup.
- `SHIPPED_SPRINT_MISSING_BASE_SHA` when a deterministic source
  exists (linked review's `base_sha` or run-state `start_sha`).

Categories that stay **manual** (with copy-paste hints):

- Leaked worktree record where the path still exists on disk —
  removal is destructive (`git worktree remove --force` can drop
  uncommitted work). Use the copy-paste command in the
  `manualSuggestion.detail`, then re-run `rk fix --apply` to scrub
  the now-ghost record.
- `SHIPPED_SPRINT_MISSING_BASE_SHA` with no recoverable source. Pass
  `--base-sha <sha> --sprint <id>` explicitly or accept as known-debt.

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
- Derive the next epic/sprint/review id via `ls .repokernel/plan/**` + `sed`/`awk` — `rk create <kind>` already allocates the id under a lock; agent-side computation races
- Run a mutating `rk` command without first confirming `rk status --json` `.configPath` matches the user's intended repo (cross-repo `cd` is the most common cause of "wrong project" mistakes)
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

## 10a. Machine-readable shapes for agents (v1.10.2+)

Three commands carry agent-friendly JSON output. Read these once and stop
parsing rendered text.

### `rk inspect <ID> --json` — single entity + derived links

```jsonc
{
  "schemaVersion": 1,
  "entityType": "sprint",
  "entity": { /* full frontmatter + body */ },
  "derived": {
    // sprint:
    "depends_on_resolved": [{ "id": "S-NNN", "status": "shipped" }],
    "review_resolved":     { "id": "R-NNN", "verdict": "accepted" } | null,
    "epic_resolved":       { "id": "E-NNN", "status": "active" } | null
    // epic:
    // "sprints_progress": { total, shipped, cancelled, in_flight, remaining_ids }
    //   in_flight     = active | review
    //   remaining_ids = planned | pending | queued | reopened
    // review:
    // "sprint_resolved": { id, status, epic_id }
    //   status === 'missing' when the linked sprint file is gone
  }
}
```

Use `entity.body` instead of opening the file directly. Use `derived.*`
instead of round-tripping additional inspects.

### `rk ls epics --json` — dense sprintCounts + progress

```jsonc
{
  "epics": [{
    "id": "E-NNN",
    "title": "...",
    "status": "active",
    "gate": null,
    "sprintCounts": {
      // ALL 8 SprintStatus keys, zero-filled — no `?? 0` needed:
      "planned":0, "pending":0, "queued":0, "active":0,
      "review":0, "shipped":3, "reopened":0, "cancelled":0
    },
    "total": 3,
    "progressPercent": 100,
    "sprints": ["S-001", "S-002", "S-003"]
  }]
}
```

### `rk ls sprints --last N` — recent activity

Sorted by `closed_at ?? started_at` desc. Combine with `--epic <ID>` or
`--status shipped` for finer cuts. Replaces jq-on-output sorting.

```bash
rk ls sprints --epic E-053 --last 5 --json
rk ls sprints --status shipped --last 10 --json
```

### `rk next --json` — enriched runtime context

In addition to the existing `lane` / `result` / `sprintId` / `queue` fields:

```jsonc
{
  "active_epic_progress": {
    "epicId": "E-NNN",
    "shipped": 4,
    "total": 6,
    "in_flight": ["S-235"],     // active | review
    "remaining_ids": ["S-236"]  // planned | pending | queued | reopened
  },
  "last_closed": { "sprintId": "S-NNN", "closedAt": "ISO-8601" } | null,
  "queue_depth": { "lane": "main", "slots": 4, "queued": 2, "active": 1 }
}
```

Use these to power "what just shipped?" banners and chained-epic progress
without separate calls to `rk inspect <epic>` and `rk ls sprints`.

## 11. Quick reference

| Need | Command |
|---|---|
| What's safe to do? | `rk validate --fail-on P0,P1` |
| What runs next? | `rk next` |
| Run the whole epic | `rk run <EPIC_ID>` |
| Single sprint by hand | `rk start` → edit → `rk review-create --sprint` → `rk review-aggregate` → `rk close` |
| Close a finished epic | `rk epic close <EPIC_ID>` |
| Why is state broken? | `rk doctor`, `rk explain <CODE>` |
| Fix safe drift | `rk fix --preview` then `rk fix --apply` |
| Inspect anything | `rk inspect <ID>` (`--json` returns derived links) |
| Recent sprint activity | `rk ls sprints --last N --json` |
| Single-epic sprint list | `rk ls sprints --epic E-NNN --json` |
| List runs | `rk runs` |
| Compute panel verdict (G/Y/R) | `rk review-aggregate <SPRINT_ID>` or `rk review-aggregate --verdicts GREEN,YELLOW,RED` |
| Action brief (handoff to founder/operator) | `rk brief <SPRINT_ID\|EPIC_ID>` (auto-gate) or `rk brief <ID> --gate=<type>` |
| Scaffold a project-side command + protocol pair | `rk scaffold command <name> --with-protocol` (see docs/recipes/protocol-layer.md) |
| Recover corrupt operational state | `rk recover --preview` then `rk recover --apply` |
| Create sprint + enqueue in one step | `rk create sprint --enqueue --json` |
| Fastpath task list | `rk task list [--status <s>] [--json]` |

## 12. Config schema (`repokernel.config.yaml`)

```yaml
requires: ">=1.13.0"
policies:
  skippedSprintIds: [3, 7]
  requireReviewForShippedFromSprintId: 12
  severityFailThreshold: P1
  defaultLane: main                           # single-segment identifier only
worktrees:
  branchPrefix: rk/
  branchPattern: "{branchPrefix}epic/{epicId}/{sprintId}"   # optional, v1.13+
automation:
  checksTimeoutSeconds: 1800                  # SIGTERM/SIGKILL escalation + process-group cleanup (default 1800)
agents:
  myAgent:
    envPassthrough: [MY_TOKEN, MY_VAR]        # explicit env opt-in; default allowlist covers OS + locale essentials
routing:
  tiers: [light, standard, heavy]
  rules:
    - id: deep-work
      when: { extras_complexity: deep }
      then: { tier: heavy }
```

`extras:` is the ONLY rk-canonical place for per-entity project fields. Lane names are strict single-segment identifiers — rejects `.`, `..`, `.git`, `/`, `\`, NUL, Windows reserved device names.

## 13. Tracker bridge (v1.13+)

`rk create epic --from-tracker <source>:<ref>` seeds title and body from JIRA / Linear / GitHub Issues. Forms:

- `gh:owner/repo#NNN` — GitHub Issues. Auth via `gh` CLI.
- `jira:KEY-NN` — JIRA Cloud REST v3. Env: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.
- `linear:ABC-NN` — Linear GraphQL. Env: `LINEAR_API_KEY`.

Linkage stored in epic frontmatter under `extras.external_id`, `extras.tracker_source`, `extras.tracker_url`, `extras.tracker_labels`, `extras.tracker_assignee`. No schema change — `extras` is already the canonical project-fields slot.

Read-only ingest. Failures (offline, 401, 404, 5s timeout) emit a stderr warning and fall through to plain create with the user-provided title. Bridge never blocks creation.

## 14. Custom branch naming (v1.13+)

`worktrees.branchPattern` overrides the default `${branchPrefix}epic/${epicId}` and `${branchPrefix}sprint/${epicId}/${sprintId}` naming. Tokens (v1.13): `{branchPrefix}`, `{epicId}`, `{sprintId}`. Reserved for v1.14: `{ticket}`, `{slug}` (rejected at render with a clear error).

Pattern is validated at config load (`git check-ref-format` rules: no `..`, `//`, `\\`, `@{`, no whitespace/control, no `~^:?*[]` outside token literals). Sprint-level resolution requires `{sprintId}` in the pattern; otherwise throws `CONFIG_INVALID` at sprint-acquire time to prevent collision with the epic branch.

## 15. CI gate (v1.13+)

The `rk-validate` composite GitHub Action runs `rk validate` as a PR check, posts a sticky comment with severity counts, emits inline annotations, and uploads the JSON findings as an artifact. Skips gracefully when `repokernel.config.yaml` is absent.

```yaml
- uses: xantorres/repokernel/.github/actions/rk-validate@v1.13.0
  with:
    fail-on: P0,P1
    version: 1.13.0
```

See `.github/actions/rk-validate/README.md` for inputs and behavior matrix.
