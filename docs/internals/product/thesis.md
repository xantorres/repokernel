# Thesis

## Why RepoKernel exists

AI coding agents (Claude, Codex, Cursor, Copilot, and successors) can now read repos, edit files, run commands, open PRs, and continue work across sessions. Their weakness is not generation. Their weakness is *context discipline*: they have no deterministic way to ask the repo "what's safe to do right now?" and get a trustworthy answer.

Without that, agents:

- pick up stale plans from old markdown
- act on partial reviews
- branch from the wrong base
- collide with other agents on the same lane
- mark sprints shipped with no review or no diff
- accumulate registry drift that nobody notices
- get blocked by ambiguous IDs and silent parse failures

A human reviewing the same repo would catch most of these in five minutes. Agents currently don't.

## What RepoKernel is

RepoKernel is the control plane for AI-driven sprint execution. It validates repo project state, resolves the next runnable sprint, manages isolated git worktrees per epic, and orchestrates agents through a full run loop — sprint by sprint, review by review.

Inputs: markdown + YAML files in the repo (epics, sprints, reviews, queues, lanes), plus a config file.

Outputs:

- a deterministic finding list (with severity codes, agent-stable strings)
- a canonical machine-readable registry
- a "next runnable sprint" decision
- exit codes that scripts and agents can branch on
- an isolated worktree + sprint packet delivered to the agent
- a run record tracking epic + agent + sprint history

The product is the run orchestrator. Validation is its safety net.

## The run loop

Each `rk run` invocation steps through the following stages for each sprint:

1. **Resolve** — `rk next` determines the next runnable sprint; halts if blocked.
2. **Packet** — a context document is assembled (epic summary, sprint spec, accepted review history, config) and written to the worktree.
3. **Start** — the sprint is transitioned to `active`; `base_sha` is recorded.
4. **Agent** — the configured agent (manual or claude) receives the packet and produces output delimited by `REPOKERNEL_RESULT_START` / `REPOKERNEL_RESULT_END`.
5. **Validate** — `rk validate` runs against the worktree; P0/P1 findings halt the run.
6. **Review** — in assisted mode the run pauses and prints the resume command; in autonomous mode the agent self-reviews.
7. **Summary** — a sprint summary is written to the worktree commit.
8. **Advance** — the sprint is transitioned to `shipped`; the run record is updated; the loop repeats.

## State separation

RepoKernel separates two kinds of state:

**Project state** — epics, sprints, reviews, queues, lanes, config. Lives under `.repokernel/plan/` and `repokernel.config.yaml`. Git-tracked. The source of truth for what should happen.

**Operational state** — run records, lane locks, worktree registry. Lives under `.git/repokernel/`. Never git-tracked. Shared across all worktrees for a project. The source of truth for what is happening right now.

This separation means a run can be paused, resumed, or abandoned without leaving orphaned commits or dirty state in the main checkout.

## Assisted vs autonomous mode

**Assisted mode** (default) — the run pauses after each sprint's review step and prints:

```
Run paused. Resume with: rk run --resume RUN-001
```

The human inspects the worktree, approves or requests changes, then resumes. This is the safe default.

**Autonomous mode** — requires `automation.allowAutonomousClose: true` in config. The agent self-reviews; the run continues without human intervention between sprints. Intended for well-understood epics with high-coverage validation.

## What RepoKernel is not

- not a UI
- not a task tracker
- not a sprint planner
- not an AI project manager
- not a notebook
- not a dashboard
- not a hosted service
- not a prompt framework
- not a model adapter

RepoKernel does not manage tasks. It orchestrates their execution.

## Design principles

1. **Schema first.** Markdown is for humans. Frontmatter is the contract.
2. **Deterministic state machine.** No lifecycle inference from prose.
3. **Git native.** Git is the audit trail and diff source.
4. **Local first.** No hosted service, no DB.
5. **Human readable.** Authoritative files stay plain text.
6. **Agent portable.** Every agent reads the same validated state.
7. **Fail loudly.** Malformed state must produce findings.
8. **No hidden magic.** Every action is reproducible via CLI.
9. **No project-specific code.** Policies live in config, not in framework code.
10. **Diff correctness is sacred.** Review diff = `base_sha..HEAD`, never dates.
11. **Never stage broadly.** No lifecycle command may use `git add .`.
12. **Generated state must not silently drift.**

## Why not just AGENTS.md?

`AGENTS.md` tells agents how to behave.
RepoKernel tells agents whether the repo state allows them to proceed — and then drives them through it.

If validation has a P0 or P1 finding, the run halts.
If validation is clean, `rk run` resolves the next sprint, prepares a context packet, invokes the agent, validates the result, and advances the loop. The agent never needs to reason about repo state; RepoKernel handles that layer.

## v1 promise

> One command — `rk run E-001 --agent claude --limit 3` — resolves the next sprint, creates an isolated worktree, generates a context packet, invokes the agent, validates the result, handles review, writes a summary, and advances to the next sprint. Repeat until the epic is complete.

If RepoKernel says blocked, the run halts with a precise finding list.
If the loop completes, every sprint in the epic is shipped, reviewed, and recorded.
