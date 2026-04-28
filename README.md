# RepoKernel

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

## Use

```bash
cd your-git-repo
rk init

rk run -m "Add a /health endpoint that returns 200 OK" --agent fake

# RepoKernel synthesizes a task, opens an isolated worktree, runs the agent,
# runs your checks, and pauses with a reviewable diff.

rk close T-001    # merge worktree into main, mark task shipped
# or
rk discard T-001  # release worktree, drop changes
```

`fake` is the deterministic built-in agent — it runs without API keys so the
quickstart works on any machine. For real coding work, swap it for:

- `--agent claude` once [Claude Code](https://docs.anthropic.com/claude-code) is installed
- `--agent codex` for [OpenAI Codex](https://openai.com/codex)
- `--agent ollama` for a local model via [Ollama](https://ollama.ai) (no API keys, no cloud — set `OLLAMA_MODEL` and `OLLAMA_HOST` if you want to override the defaults)

That is the whole loop.

## Why

- **Isolated.** Every task runs in its own Git worktree. Your main branch stays clean until you merge.
- **Checked.** Lint, type, and test commands run before close. Failed checks block the merge.
- **Auditable.** Synthesis, agent commits, the auto-accepted review, and the merge each land as separate commits. `git log` is the audit trail.
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

- [Detailed README](docs/internals/README-detailed.md) — the full feature surface
- [Concepts](docs/internals/concepts.md) — model reference
- [CLI reference](docs/internals/cli-reference.md) — every command
- [Internals](docs/internals/) — schemas, parallel waves, agent adapters, recovery

## Status

Local-first. No daemon, no database, no hosted service. Schema and CLI are still evolving — pin a version (see [CHANGELOG.md](CHANGELOG.md)) if you embed RepoKernel in CI.

## License

MIT — see [LICENSE](LICENSE).
