# RepoKernel

[![CI](https://github.com/xantorres/repokernel/actions/workflows/ci.yml/badge.svg)](https://github.com/xantorres/repokernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Code style: Biome](https://img.shields.io/badge/code_style-biome-60a5fa)](https://biomejs.dev)

Local-first, Git-native correctness engine for AI coding workflows.

RepoKernel validates repo project state before coding agents execute. It reads repo-local planning files (epics, sprints, reviews, queues, lanes), builds a canonical graph, runs deterministic validators, and exposes machine-stable JSON for agents.

The product is a validator and state resolver — not a UI, not a task tracker, not an AI project manager.

## What it catches

```text
P0 DUPLICATE_SPRINT_ID
sprint id "S-001" appears in 2 files

P1 ACTIVE_SPRINT_MISSING_BASE_SHA
S-002 is active but has no base_sha. Review diff cannot be trusted.

P1 QUEUED_DEPENDENCY_NOT_SHIPPED
S-003 is queued but depends on S-001, which is not shipped.

P1 SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED
S-005 is shipped but its review is changes_requested, not accepted.

P1 REVIEW_BASE_SHA_MISMATCH
sprint S-005 base_sha a1b2c3d does not match review R-005 base_sha deadbee

P1 MULTIPLE_QUEUE_FILES_FOR_LANE
lane "main" is declared by 2 queue files

P2 REGISTRY_DRIFT
Generated registry differs from source project state.
```

## Why not just AGENTS.md?

`AGENTS.md` tells agents how to behave.
RepoKernel tells agents whether the repo state allows them to proceed.

If validation has a P0 or P1 finding, the agent stops.
If validation is clean, `rk next` returns a precise validated next sprint.

## Quick start

**Try it instantly (once published):**

```bash
npx repokernel init --example
rk validate
rk next
rk status
```

**From source (contributors):**

```bash
git clone https://github.com/xantorres/repokernel.git
cd repokernel
pnpm install && pnpm link      # installs rk and repokernel globally

rk init --example --cwd /tmp/demo
rk validate --cwd /tmp/demo
rk next --cwd /tmp/demo
```

## Commands

`rk` and `repokernel` are aliases for the same binary.

```
rk validate                                    Check everything. P0/P1 = stop the agent.
rk next                                        What sprint to work on next.
rk status                                      Project health at a glance.
rk registry --check                            Verify registry hasn't drifted.
rk doctor                                      Diagnose setup problems.
rk init                                        Bootstrap a new project.
rk inspect S-001                               Show sprint details.
rk explain CODE                                Understand any finding code.
rk fix --preview                               See safe auto-fixes.

rk create epic "Core parser"                   Scaffold a new epic.
rk create sprint --epic E-001 "Parse tokens"   Scaffold a sprint under an epic.
rk create queue --lane main                    Scaffold a queue file for a lane.
rk create review --sprint S-001               Scaffold a review for a sprint.
```

`create sprint` options: `--lane <name>` (default: main), `--status planned|pending`, `--after S-NNN` (adds depends_on).

All commands accept `--cwd <path>` (default: current directory).
`validate`, `status`, `next`, `registry` accept `--json` for machine-stable output.

## Concepts

**Epic** — a named collection of sprints representing a feature or initiative.

**Sprint** — a unit of work with a lifecycle: `planned → queued → active → shipped`. Each sprint lives in a Markdown file with YAML frontmatter.

**Review** — an artifact that records the verdict (`accepted | changes_requested | rejected`) and the git SHAs (`base_sha`, `end_sha`) for a sprint's diff.

**Queue** — an ordered list of sprints waiting to run in a lane. One YAML file per lane.

**Lane** — a named execution track (e.g., `main`, `release`). Sprints in different lanes run independently.

**Registry** — a generated snapshot of all project state, written to `.repokernel/registry.json`. Run `rk registry --check` to verify it hasn't drifted.

## State machine

```
planned → queued → active → review → shipped
                                   ↘ reopened → active
                         → cancelled
```

A sprint can only advance when its `depends_on` sprints are all `shipped` and the lane queue orders it next.

## For AI agents

```bash
rk validate --json          # get all findings; P0/P1 = halt
rk next --json              # get the next runnable sprint
rk registry --check         # verify no state drift after changes
cat .repokernel/registry.json  # full project snapshot
```

Exit codes: `0` clean · `1` findings at/above threshold · `2` config/runtime error

## Exit codes

- `0` — clean
- `1` — validation findings at or above threshold (or registry drift)
- `2` — config / runtime / tool error

## Layout

- [`packages/core`](packages/core) — schemas, parser, graph, validator, resolver, registry
- [`packages/cli`](packages/cli) — `rk` / `repokernel` CLI (human text + stable JSON over core)
- [`examples/basic`](examples/basic) — end-to-end smoke project (used in CI)
- [`docs/`](docs) — product thesis + specs

## Design principles

1. Schema first. Markdown is for humans; frontmatter is the contract.
2. Deterministic state machine. No lifecycle inference from prose.
3. Git native. Diff correctness is `base_sha..HEAD`, never dates.
4. Local first. No hosted service, no DB.
5. Fail loudly. Malformed state must produce findings.
6. No project-specific code. Policies live in config.
7. No `git add .`, ever.

See [`docs/product/thesis.md`](docs/product/thesis.md) for the full thesis.

## Status

v0 in development. Canonical-only model: 8 sprint statuses, 4 review verdicts, structured queue files, optional lane files (inferred when absent), 30+ validator codes across P0–P3, content-only registry drift detection, setup diagnostics, example initialization, entity inspection, validation-code explanations, and fix previews.

Lifecycle commands (`start`, `review`, `close`, `reopen`), GitHub/PR integration, agent adapters, and UI are explicit non-goals for v0.

## License

MIT — see [LICENSE](LICENSE).
