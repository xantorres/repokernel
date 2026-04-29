# RepoKernel Plugin

Agent-operated workflow for RepoKernel. Six verbs drive the `rk` CLI as the source of truth for sprint, queue, review, run, registry, lane, and worktree state.

## What's inside

```
packages/cli/plugin/
  .claude-plugin/plugin.json          # plugin manifest
  skills/repokernel/                  # router skill (always loaded)
    SKILL.md                          # doctrine + DISPATCH (≤100 lines)
    reference/quick-reference.md      # command surface, tier maps, anti-patterns
  commands/                           # six slash commands
    rk-status.md                      # /repokernel:rk-status — read-only dashboard
    rk-next.md                        # /repokernel:rk-next — resolve next sprint with tier hint
    rk-run.md                         # /repokernel:rk-run — execute sprint/epic/fastpath
    rk-review.md                      # /repokernel:rk-review — parallel review panel
    rk-doctor.md                      # /repokernel:rk-doctor — drift triage (read-only plan)
    rk-plan.md                        # /repokernel:rk-plan — scaffold an epic from intent
  agents/
    rk-reviewer.md                    # single-role panelist (parallel dispatch)
    rk-doctor.md                      # read-only drift triage agent
  hooks/
    hooks.json                        # PreToolUse, SessionStart, PostToolUse wiring
    pre-tool-use.sh                   # block direct edits to .repokernel/** state files
    session-start.sh                  # inject one-line dashboard via rk status --brief
    post-tool-use.sh                  # suggest `rk next` after `rk close` succeeds
```

## The six verbs

| User intent | Slash | Behavior |
|---|---|---|
| "where are we" | `/repokernel:rk-status` | Cold dashboard. Read-only. |
| "what's next" | `/repokernel:rk-next` | Resolves next runnable sprint, surfaces tier + cost band, pauses for confirmation. |
| "ship it" | `/repokernel:rk-run` | Runs sprint/epic/fastpath. Pauses on `awaiting_reviews` and on completion — never auto-pivots, never auto-closes. |
| "review" | `/repokernel:rk-review` | Uses configured `rk review-panel` after approval, or spawns N `rk-reviewer` agents in parallel and records the user-approved verdict. |
| "doctor" | `/repokernel:rk-doctor` | `rk-doctor` agent surfaces a fix plan. Never auto-applies. |
| "plan an epic" | `/repokernel:rk-plan` | Discovery → 3-6 sprints (hard cap) → `rk create` → `rk validate`. Never auto-executes. |

## Design principles

- **`rk` is the state machine.** The plugin orchestrates `rk` calls; it never duplicates state in markdown.
- **Agent-agnostic.** Skill content uses generic tier names (`light` / `standard` / `heavy`) and provides examples for multiple harnesses. Tier→model mapping lives in `quick-reference.md` and is harness-specific.
- **No surprises.** No auto-mutation. Every state change pauses for explicit user approval. `/repokernel:rk-doctor` never auto-applies fixes; `/repokernel:rk-run` never auto-closes; `/repokernel:rk-review` asks before configured panels that record verdicts.
- **Progressive disclosure.** Router skill is ≤100 lines. Reference loads on demand. No 251-line monolith.
- **Cost-aware by default.** Every execution path consults `rk route` and surfaces the recommended tier before dispatch.

## Installation

This plugin ships as part of the RepoKernel npm package. From a global install of `repokernel`:

```bash
npm i -g repokernel
rk install-skill                       # register bundled local marketplace + plugin cache
rk install-skill --dry-run             # preview changes
rk install-skill --target ~/.claude    # custom target (default: ~/.claude)
rk install-skill --force               # atomically replace a divergent install
rk install-skill --print-path          # show resolved cache destination
```

For local development (no install), point the harness at this directory directly. For Claude Code:

```bash
claude --plugin-dir /path/to/repokernel/packages/cli/plugin
```

The plugin format is Claude Code's, but skill bodies, agent definitions, and slash command logic are written as portable markdown — agent harnesses that adopt the same convention can load this plugin without modification.

## Hooks

Three hooks ship with the plugin and execute via the Claude Code plugin runtime:

| Event        | Matcher              | What it does |
|--------------|----------------------|--------------|
| PreToolUse   | `Edit\|Write\|NotebookEdit` | Blocks direct writes to `.repokernel/registry.json`, run logs, generated files, and sprint/epic/queue/review/lane frontmatter. Routes the user to the matching `rk` command. |
| SessionStart | `*`                  | When `repokernel.config.yaml` is reachable from `cwd`, runs `rk status --brief --json` (sub-200ms) and injects a one-line dashboard: active epic, next sprint, lane status. Silent on non-RK repos. |
| PostToolUse  | `Bash`               | After `rk close <ID>` or `rk epic close <ID>` succeeds, runs `rk next --json` and surfaces what's now unblocked, with a pointer to `/repokernel:rk-next`. |

All three exit silently on missing dependencies (`jq`, `rk` not on PATH) — hooks must never make the harness look broken. Source: `hooks/*.sh` + `hooks/hooks.json`.

## What's not here (Phase 1.x and beyond)

- **Sub-skills** (Phase 1.3) — `repokernel-planner` / `repokernel-runner` / `repokernel-reviewer` split when the router grows past ~180 lines.
- **MCP server** (Phase 2) — only if non-Claude harnesses ask for `rk` as native tools.

See the tracked roadmap and release notes in this repository for future plugin phases.

## Verification

After install, the six commands should be discoverable:

```bash
# In a Claude Code session inside an RK-governed repo:
/repokernel:rk-status
/repokernel:rk-next
/repokernel:rk-doctor
```

Each should run without error against a healthy repo. `/repokernel:rk-doctor` produces a fix plan and waits for your approval. `/repokernel:rk-run` and `/repokernel:rk-review` need an active sprint to do meaningful work.

## License

MIT. Same as the parent RepoKernel project.
