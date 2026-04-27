# RepoKernel

[![CI](https://github.com/xantorres/repokernel/actions/workflows/ci.yml/badge.svg)](https://github.com/xantorres/repokernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Code style: Biome](https://img.shields.io/badge/code_style-biome-60a5fa)](https://biomejs.dev)

RepoKernel is a local-first Git-native control plane for autonomous coding agents.

It validates repo state, resolves the next runnable sprint, manages isolated git worktrees per epic, and orchestrates agents through a full run loop — sprint by sprint, review by review. Sequential or parallel. Any agent.

```bash
rk run E-001
```

## Quick start

```bash
git clone https://github.com/xantorres/repokernel.git
cd repokernel
pnpm install && pnpm build && pnpm link

rk init --example --cwd /tmp/demo
rk validate --cwd /tmp/demo
rk next --cwd /tmp/demo
rk run E-001 --agent fake --limit 1 --cwd /tmp/demo
```

See [docs/quickstart.md](docs/quickstart.md) for full setup.

## How it works

One command drives the entire loop:

```
rk run E-001 --agent fake
```

For each sprint:
1. Resolve next runnable sprint from the queue
2. Acquire an isolated git worktree for the epic
3. Generate a context packet for the agent
4. Start the sprint (`base_sha` recorded)
5. Invoke the agent — fake, claude, codex, or your own script
6. Validate agent output (path safety, project validators)
7. Create a review artifact
8. Pause for review (assisted mode) or auto-close (autonomous)
9. Ship the sprint, refresh the registry
10. Repeat until limit, epic complete, or blocked

**Execution strategy comes from the epic, not the command line.** Set it once in the epic file:

```yaml
# epics/E-001.md
execution_strategy: parallel
parallel_limit: 2
```

Parallel epics run dependency waves concurrently in per-sprint worktrees:

```
Wave 1: S-001 + S-002  (no dependencies — run in parallel)
Wave 2: S-003          (depends on S-001 + S-002)
```

`rk run E-001 --agent fake` reads `execution_strategy` and runs parallel waves automatically. No extra flags needed.

## Agents

| Agent | Config | Description |
|---|---|---|
| `fake` | — | Deterministic test agent. Writes a file, commits, returns result. |
| `claude` | preset | Invokes `claude --print -p <packet>` |
| `codex` | preset | Invokes `codex --approval-mode full-auto -q <packet>` |
| `<name>` | — | Any shell script, configured in `repokernel.config.yaml` |

External agent config:
```yaml
agents:
  my-agent:
    command: ./scripts/run-agent.sh
    args: ["{packet_path}", "{worktree}", "{sprint_id}"]
    resultFormat: sentinel-json
    timeoutSeconds: 1800
```

```bash
rk run E-001 --agent my-agent
```

## Commands

**Run orchestrator**

```
rk run E-001 --agent fake                  Run using epic execution_strategy (sequential or parallel)
rk run E-001 --agent fake --limit 1        Stop after 1 sprint
rk run E-001 --agent fake --sequential     Downgrade parallel epic to sequential for this run
rk run E-001 --agent fake --parallel       Assert epic is parallel (error if sequential)
rk run --resume RUN-001                    Resume a paused run
rk run E-001 --dry-run                     Preview — no changes
rk run inspect RUN-001                     Show run state + next steps
rk run logs RUN-001 [sprint-id]            Show agent logs
rk run abort RUN-001                       Abort a paused run
rk runs                                    List all run records
```

**Validation**

```
rk validate                                Check everything. P0/P1 = stop.
rk next                                    Next runnable sprint
rk status                                  Project health at a glance
rk registry --check                        Verify registry hasn't drifted
rk doctor                                  Diagnose setup problems
rk inspect S-001                           Sprint details
rk explain CODE                            Understand any finding code
```

**Lifecycle**

```
rk start S-001                             Sprint → active
rk review S-001                            Create review stub, sprint → review
rk review-verdict R-001 accepted           Set review verdict
rk close S-001                             Sprint → shipped
rk reopen S-001                            Reopen a shipped sprint
```

**Lane management**

```
rk lane ls / rk lanes                      List lanes with health + queue depth
rk lane acquire E-001                      Create worktree + claim lane
rk lane release E-001                      Release worktree + lane
```

**Create**

```
rk create epic "title"
rk create sprint --epic E-001 "title"
rk create queue --lane main
rk create review --sprint S-001
```

All commands accept `--cwd <path>`. Most accept `--json` for machine-readable output.

**Exit codes:** `0` clean · `1` findings/blocked · `2` config/runtime error

## Concepts

**Epic** — a collection of sprints representing a feature. Sequential or parallel execution strategy.

**Sprint** — unit of work. Lifecycle: `planned → queued → active → review → shipped`. Stored as Markdown with YAML frontmatter.

**Queue** — ordered sprint list for a lane. One file per lane.

**Lane** — named execution track (`main`, `release`, etc.). Sprints in different lanes are independent.

**Review** — artifact recording verdict (`accepted | changes_requested | rejected`) and git SHAs.

**Worktree** — isolated git worktree per epic (and per sprint in parallel mode).

**Registry** — generated snapshot at `.repokernel/registry.json`. Run `rk registry --check` after changes.

**Run** — a persisted execution record at `.git/repokernel/runs/RUN-NNN.json`. Survives process restarts.

## What it validates

```
P0 DUPLICATE_SPRINT_ID           sprint id "S-001" appears in 2 files
P1 ACTIVE_SPRINT_MISSING_BASE_SHA  S-002 is active but has no base_sha
P1 QUEUED_DEPENDENCY_NOT_SHIPPED   S-003 depends on S-001, which is not shipped
P1 SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED  S-005 is shipped but review is changes_requested
P1 REVIEW_BASE_SHA_MISMATCH       sprint S-005 base_sha does not match review R-005
P1 MULTIPLE_QUEUE_FILES_FOR_LANE  lane "main" is declared by 2 queue files
P2 REGISTRY_DRIFT                 Generated registry differs from source state
```

30+ validator codes across P0–P3. See [docs/specs/validation.md](docs/specs/validation.md).

## Examples

| Example | Description |
|---|---|
| [`examples/basic`](examples/basic) | Smoke test project used in CI |
| [`examples/sequential-run`](examples/sequential-run) | Two-sprint sequential epic |
| [`examples/parallel-epic`](examples/parallel-epic) | Four-sprint two-wave parallel epic |
| [`examples/external-agent`](examples/external-agent) | Shell script agent via config |
| [`examples/skills/repokernel-operator`](examples/skills/repokernel-operator) | Agent-facing skill: how to drive RepoKernel without breaking it |

## Documentation

| Guide | Topic |
|---|---|
| [quickstart.md](docs/quickstart.md) | Install and first run |
| [concepts.md](docs/concepts.md) | Epics, sprints, lanes, reviews, worktrees |
| [run-loop.md](docs/run-loop.md) | How the run loop works |
| [sequential-runs.md](docs/sequential-runs.md) | Sequential execution |
| [parallel-waves.md](docs/parallel-waves.md) | Parallel wave execution |
| [agent-adapters.md](docs/agent-adapters.md) | Connecting agents |
| [review-gates.md](docs/review-gates.md) | Review workflow |
| [path-safety.md](docs/path-safety.md) | Path conflict detection |
| [resume-recovery.md](docs/resume-recovery.md) | Recovering from paused/failed runs |
| [cli-reference.md](docs/cli-reference.md) | Full command reference |
| [config-reference.md](docs/config-reference.md) | Full config reference |

Internal specs: [docs/specs/](docs/specs/)

## Layout

```
packages/core/   schemas, parser, graph, validator, resolver, registry
packages/cli/    rk / repokernel CLI
examples/        runnable example projects
docs/            user guides
docs/specs/      internal specifications
docs/product/    product thesis
```

## Design principles

1. Schema first. Frontmatter is the contract; prose is for humans.
2. Deterministic state machine. No lifecycle inference from prose.
3. Git native. Diff correctness is `base_sha..HEAD`, never dates.
4. Local first. No hosted service, no DB, no daemon.
5. Fail loudly. Malformed state produces findings; it never silently passes.
6. No project-specific code. All policy lives in config.
7. Any agent. Shell scripts, Claude, Codex, or manual.

## License

MIT — see [LICENSE](LICENSE).
