<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./docs/assets/logo-light.png">
    <img src="./docs/assets/logo-light.png" alt="RepoKernel" width="100%">
  </picture>
</p>

[![npm](https://img.shields.io/npm/v/repokernel.svg)](https://www.npmjs.com/package/repokernel)
[![CI](https://github.com/xantorres/repokernel/actions/workflows/ci.yml/badge.svg)](https://github.com/xantorres/repokernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Run each AI coding task in its own Git worktree, with checks before merge.**

Each task gets its own branch, audit trail, and review gate.

## Install

```bash
npm i -g repokernel
```

Requires Node 20+ and a Git repository. Built-in agent adapters cover [Claude Code](https://docs.anthropic.com/claude-code), [OpenAI Codex](https://openai.com/codex), local models via [Ollama](https://ollama.ai), a deterministic test agent, and any custom shell command.

## Quickstart — one task, 60 seconds

```bash
cd your-git-repo
rk init

# Smoke the loop with the deterministic fake agent — no API keys needed.
# `fake` writes a placeholder file; it does NOT implement real prompts.
rk run -m "Run a deterministic fake task" --agent fake

# RepoKernel synthesizes a task, opens an isolated worktree, runs the agent,
# runs your checks, and pauses with a reviewable diff.

rk close T-001    # merge worktree into main, mark task shipped
# or
rk discard T-001  # release worktree, drop changes
```

For real coding work, swap `--agent fake` for an LLM-backed adapter:

```bash
rk run -m "Add a /health endpoint that returns 200 OK" --agent claude
```

Available adapters:

- `--agent claude` once [Claude Code](https://docs.anthropic.com/claude-code) is installed
- `--agent codex` for [OpenAI Codex](https://openai.com/codex)
- `--agent ollama` for a local model via [Ollama](https://ollama.ai) (no API keys, no cloud — set `OLLAMA_MODEL` and `OLLAMA_HOST` if you want to override the defaults)

That is the whole loop.

## For multi-task workflows

RepoKernel can also route larger work through dependency-aware queues:

- `rk next` picks the next runnable sprint based on the dependency graph.
- `rk epic status E-001` gives a cold-start summary for fresh agent sessions — useful when a Claude session ends and the next one needs to catch up without re-reading the whole project.
- `allowed_paths` catches out-of-scope changes before review or close. Agents can't ship changes outside the agreed scope without a visible frontmatter override.
- Review IDs and lanes are allocated atomically so parallel worktrees don't collide.

See [docs/internals/parallel-waves.md](docs/internals/parallel-waves.md) for parallel-agent runs (worktrees + dependency graph across waves).

## Agent-operated by design

You don't have to drive RepoKernel manually. With a RepoKernel-aware agent skill installed, your coding agent can:

- create epics and split work into sprints
- ask `rk next` for the next runnable task
- run sprints in isolated Git worktrees
- validate scope and run your checks before review
- move work through review and close

You give intent. The agent operates `rk`. RepoKernel keeps the state honest — `allowed_paths` flags scope drift at review time, review verdicts gate close, and every commit traces back to a sprint.

## Why

- **Isolated.** Every task runs in its own Git worktree. Your main branch stays clean until you merge.
- **Self-routing for multi-task work.** `rk next` walks the dependency graph and surfaces the runnable sprint. Fresh agent sessions catch up with `rk epic status E-NNN`.
- **Out-of-scope changes caught before review.** `allowed_paths` flags drift at review time — agents can't ship outside the agreed scope without a visible frontmatter override.
- **Pre-flight gate.** `rk validate --fail-on P0,P1` blocks unsafe project state before work continues. Cheaper than CI.
- **Auditable.** `base_sha` + `end_sha` per sprint, review verdict required before close, every commit traces to a sprint. `git log` is the audit trail; no external dashboard needed.
- **Vendor-neutral.** Built-in adapters for Claude Code, Codex, Ollama (local), `fake`, `manual`, plus any shell command. Switch agents without rewriting your workflow.

## When should I use this?

**Yes, if any of these fit:**

- **You run Claude Code or Codex on a real codebase and want each task in its own branch with checks before merge.**
  RepoKernel handles the worktree, review gate, and merge — a bad agent run can't land on `main`.

- **You're testing multiple agents (Claude, Codex, local Ollama) and want one uniform run + review interface.**
  Same `rk run` / `rk close` regardless of backend; switch with `--agent`.

- **You want an audit trail — every agent action ends as a Git commit on a sprint branch, reviewable before it touches main.**
  `git log` on the sprint branch is the audit; no external dashboard needed.

**Overkill if:**

- One-off shell scripts or single-file tweaks
- Throwaway prototypes you never plan to merge
- Non-Git workflows (notebooks, no-code tools, etc.)
- Teams who already have CI gating + branch protection and just want raw agent output piped to a PR — RK adds more process than that

## Other input modes

```bash
rk run                    # opens $EDITOR with a structured task template
rk run path/to/task.md    # task in a file
echo "..." | rk run --stdin --agent claude
```

## Configuring checks

`rk init` creates `repokernel.config.yaml`. Edit it and add the commands the agent's work has to pass before `rk close` will merge:

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
| `ollama` | Local model via [Ollama](https://ollama.ai) HTTP API — runs on your machine, no API keys |
| `fake` | Deterministic test agent — no LLM, useful for demos and CI |
| `manual` | Pauses so you do the work yourself |
| custom | Any shell command, configured in `repokernel.config.yaml` |

Configure the local agent via environment variables:

```bash
OLLAMA_MODEL=llama3.1   # any model your `ollama list` shows
OLLAMA_HOST=http://localhost:11434
OLLAMA_TIMEOUT_MS=1800000
```

## Examples

- [`examples/fastpath`](examples/fastpath) — minimal runnable fastpath project
- [`examples/basic`](examples/basic) — single-epic starter project
- [`examples/external-agent`](examples/external-agent) — wiring a custom agent adapter
- [`examples/parallel`](examples/parallel) — multi-task orchestration

## Documentation

- [Fastpath in depth](docs/fastpath.md) — what the three-command flow does behind the scenes

## Advanced

Need more than one task? RepoKernel also supports multi-task plans, parallel waves, lane queues, and review workflows. The fastpath flow continues to work alongside those features.

For parallel agent runs, see how `rk next`, `allowed_paths`, and atomic review allocation compose: [docs/internals/parallel-waves.md](docs/internals/parallel-waves.md).

- [Detailed README](docs/internals/README-detailed.md) — the full feature surface
- [Concepts](docs/internals/concepts.md) — model reference
- [CLI reference](docs/internals/cli-reference.md) — every command
- [Internals](docs/internals/) — schemas, parallel waves, agent adapters, recovery

## Status

Local-first. No daemon, no database, no hosted service. Schema and CLI are still evolving — pin a version (see [CHANGELOG.md](CHANGELOG.md)) if you embed RepoKernel in CI.

## License

MIT — see [LICENSE](LICENSE).
