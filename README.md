# RepoKernel

[![CI](https://github.com/xantorres/repokernel/actions/workflows/ci.yml/badge.svg)](https://github.com/xantorres/repokernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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
If validation is clean, `repokernel next` returns a precise validated next sprint.

## Quick start

```bash
git clone https://github.com/xantorres/repokernel.git
cd repokernel
pnpm install
pnpm typecheck
pnpm -r build
pnpm -r test
```

Run the CLI against the example project:

```bash
node packages/cli/dist/index.js validate --cwd examples/basic
node packages/cli/dist/index.js next     --cwd examples/basic
node packages/cli/dist/index.js status   --cwd examples/basic
node packages/cli/dist/index.js registry --check --cwd examples/basic
```

Use it in your own repo by adding a `repokernel.config.yaml` at the root and laying out epics/sprints/reviews/queues/lanes under the configured paths. See [`docs/specs/config.md`](docs/specs/config.md) and [`examples/basic`](examples/basic).

## Layout

- [`packages/core`](packages/core) — schemas, parser, graph, validator, resolver, registry
- [`packages/cli`](packages/cli) — `repokernel` CLI (thin wrapper over core)
- [`examples/basic`](examples/basic) — end-to-end smoke project
- [`docs/`](docs) — product thesis + specs

## Exit codes

- `0` — clean
- `1` — validation findings at or above threshold (or registry drift)
- `2` — config / runtime / tool error

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

v0 in development. Canonical-only model: 8 sprint statuses, 4 review verdicts, structured queue files, optional lane files (inferred when absent), 30+ validator codes across P0–P3, content-only registry drift detection.

Lifecycle commands (`start`, `review`, `close`, `reopen`), GitHub/PR integration, agent adapters, and UI are explicit non-goals for v0.

## License

MIT — see [LICENSE](LICENSE).
