# RepoKernel

[![npm](https://img.shields.io/npm/v/repokernel.svg)](https://www.npmjs.com/package/repokernel)
[![CI](https://github.com/xantorres/repokernel/actions/workflows/ci.yml/badge.svg)](https://github.com/xantorres/repokernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Run each AI coding task in its own Git worktree, with checks before merge.**

RepoKernel keeps agent work isolated, reviewable, and tied to Git.

<!-- TODO: replace with 60s asciinema demo of the three-command flow below -->

## Install

```bash
npm i -g repokernel
```

Requires Node 20+ and a Git repository. Built-in agent adapters cover [Claude Code](https://docs.anthropic.com/claude-code), [OpenAI Codex](https://openai.com/codex), a deterministic test agent, and any custom shell command.

## Use

```bash
cd your-git-repo
rk init

rk run -m "Add a /health endpoint that returns 200 OK" --agent claude

# RepoKernel synthesizes a task, opens an isolated worktree, runs the agent,
# runs your checks, and pauses with a reviewable diff.

rk close T-001    # merge worktree into main, mark task shipped
# or
rk discard T-001  # release worktree, drop changes
```

That is the whole loop.

## Why

- **Isolated.** Every task runs in its own Git worktree. Your main branch stays clean until you merge.
- **Checked.** Lint, type, and test commands run before close. Failed checks block the merge.
- **Auditable.** Every step is committed: synthesis, agent commits, review verdict, merge. Replay or revert anytime.
- **Vendor-neutral.** One contract, any agent. Switch from Claude Code to Codex without changing the workflow.

## Other input modes

```bash
rk run                    # opens $EDITOR with a structured task template
rk run path/to/task.md    # task in a file
echo "..." | rk run --stdin --agent claude
```

## Configuring checks

`rk init` creates `repokernel.config.yaml`. Add the commands the agent's work has to pass before merge:

```yaml
automation:
  checksCmd: pnpm lint && pnpm typecheck && pnpm test
```

Failed checks leave the task in `active` state. Retry with `rk run T-001` or drop it with `rk discard T-001`.

## Agents

| Adapter | Description |
|---|---|
| `claude` | [Claude Code](https://docs.anthropic.com/claude-code) CLI |
| `codex` | [OpenAI Codex](https://openai.com/codex) CLI |
| `fake` | Deterministic test agent — no LLM, useful for demos and CI |
| `manual` | Pauses so you do the work yourself |
| custom | Any shell command, configured in `repokernel.config.yaml` |

## Examples

- [`examples/fastpath`](examples/fastpath) — minimal runnable fastpath project
- [`examples/basic`](examples/basic) — single-epic starter project
- [`examples/external-agent`](examples/external-agent) — wiring a custom agent adapter
- [`examples/parallel`](examples/parallel) — multi-task orchestration

## Documentation

- [Fastpath in depth](docs/fastpath.md) — what the three-command flow does behind the scenes

## Advanced

The fastpath above wraps a deeper machinery for multi-task plans, parallel waves, lane queues, and review panels. Use it when you outgrow one-task-at-a-time.

- [Detailed README](docs/internals/README-detailed.md) — the full feature surface
- [Concepts](docs/internals/concepts.md) — model reference
- [CLI reference](docs/internals/cli-reference.md) — every command
- [Internals](docs/internals/) — schemas, parallel waves, agent adapters, recovery

## Status

Local-first. No daemon, no database, no hosted service. Schema and CLI are still evolving — pin a version (see [CHANGELOG.md](CHANGELOG.md)) if you embed RepoKernel in CI.

## License

MIT — see [LICENSE](LICENSE).
