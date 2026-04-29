# RepoKernel Plugin

Agent-operated workflow for RepoKernel. Six verbs drive the `rk` CLI as the source of truth for sprint, queue, review, run, registry, lane, and worktree state.

## What's inside

```
plugins/repokernel/
  .claude-plugin/plugin.json          # plugin manifest
  skills/repokernel/                  # router skill (always loaded)
    SKILL.md                          # doctrine + DISPATCH (≤100 lines)
    reference/quick-reference.md      # command surface, tier maps, anti-patterns
  commands/                           # six slash commands
    rk-status.md                      # /rk-status — read-only dashboard
    rk-next.md                        # /rk-next — resolve next sprint with tier hint
    rk-run.md                         # /rk-run — execute sprint/epic/fastpath
    rk-review.md                      # /rk-review — parallel review panel
    rk-doctor.md                      # /rk-doctor — drift triage (read-only plan)
    rk-plan.md                        # /rk-plan — scaffold an epic from intent
  agents/
    rk-reviewer.md                    # single-role panelist (parallel dispatch)
    rk-doctor.md                      # read-only drift triage agent
```

## The six verbs

| User intent | Slash | Behavior |
|---|---|---|
| "where are we" | `/rk-status` | Cold dashboard. Read-only. |
| "what's next" | `/rk-next` | Resolves next runnable sprint, surfaces tier + cost band, pauses for confirmation. |
| "ship it" | `/rk-run` | Runs sprint/epic/fastpath. Pauses on `awaiting_reviews` and on completion — never auto-pivots, never auto-closes. |
| "review" | `/rk-review` | Spawns N `rk-reviewer` agents in parallel (single message, multiple Task calls). Merges via `rk review-panel findings`. User picks verdict. |
| "doctor" | `/rk-doctor` | `rk-doctor` agent surfaces a fix plan. Never auto-applies. |
| "plan an epic" | `/rk-plan` | Discovery → 3-6 sprints (hard cap) → `rk create` → `rk validate`. Never auto-executes. |

## Design principles

- **`rk` is the state machine.** The plugin orchestrates `rk` calls; it never duplicates state in markdown.
- **Agent-agnostic.** Skill content uses generic tier names (`light` / `standard` / `heavy`) and provides examples for multiple harnesses. Tier→model mapping lives in `quick-reference.md` and is harness-specific.
- **No surprises.** No auto-mutation. Every state change pauses for explicit user approval. `/rk-doctor` never auto-applies fixes; `/rk-run` never auto-closes; `/rk-review` never auto-records verdicts.
- **Progressive disclosure.** Router skill is ≤100 lines. Reference loads on demand. No 251-line monolith.
- **Cost-aware by default.** Every execution path consults `rk route` and surfaces the recommended tier before dispatch.

## Installation

This plugin ships as part of the RepoKernel npm package. From a global install of `repokernel`:

```bash
npm i -g repokernel
rk install-skill                       # idempotent copy + safe settings merge
rk install-skill --dry-run             # preview changes
rk install-skill --target ~/.claude    # custom target (default: ~/.claude)
rk install-skill --force               # overwrite existing
rk install-skill --print-path          # show resolved target
```

For local development (no install), point the harness at this directory directly. For Claude Code:

```bash
claude --plugin-dir /path/to/repokernel/plugins/repokernel
```

The plugin format is Claude Code's, but skill bodies, agent definitions, and slash command logic are written as portable markdown — agent harnesses that adopt the same convention can load this plugin without modification.

## What's not here (Phase 1.x and beyond)

- **Hooks** (Phase 1.2) — PreToolUse state protection, SessionStart dashboard, PostToolUse `rk close` suggestion.
- **Sub-skills** (Phase 1.3) — `repokernel-planner` / `repokernel-runner` / `repokernel-reviewer` split when the router grows past ~180 lines.
- **MCP server** (Phase 2) — only if non-Claude harnesses ask for `rk` as native tools.

See [/Users/xtorres/.claude/plans/lay-down-a-plan-sequential-tulip.md](../../../../.claude/plans/lay-down-a-plan-sequential-tulip.md) for the full phasing.

## Verification

After install, the six commands should be discoverable:

```bash
# In a Claude Code session inside an RK-governed repo:
/rk-status
/rk-next
/rk-doctor
```

Each should run without error against a healthy repo. `/rk-doctor` produces a fix plan and waits for your approval. `/rk-run` and `/rk-review` need an active sprint to do meaningful work.

## License

MIT. Same as the parent RepoKernel project.
