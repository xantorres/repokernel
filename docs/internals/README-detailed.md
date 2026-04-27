# RepoKernel

[![npm](https://img.shields.io/npm/v/repokernel.svg)](https://www.npmjs.com/package/repokernel)
[![CI](https://github.com/xantorres/repokernel/actions/workflows/ci.yml/badge.svg)](https://github.com/xantorres/repokernel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)
[![Code style: Biome](https://img.shields.io/badge/code_style-biome-60a5fa)](https://biomejs.dev)

> **Snapshot.** This file is the v1.3.0 README, preserved as the deep reference for power users. The current entry point is the slimmer [project README](../../README.md). Links below have been rewritten for this directory.

**RepoKernel is a local-first, Git-native, agent-agnostic control plane for autonomous coding work.**

It tells your coding agent what to do next, makes sure the repo is safe to touch, and keeps work resumable across sessions, sprints, and reviews.

```bash
rk run E-001
```

---

## Why RepoKernel exists

Coding agents are good at writing code and bad at managing themselves. Given a long-lived project, they lose track of what is in flight, pick the wrong thing to work on, step on each other in parallel, and quietly drift away from whatever plan you wrote in markdown.

Common pain:

- Agents lose context between sessions and re-derive state from prose.
- Agents pick the wrong sprint, or skip dependencies.
- Two parallel agents touch the same files and produce a merge mess.
- Markdown plans drift from reality the moment work starts.
- Reviews get skipped, inconsistent, or invented after the fact.
- Worktrees pile up dirty, half-merged, or orphaned.
- Humans can't tell what is actually safe to run right now.

**RepoKernel is the control layer between your plan and your agent.** Your agent writes code. RepoKernel decides what is executable, where it runs, and whether it shipped.

---

## What RepoKernel does

- Resolves the next runnable sprint from the queue.
- Validates repo and plan state before any agent runs (P0–P3 findings).
- Manages isolated git worktrees per epic — and per sprint, in parallel mode.
- Drives sprints through `planned → queued → active → review → shipped`.
- Enforces path safety (`allowed_paths` whitelist, `denied_paths` blocklist).
- Records reviews with `base_sha` / `end_sha` and verdicts.
- Generates a deterministic `.repokernel/registry.json` snapshot for agents and CI.
- Persists run state so paused or failed runs can resume.
- Invokes any agent via adapter (built-in `fake`, `manual`, `claude`, `codex`, or your own external command).

## What RepoKernel is not

- Not a project management app.
- Not a dashboard, web UI, or TUI.
- Not an AI IDE.
- Not a backlog or ticket tracker.
- Not an agent framework or LLM SDK.
- Does not call model APIs directly.

It runs entirely on your machine, against your git repo. No daemon, no DB, no hosted service.

---

## Quickstart

Install from npm — [`repokernel` on npmjs](https://www.npmjs.com/package/repokernel):

```bash
npm i -g repokernel        # or: pnpm add -g repokernel / yarn global add repokernel
rk --version
```

Or build from source:

```bash
git clone https://github.com/xantorres/repokernel.git
cd repokernel
pnpm install && pnpm build && pnpm link
```

Initialize an example project and inspect it:

```bash
mkdir /tmp/rk-demo && cd /tmp/rk-demo
git init -q
rk init --example
git add -A && git commit -q -m "init"

rk validate         # zero findings
rk status           # project health, next sprint
rk next             # show the next runnable sprint and why
rk inspect S-002    # see one sprint
rk registry --check # detect drift in .repokernel/registry.json
```

Author your own entities (or write the Markdown files by hand):

```bash
rk create epic "Auth rewrite"               # → .repokernel/plan/epics/E-NNN.md
rk create sprint --epic E-002 "Drop legacy" # → .repokernel/plan/sprints/S-NNN.md
rk create queue --lane release              # → .repokernel/plan/queues/release.md
```

IDs auto-increment (`E-NNN`, `S-NNN`); each scaffold prints the assigned ID.

Every entity is a Markdown file with YAML frontmatter — that frontmatter is the contract, the prose below `---` is for humans. Full field reference and ID rules: [specs/entities.md](specs/entities.md). Working samples to copy: [`examples/`](../../examples).

Then drive a sprint with the deterministic test agent and accept the review — see [quickstart-advanced.md](quickstart-advanced.md) for the full agent loop including `rk review-verdict` and `rk run --resume`.

---

## Core concepts

**Epic** — a feature, made of sprints. Has an `execution_strategy` (sequential or parallel).

**Sprint** — one unit of work. Lifecycle: `planned → queued → active → review → shipped`. Stored as Markdown with YAML frontmatter.

**Queue** — the ordered list of sprints for one lane. One queue file per lane.

**Lane** — a named execution track (`main`, `release`, `hotfix`, …). Sprints in different lanes are independent.

**Review** — a verdict artifact (`accepted | changes_requested | rejected`) recording `base_sha` and `end_sha`.

**Run** — a persisted execution record at `.git/repokernel/runs/RUN-NNN.json`. Local only, survives process restarts, needed to resume.

**Worktree** — an isolated git worktree per epic, and additionally per sprint when running parallel.

**Registry** — generated snapshot at `.repokernel/registry.json`. Source of truth for agents and CI. `rk registry --check` detects drift.

**Agent adapter** — the bridge between RepoKernel and a coding tool. Adapters are configured per project, never hardcoded.

See [concepts.md](concepts.md) for the full model.

---

## Normal workflow

The happy path:

1. Author or edit epic and sprint files (`.repokernel/plan/epics/`, `.repokernel/plan/sprints/`).
2. `rk validate` — must be clean.
3. `rk next` — confirm what would run.
4. `rk run E-001 --agent <name>` — drives the loop.
5. Sprint enters `review`. Set verdict and ship:
   ```bash
   rk review-verdict R-002 accepted
   rk close S-002
   ```
6. If a run halts, inspect and resume:
   ```bash
   rk run inspect RUN-001
   rk run --resume RUN-001
   ```
7. Once all sprints are shipped, close the epic:
   ```bash
   rk epic close E-001
   ```

See [run-loop.md](run-loop.md).

---

## Sequential vs parallel execution

`rk run E-001` is the normal command. **Execution mode comes from the epic file, not the command line.**

```yaml
# .repokernel/plan/epics/E-001.md
execution_strategy: parallel    # or: sequential (default)
parallel_limit: 2
```

- **Sequential** — one sprint at a time on the epic worktree. `allowed_paths` is optional.
- **Parallel** — sprints group into dependency waves and run concurrently in per-sprint worktrees. Each sprint **must** declare `allowed_paths`. Overlapping paths in the same wave are blocked unless you pass `--allow-overlap`.

CLI flags only narrow, assert, or debug — they don't change strategy:

| Flag | Purpose |
|---|---|
| `--sequential` | Downgrade a parallel epic to sequential for one run. |
| `--parallel` | Assert epic is parallel; error if not. |
| `--concurrency N` | Cap parallel workers for one run. |
| `--allow-overlap` | Bypass path-conflict guard within a wave. |
| `--limit N` | Stop after N sprints. |
| `--dry-run` | Plan only, no changes. |

See [sequential-runs.md](sequential-runs.md), [parallel-waves.md](parallel-waves.md), [path-safety.md](path-safety.md).

---

## Agent-agnostic execution

| Agent | Description |
|---|---|
| `fake` | Deterministic test agent. Writes a file, commits, returns a sentinel result. |
| `manual` | Pauses the run so you do the work yourself. |
| `claude` | CLI preset — invokes `claude --print -p <packet>`. |
| `codex` | CLI preset — invokes `codex --approval-mode full-auto -q <packet>`. |
| external | Any shell command, configured in `repokernel.config.yaml`. |

External agent example:

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

RepoKernel never imports a model SDK. Agents return a sentinel JSON block between `REPOKERNEL_RESULT_START` / `REPOKERNEL_RESULT_END`; RepoKernel parses that and decides the next step. See [agent-adapters.md](agent-adapters.md).

### Hands-off operation: the `repokernel-operator` skill

[`examples/skills/repokernel-operator`](../../examples/skills/repokernel-operator) is a Claude-style skill that teaches an agent to drive RepoKernel itself. Drop it into your agent's skill directory (e.g. `~/.claude/skills/`) and **you stop running `rk` commands by hand**.

The agent learns to:

- Run `rk validate` and `rk status` before touching code.
- Use `rk next` to pick the next sprint instead of guessing from prose.
- Drive the state machine via `rk start`, `rk review`, `rk review-verdict`, `rk close`, `rk epic close` — never edit `status:` frontmatter directly.
- Refuse to hand-edit generated files (`.repokernel/registry.json`, run logs).
- Resume halted runs via `rk run --resume` rather than starting fresh.

Once the skill is loaded, you talk to the agent in plain English. No `rk` commands, no IDs, no flags. The agent translates and runs the right thing:

| You say | Agent does |
|---|---|
| "work on the next epic" | `rk status` → picks first epic with runnable sprints → `rk run <EPIC_ID>` |
| "next sprint" / "keep going" | `rk next` → `rk start` (or `rk run --resume <RUN_ID>` if a run is paused) |
| "what's the state?" | `rk validate` + `rk status` + `rk runs` |
| "ship it" / "approve and close" | `rk review-verdict <R-ID> accepted` → `rk close <S-ID>` |
| "done with the epic" | `rk epic close <EPIC_ID>` |
| "something broke, recover" | `rk run inspect <RUN_ID>` → diagnose → `rk run --resume` or `rk fix --apply` |
| "start a new sprint for X under epic Y" | `rk create sprint --epic Y "X"` → adds to queue |

You only step in at review verdicts — and even those go away if you set `review_required: false` per sprint.

Skill works with any agent runtime that loads Markdown skill files; for non-Claude runtimes adapt the loader, the rules carry over.

---

## Safety model

- **Validation gates.** P0 and P1 findings block runs. `rk validate` is the source of truth.
- **Review gates.** A sprint with `review_required: true` cannot ship until its review verdict is `accepted`.
- **Path ownership.** `allowed_paths` whitelists files an agent may touch; `denied_paths` blocks them. Enforced when the agent returns and again at `rk close`.
- **Dirty worktree protection.** `rk run` and `rk lane release` refuse to operate on dirty trees without explicit `--allow-dirty` / `--force`.
- **Deterministic registry.** `rk registry --check` fails CI on any drift between source files and `.repokernel/registry.json`.
- **No silent fallback.** Malformed state produces a finding. Nothing is inferred from prose.

See [path-safety.md](path-safety.md), [review-gates.md](review-gates.md), [resume-recovery.md](resume-recovery.md).

---

## Example project layout

`rk init --example` produces:

```
my-project/
  repokernel.config.yaml
  .repokernel/
    plan/
      epics/
        E-001.md
      sprints/
        S-001.md
        S-002.md
        S-003.md
      queues/
        main.md
      reviews/
        R-001.md
      lanes/
    registry.json          # generated
    authority.md
```

Paths are configurable. The hand-written examples under [`examples/`](../../examples) use a flatter layout (`epics/`, `sprints/`, … at the repo root) — see each example's `repokernel.config.yaml`.

---

## Common commands

**Create / scaffold** — start here when authoring a project

| Command | Purpose |
|---|---|
| `rk init [--example]` | Initialize a RepoKernel project (`--example` seeds a runnable epic). |
| `rk create epic "title"` | Scaffold a new epic. |
| `rk create sprint --epic E-001 "title"` | Scaffold a new sprint. |
| `rk create queue --lane main` | Scaffold a queue file. |
| `rk create review --sprint S-001` | Scaffold a review. |

**Run**

| Command | Purpose |
|---|---|
| `rk run E-001 --agent <name>` | Drive an epic using its `execution_strategy`. |
| `rk run --resume RUN-001` | Resume a paused or failed run. |
| `rk run inspect RUN-001` | Show run state and next steps. |
| `rk run logs RUN-001 [SPRINT-ID]` | Show agent logs for a run. |
| `rk run abort RUN-001` | Abort an active or paused run. |
| `rk runs` | List all run records. |

**Validate / inspect**

| Command | Purpose |
|---|---|
| `rk validate` | Run all validators. P0/P1 = stop. |
| `rk next` | Resolve the next runnable sprint. |
| `rk status` | Project health summary. |
| `rk doctor` | Diagnose setup problems (`--fix` to repair). |
| `rk inspect <ID>` | Show a sprint, epic, review, etc. |
| `rk explain <CODE>` | Explain a finding code. |
| `rk registry --check` | Detect registry drift. |

**Lifecycle**

| Command | Purpose |
|---|---|
| `rk start S-001` | Sprint → `active`. |
| `rk review S-001` | Sprint → `review`, create review stub. |
| `rk review-verdict R-001 accepted` | Set review verdict. |
| `rk close S-001` | Sprint → `shipped`. |
| `rk reopen S-001` | Reopen a shipped or in-review sprint. |
| `rk epic close E-001` | Epic → `done` (all sprints must be shipped/cancelled). |

**Lane / worktree**

| Command | Purpose |
|---|---|
| `rk lane ls` | List lanes with health and queue depth. |
| `rk lane acquire E-001` | Create worktree and claim lane. |
| `rk lane release E-001` | Release worktree and lane. |

All commands accept `--cwd <path>`. Most accept `--json` for machine-readable output.

**Exit codes:** `0` clean · `1` findings or blocked · `2` config or runtime error.

Full reference: [cli-reference.md](cli-reference.md).

---

## Status / maturity

- **Local-first.** No hosted service, no database, no daemon.
- **Core is usable** for real agentic coding workflows today.
- **Schema and CLI are still evolving.** Pin a version (see [../../CHANGELOG.md](../../CHANGELOG.md)) if you embed RepoKernel in CI.
- **Built for agents, friendly to humans.** You can drive every state transition manually with `rk` commands.

---

## Philosophy

1. **Schema first.** Frontmatter is the contract; prose is for humans.
2. **Deterministic.** No lifecycle inference from prose. `rk` commands are the only legal mutations.
3. **Fail loudly.** Malformed state produces a finding. Never a guess, never a silent default.
4. **Git-native.** Diff correctness is `base_sha..HEAD`, never timestamps.
5. **Agents execute, RepoKernel controls.** RepoKernel does not write your code; it decides what code work is safe to start.
6. **Local-first.** Your repo is the database.
7. **Inspectable.** Every entity is a file you can `rk inspect` or open in `$EDITOR`.

---

## Layout

```
packages/core/        schemas, parser, graph, validator, resolver, registry
packages/cli/         rk / repokernel CLI (commands, lifecycle, fastpath)
examples/             runnable example projects
docs/                 user-facing entry points
docs/internals/       deep references (this file lives here)
docs/internals/specs/ internal specifications
```

## License

MIT — see [../../LICENSE](../../LICENSE).
