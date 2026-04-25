# RepoKernel

Local-first, Git-native correctness engine for AI coding workflows.

RepoKernel validates repo project state before coding agents execute. It reads repo-local planning files (epics, sprints, reviews, queues), builds a canonical graph, runs deterministic validators, and exposes machine-stable JSON for agents.

The product is a validator and state resolver — not a UI, not a task tracker, not an AI project manager.

## Status

v0 in development. See [the bootstrap plan](./docs/product/thesis.md) for scope.

## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Run the CLI against a project:

```bash
node packages/cli/dist/index.js validate --cwd <repo-root>
node packages/cli/dist/index.js status --cwd <repo-root>
node packages/cli/dist/index.js next --cwd <repo-root>
node packages/cli/dist/index.js registry --check --cwd <repo-root>
```

## Layout

- `packages/core` — schemas, parser, graph, validator, resolver, registry
- `packages/cli` — `repokernel` CLI (thin wrapper around core)
- `examples/basic` — end-to-end smoke project
- `docs/` — product thesis + specs

## Exit codes

- `0` — clean
- `1` — validation findings at or above the configured fail threshold
- `2` — config / runtime / tool error
