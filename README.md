<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./docs/assets/logo-light.png">
    <img src="./docs/assets/logo-light.png" alt="RepoKernel" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/repokernel"><img src="https://img.shields.io/npm/v/repokernel.svg" alt="npm"></a>
  <a href="https://github.com/xantorres/repokernel/actions/workflows/ci.yml"><img src="https://github.com/xantorres/repokernel/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<h3 align="center">Git-native control plane for AI coding agents.</h3>

<p align="center">
Isolated worktrees. Validation gates. Deterministic state.<br>
Local-first. Agent-agnostic. No daemon, no database, no cloud.
</p>

---

## Why RepoKernel exists

AI coding agents are fast. They are also messy. They edit files outside the agreed scope, trample each other in parallel runs, land bad diffs on `main`, and re-read your repo every session because they have nowhere to remember what shipped.

RepoKernel gives them durable workflow state outside the chat: every task in its own Git worktree, every change behind a validation gate, every merge auditable through `git log`. Agents move fast. RepoKernel keeps the repo controlled.

## Try it in 60 seconds

```bash
npm i -g repokernel
cd your-git-repo
rk init --commit
rk run -m "Add a README section about RepoKernel" --agent fake
rk close T-001
```

What just happened: RepoKernel initialized and committed its metadata, synthesized `T-001`, opened an isolated worktree, ran the deterministic `fake` agent, paused for review, and merged the result into `main` with a full audit trail.

No API keys, no cloud calls. `fake` is a deterministic test agent that writes a placeholder file. Swap it for `--agent claude` or `--agent codex` when you're ready for real coding.

> Requires Node 20+ and a Git repository.

## Let your agent drive RepoKernel

The CLI is the substrate. The **skill is the real interface** for agent-driven work.

Install the skill into your agent's rules directory:

| Agent / IDE | Command |
|---|---|
| Claude Code | `rk install-skill` |
| Cursor | `rk install-skill --ide cursor` |
| Windsurf | `rk install-skill --ide windsurf` |
| GitHub Copilot | `rk install-skill --ide copilot` |
| Gemini CLI | `rk install-skill --ide gemini` |
| opencode | `rk install-skill --ide opencode` |

By default, IDE installs go to your user-global rules directory (`~/.cursor/rules/`, `~/.windsurf/rules/`, etc.). Add `--project` to scope the install to the current repo instead:

```bash
rk install-skill --ide cursor --project   # .cursor/rules/repokernel.mdc
```

Once installed, your agent stops guessing the lifecycle from prose and starts using six purpose-built verbs:

| Verb | Slash | Does |
|---|---|---|
| status | `/rk-status` | Read-only dashboard: epics, next sprint, P0/P1 count |
| next | `/rk-next` | Resolve the next runnable sprint with tier-routed cost band |
| run | `/rk-run` | Execute sprint / epic / fastpath; pause on review or failure |
| review | `/rk-review` | Spawn parallel review panel; merge findings; record verdict |
| doctor | `/rk-doctor` | Drift triage; surfaces a fix plan; never auto-applies |
| plan | `/rk-plan` | Scaffold an epic into 3–6 sprints from intent; never auto-executes |

Then talk to your coding agent in plain English:

> _"Check RepoKernel status, run the next sprint, and review when it's done."_

**Why this matters:** agents that infer state from markdown tables corrupt that state. The skill teaches them validation gates, stop conditions, tier-to-model routing, and exactly when to halt. RepoKernel stays the source of truth. The agent never edits `.repokernel/**` directly.

## Why worktrees + validation gates

**Isolation by construction.**
Every task runs in its own `git worktree`. Your `main` branch stays clean until merge. Parallel agents fan out without colliding on review IDs, plan state, or commits.

**Pre-flight before work.**
`rk validate --fail-on P0,P1` blocks unsafe project state in milliseconds, way cheaper than discovering it in CI three commits later. Use it as a gate, hook, or just before starting a session.

**Review gate before merge.**
Configured checks must pass. A review verdict must be recorded. Only then does `rk close` merge into `main`. Failed checks leave the task in `active` so you can retry with `rk run T-NNN` or drop it with `rk discard T-NNN`.

**Scope guardrails.**
`allowed_paths` in sprint frontmatter flags out-of-scope edits at review time. The agent can still try; it can't ship outside agreed scope without a visible override.

## Real coding agents

Swap `fake` for an LLM-backed adapter:

```bash
rk run -m "Add a /health endpoint that returns 200 OK" --agent claude
```

| Adapter | Notes |
|---|---|
| `claude` | [Claude Code](https://docs.anthropic.com/claude-code) CLI. [Setup](docs/agents/claude.md) |
| `codex` | [OpenAI Codex](https://openai.com/codex) CLI. [Setup](docs/agents/codex.md) |
| `ollama` | Local model via [Ollama](https://ollama.ai). No API keys, no cloud |
| `fake` | Deterministic test agent. Perfect for demos and CI |
| `manual` | Pauses so you do the work yourself |
| custom | Any shell command, configured in `repokernel.config.yaml` |

Configure required checks once in `repokernel.config.yaml`:

```yaml
automation:
  checksCmd: pnpm lint && pnpm typecheck && pnpm test
```

## Going bigger: epics, sprints, parallel waves

For multi-task projects:

```bash
rk create epic "Migrate auth to OAuth2"
rk create sprint "Add OAuth callback" --epic E-001
rk run E-001 --agent claude
```

- **Dependency-aware queues.** `rk next` walks the graph and surfaces the runnable sprint after every merge.
- **Atomic review allocation.** Review IDs come from a counter at git-common-dir, not the worktree. Parallel agents never collide.
- **Parallel waves with safety checks.** Independent sprints with non-overlapping `allowed_paths` can run in the same wave. Gated sprints pause execution until the gate is resolved.
- **Cold-start summaries.** `rk epic status E-001` returns shipped / in-review / queued / blocked in five lines, so a fresh agent session catches up without re-reading 200-line tables.

See [parallel waves](docs/internals/parallel-waves.md) for fan-out semantics, and [advanced quickstart](docs/internals/quickstart-advanced.md) for a full multi-sprint walkthrough.

## Three ways to use it

| Level | For | Entry point |
|---|---|---|
| **Fastpath**: one task, one worktree, done | Quick AI coding tasks | `rk run -m "..."` |
| **Agent-operated**: your agent drives `rk` via the bundled skill | Daily work with Claude / Codex / custom | `rk install-skill` |
| **Advanced**: epics, sprints, dependency graphs, parallel waves | Multi-task projects, parallel agents | `rk create epic` then `rk run E-001` |

Want a visual snapshot without a service? `rk report` writes a local HTML report with health, next work, epics, sprints, and findings.

## When it's overkill

- One-off shell scripts or single-file tweaks
- Throwaway prototypes you never plan to merge
- Non-Git workflows
- Teams that already gate via CI + branch protection and just want raw agent output piped to a PR

## Examples

- [`examples/fastpath`](examples/fastpath): minimal one-task project
- [`examples/basic`](examples/basic): single-epic starter
- [`examples/parallel`](examples/parallel): multi-task orchestration
- [`examples/external-agent`](examples/external-agent): wiring a custom adapter

## Documentation

- [Fastpath in depth](docs/fastpath.md): what the three-command flow does behind the scenes
- [CLI reference](docs/internals/cli-reference.md): every command, every flag
- [Concepts](docs/internals/concepts.md): model and schema reference
- [Parallel waves](docs/internals/parallel-waves.md): how fan-out and gates compose
- [Detailed README](docs/internals/README-detailed.md): full feature surface

## Status

Local-first. No daemon, no database, no hosted service. RepoKernel is a CLI plus a state directory under `.repokernel/` (or any path you choose with `rk init --dir <path>`). Schema and CLI are still evolving; pin a version (see [CHANGELOG.md](CHANGELOG.md)) if you embed it in CI.

## License

MIT. See [LICENSE](LICENSE).
