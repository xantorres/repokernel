# Agent operating discipline

Rules for any coding agent driving `rk` inside a governed repo. The CLI is the
single source of truth for epics, sprints, queues, lanes, reviews, runs, the
registry, and worktrees — never infer lifecycle state from markdown, tables, or
commit history.

> Command syntax lives in [cli-reference.md](../internals/cli-reference.md);
> this page covers how an agent should behave, not what each flag does.

## Authority

- Do not hand-edit generated files (`.repokernel/registry.json`, run logs,
  review artifacts).
- Do not mutate sprint or epic frontmatter when an `rk` command exists for the
  change.
- Never derive a next entity id by listing `.repokernel/plan/**`. Id allocation
  is lock-protected and worktree-shared; run `rk create <kind>` and parse the
  printed id. Computing `E-NNN` / `S-NNN` from `ls`, `sed`, or file mtimes races
  against concurrent allocators.
- Confirm cwd before any mutating call: run `rk status --json` and check that
  `.configPath` resolves to the repo the user means. Cross-repo `cd` is the most
  common cause of "wrong project" mutations; ask before proceeding.

## Pre-work checks: three cost tiers

Use the cheapest tier that answers the question.

| Tier | When | Commands |
|---|---|---|
| 1 — state query | session start, any "what's the state?" | `rk epic status <ID>`, `rk ls epics`, `rk next`, `rk inspect <ID>` |
| 2 — pre-code | before touching code or schema | `rk validate --fail-on P0,P1` |
| 3 — full audit | explicit request only | `rk validate`, `rk validate --audit`, `rk status` |

Never run bare `rk validate` or `rk status` at session start on a mature repo:
tier 3 output is large and mostly P2 background noise
(`SHIPPED_SPRINT_MISSING_BASE_SHA` in particular). `--fail-on P0,P1` is the
correct default threshold. If tier 2 exits non-zero, stop and fix the root
cause — do not bypass.

## Path discipline

Each sprint declares `allowed_paths` and `denied_paths` globs in frontmatter,
enforced on agent output.

- Stay inside `allowed_paths`; avoid `denied_paths`.
- Never `git add .` or `git add -A` — stage explicit paths only.
- Do not touch unrelated dirty files in the worktree.
- A path violation produces a finding: abort the sprint, do not work around it.

## Stop rules

Halt and surface to the operator when:

- `rk validate` reports any P0 or P1 finding.
- `rk next` returns `blocked`.
- `rk doctor` reports state that `rk fix --apply` cannot resolve.
- Agent output fails path-safety validation.

Never silence validation by editing files or deleting findings, and never use
`--fail-on P2` or `--only` to hide genuine P0/P1 blockers. Fix the cause or run
`rk fix`.

## Anti-patterns

- Editing `.repokernel/registry.json` by hand.
- Marking a sprint shipped by changing `status:` in frontmatter, or setting
  `status: done` on an epic instead of `rk epic close <ID>`.
- Inferring "next sprint" from a README or prose.
- Creating lanes ad hoc instead of `rk lane acquire <EPIC_ID>`.
- Skipping `rk review` / `rk close` ("just commit and move on").
- Running two sprints concurrently in one worktree — `rk run` manages worktrees
  per sprint.

## Cost-aware routing

Before dispatching implement, review, or wave work, ask which tier should run
it:

```bash
rk route <ID> [--profile <implement|review|wave>]
```

The JSON payload carries a deterministic `routing_hint` with `tier`,
`tier_set`, `reason`, `rule_id`, `signals`, and `score`. Tier names are
abstract (defaults `light`, `standard`, `heavy`); the mapping from tier to a
concrete model belongs to the consumer (its agent config), never to `rk`. A
reasonable default: `light` → cheapest model, `standard` → the everyday coding
model, `heavy` → the strongest reasoning model.

Dispatch protocol:

1. Read `routing_hint.tier` and map it through the consumer's table.
2. If `routing_hint.fanout` is present, fanout is the execution plan: spawn one
   agent per entry in parallel, mapping each entry's `tier` the same way. The
   top-level `tier` is only a summary for fanout-unaware consumers.
3. `reason: "pinned"` means the sprint author hard-pinned the tier — never
   override.
4. `reason: "rule"` means a project policy in `repokernel.config.yaml` fired —
   trust it.
5. Never edit frontmatter mid-session to change routing; `extras.routing.*` is
   set at planning time only.

### Authoring routing intent

Per sprint:

```yaml
extras:
  routing:
    complexity: deep            # trivial | standard | deep — ordinal hint
    prefer_tier: standard       # soft preference (scorer may override)
    pin_tier: heavy             # hard override (rk will not change it)
    fanout:                     # opt-in custom fanout (review panels, etc.)
      - { id: fast, tier: light }
      - { id: deep, tier: standard }
```

Project policy:

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

Allowed `when` keys: `profile`, `est_tokens`, `allowed_paths_count`,
`depends_on_count`, `ac_count`, `review_required`, `gate`, `lane`,
`extras_complexity`. Operators are key suffixes `_lt`, `_lte`, `_gt`, `_gte`;
a bare key means equality. The first matching rule wins, keys AND together, and
the caps are 16 rules and 8 fanout entries. Every tier named in `then.tier`,
`then.fanout[].tier`, or `extras.routing.*` must appear in `routing.tiers` —
`rk validate --fail-on P0,P1` surfaces mismatches.

`rk route <ID>` is the fast JSON-only surface for dispatch decisions;
`rk context <ID> --with-routing` returns the full context packet with the same
`routing_hint` embedded when the agent also needs implement/review/wave
context.
