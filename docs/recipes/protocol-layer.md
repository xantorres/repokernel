# Recipe: Building a project-owned protocol layer over RepoKernel

A pattern for wiring Claude Code (or any slash-command-driven coding agent) on top of `rk` so your agents can run multi-step orchestration — multi-reviewer panels, chained-epic execution, founder-pause briefs — without polluting the project-agnostic `repokernel-operator` skill.

This recipe is a reference, not a template. Copy the shapes; replace the policy with your own.

## The gap RepoKernel intentionally leaves

`rk` is the state machine. It owns sprint, epic, queue, review, run, registry, lane, and worktree state, and exposes the `repokernel-operator` skill so agents can drive that state without inferring lifecycle from prose.

What `rk` does **not** ship, by design:

- Multi-agent review panel choreography (haiku triage → N parallel reviewers → aggregate → auto-fix loop)
- Chained-epic sub-agent spawn loops with halt conditions
- Interactive founder-prompting for plan field values
- Pause-gate brief templates ("here's why we stopped, here's what to look at")
- Verdict-threshold business rules (e.g. "auto-fix on YELLOW, halt on RED, escalate on CRITICAL")

These are project-side concerns. The operator skill stays generic so any rk-governed repo can use the same skill. Your repo owns the orchestration.

This recipe describes the canonical place to put that orchestration.

## The two-layer pattern

```
.claude/commands/X.md         entry point + model tier routing
       │
       ▼  (single line: "Read .agents/protocol/X.md. Execute.")
.agents/protocol/X.md         orchestration prose: pre-checks, loop, halt conditions, next steps
       │
       ▼  (rk commands + sub-agent spawns)
rk + sub-agents               the actual work
```

Why two layers and not one:

- **`.claude/commands/*.md`** is the named entry point Claude Code surfaces as a slash-command (`/close-sprint`). Its frontmatter carries the **model tier** routing (`model: haiku` for fast/triage, `model: sonnet` for orchestration, `model: opus` for synthesis). The body is intentionally one line — the command exists for the slash-name and the model field.
- **`.agents/protocol/*.md`** is the orchestration prose Claude reads after the command fires. This is where the multi-step logic, halt conditions, and rk command sequences live. Project-specific. Git-tracked. Versioned alongside your code.

Splitting these two roles is what lets you change orchestration without rewiring slash-commands, and change model routing without touching protocol prose.

## Quick scaffold

To skip the boilerplate, generate the command + protocol pair from `rk`:

```bash
rk scaffold command close-sprint \
  --description "Close a sprint and run the review pipeline" \
  --arg-hint "<SPRINT_ID>" \
  --tier orchestrate \
  --with-protocol
```

This writes `.claude/commands/close-sprint.md` (frontmatter + canonical 1-line body pointing at the protocol) and `.agents/protocol/close-sprint.md` (TODO-marked skeleton matching the canonical sections below). The scaffold is intentionally vendor-agnostic — it records your tier as a comment, not a `model:` field. Add `model:` per your harness's tier-to-model mapping after the file is created.

## Anatomy of a command file

```markdown
---
description: Close a sprint and run the review pipeline
arg-hint: "<SPRINT_ID>"
model: sonnet
---
Read `.agents/protocol/close-sprint.md`. Set SPRINT_ID=$1. Execute.
```

That's the whole file. Three frontmatter keys, one body line.

| Key | Purpose |
|---|---|
| `description` | Surfaces in Claude Code's slash-command palette. |
| `arg-hint` | Tells Claude how to prompt for arguments. |
| `model` | The cost tier this entry point runs at. Match the tier to the work — `haiku` for read-only triage, `sonnet` for orchestration, `opus` for cross-cutting synthesis. |

The body's one job is to point at the protocol file and pass arguments. Resist the urge to put logic here — every line you add is duplicated effort the moment you spawn a sub-agent or chain commands.

## Anatomy of a protocol file

A protocol file is the orchestration script. Five canonical sections:

```markdown
# close-sprint protocol

## Inputs
- SPRINT_ID (required)

## Pre-checks
- `rk validate --fail-on P0,P1` — abort if non-zero
- `rk inspect $SPRINT_ID` — confirm sprint is in `active` status with a `review_id`

## Loop / orchestration
1. Run the review pipeline:
   `rk review-sprint $SPRINT_ID --json`
2. Read `panel_aggregate` from the result. If absent, the sprint has no panel rule — skip to step 4.
3. If `panel_aggregate` is RED:
   - Spawn the auto-fix sub-agent (model: sonnet) with the findings
   - On return, re-run review (max 2 retries)
   - If still RED after retries: HALT, render brief
4. If `panel_aggregate` is YELLOW and the project policy says yellow blocks close: HALT, render brief
5. `rk review-evidence $SPRINT_ID --label review-loop --command "rk review-sprint $SPRINT_ID --json" --exit-code 0`
6. `rk review-verdict <REVIEW_ID> accepted`
7. `rk ship $SPRINT_ID`

## Halt conditions (pause-gate)
Render a founder-action brief and stop:
- `rk brief $SPRINT_ID --gate=review-fail` (YELLOW or RED after retries)
- `rk brief $SPRINT_ID --gate=blocked` (pre-check returned blocking deps)

## Next steps
On success: surface `rk next` to chain into the next sprint.
On halt: surface the brief markdown with no further commands.
```

Notes on the shape:
- **Pre-checks** before any mutation. Cheaper to abort early than mid-pipeline.
- **Loop** is sequential and explicit. No recursion in protocol prose — if you need recursion (chained-epic), spawn a sub-agent that re-invokes the slash-command.
- **Halt conditions** are explicit and named. Each halt produces a brief. The brief is the handoff artifact.
- **Next steps** are surfaced, not auto-executed. Let the human or operator decide whether to chain.

## Worked example: panel-review aggregation

A common pattern is "compute the aggregate of N reviewer verdicts, then route". `rk` ships the helper as of v1.9.2:

```bash
# After your panel produces N reviewer verdicts, aggregate them:
rk review-aggregate $SPRINT_ID --json
# → {
#     "aggregate": "RED",
#     "source": "sprint",
#     "sprint_id": "S-001",
#     "review_id": "R-001",
#     "round": 2,
#     "reviewers": [
#       { "reviewer_id": "security", "verdict": "RED" },
#       { "reviewer_id": "correctness", "verdict": "YELLOW" },
#       { "reviewer_id": "style", "verdict": "GREEN" }
#     ]
#   }

# Or for ad-hoc aggregation outside a sprint context:
rk review-aggregate --verdicts GREEN,YELLOW,RED
# → RED

# For shell pipelines, use --fail-on to map verdict to exit code:
rk review-aggregate $SPRINT_ID --fail-on RED
# → exit 1 if aggregate is RED, exit 0 otherwise
```

Use this in your protocol prose instead of writing a verdict-aggregation rule from scratch. The function is RED-dominant ("RED if any reviewer RED; else YELLOW if any YELLOW; else GREEN") — a deliberately strict rule that you can override at the protocol level if your project policy differs.

## Worked example: pause-gate briefs

When your protocol halts, the agent needs to hand off to a human (or another agent) with enough context to act. `rk brief` produces a templated markdown brief from the current state:

```bash
# Sprint mode auto-detects the right gate:
rk brief S-001
# → "Review failed" if verdict is changes_requested
# → "Ready to close" if verdict is accepted
# → "Awaiting review verdict" if verdict is pending
# → "Blocked" if depends_on includes unshipped sprints
# → "Status" otherwise

# Force a specific template:
rk brief S-001 --gate=review-fail

# Epic mode renders the sprint table + next runnable:
rk brief E-001

# JSON envelope for programmatic use (includes the markdown):
rk brief S-001 --json
```

The brief includes the latest panel run breakdown, findings, and a fenced "Suggested next action" with the exact `rk` command to unstick the gate. Drop it into a Slack message, a GitHub PR comment, or stdout — it's just markdown.

This is the pause-gate handoff pattern. Your protocol stops when something needs a human; `rk brief` is the handoff artifact.

## Wiring chained-epic execution

`rk run <EPIC_ID>` reads the epic's `execution_strategy` and runs sequential or parallel waves. It does **not** spawn sub-agents per sprint — it executes the queue.

If your project needs each sprint to run in its own Claude sub-agent (for context isolation, cost capping, or independent failure modes), the orchestration lives in your protocol:

```markdown
# run-epic protocol

## Inputs
- EPIC_ID (required)

## Loop
1. `rk chain preview --epic $EPIC_ID --json` — get eligible sprint waves
2. For each wave:
   a. For each sprint in the wave (parallel within the wave):
      - Spawn a sub-agent invoking `/run-sprint $SPRINT_ID`
   b. Wait for all sub-agents in the wave to complete
   c. `rk validate --fail-on P0,P1` — abort the epic if validation broke
3. If all waves completed: `rk epic ship $EPIC_ID`

## Halt conditions
- Any sub-agent returned with `pause` gate → render brief, stop
- `rk validate` produced P0 → render brief, stop
- Wave timeout exceeded → render brief, stop
```

Key shapes worth copying:
- **Topology comes from `rk`** (`rk chain preview`), not from prose. Never manually list "sprint S-001 then S-002 then S-003" in protocol — the epic file owns that.
- **Sub-agent spawn is in the protocol**, not in `rk`. `rk` runs queues; you decide whether each queue item gets its own agent process.
- **Halt conditions are checked between waves**, not just at the end. A failing wave should not silently consume the budget for the next one.

## Anti-patterns

- **Fattening command bodies.** If `.claude/commands/X.md` grows past one line of body, the logic belongs in the protocol file. The command's value is its `model:` tier, not its prose.
- **Inferring rk state from grep.** Even inside a protocol, never substitute `grep` over sprint files for `rk inspect`. Protocols call `rk`. Period.
- **Hardcoding sprint chains.** Topology lives in epic frontmatter, not protocol prose. If a wave changes, edit the epic, not the protocol.
- **Re-implementing aggregateVerdict.** Use `rk review-aggregate`. The RED-dominant rule is the single source of truth.
- **Skipping pause-gate briefs.** A halt without a brief is an unfinished handoff. Always render the brief when stopping.
- **Putting orchestration in the rk skill.** The operator skill is project-agnostic. Project-specific multi-agent choreography lives in your `.agents/protocol/` files. If you find yourself wanting to add a "review panel" section to the operator skill, write a protocol file instead.

## How this fits with the operator skill

| Concern | Lives in | Owned by |
|---|---|---|
| State machine ops (start, review, close, validate) | `repokernel-operator` skill | RepoKernel project |
| Path discipline, anti-patterns, stop rules | `repokernel-operator` skill | RepoKernel project |
| Tier → model mapping | `repokernel-operator` skill (consumer copy) | Consumer project |
| Multi-agent panel choreography | `.agents/protocol/review-sprint.md` | Consumer project |
| Pause-gate brief text and routing | `.agents/protocol/run-epic.md` | Consumer project |
| Slash-command surface + model tier | `.claude/commands/*.md` | Consumer project |

The split is deliberate. The operator skill teaches every agent how to **drive** rk safely. Your protocol layer teaches your specific agents what **work to do** between rk calls. Don't merge them.

## See also

- [`docs/internals/cli-reference.md`](../internals/cli-reference.md) — every `rk` verb and flag
- [`examples/skills/repokernel-operator/SKILL.md`](../../examples/skills/repokernel-operator/SKILL.md) — the project-agnostic operator skill (your starting point for the agent's rk knowledge)
- [`docs/internals/parallel-waves.md`](../internals/parallel-waves.md) — how `rk` resolves parallel sprint waves (relevant for chained-epic protocols)
