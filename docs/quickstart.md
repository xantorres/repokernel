# Quickstart

Get RepoKernel running against a real project in under 10 minutes.

## Prerequisites

- Node.js 20+
- pnpm (or npm)
- A git repository

## Install

```bash
npm install -g repokernel
```

Or run without installing:

```bash
npx repokernel --version
```

`rk` and `repokernel` are aliases for the same binary.

## Bootstrap a project

Run this inside any git repository:

```bash
rk init
```

This creates `repokernel.config.yaml` and the default directory layout under `.repokernel/plan/`.

To also generate a working example with one epic, several sprints in different states, a queue, and an accepted review:

```bash
rk init --example
```

With `--example` in place, validation and the next-sprint resolver work immediately.

## Verify your setup

```bash
rk doctor
```

`doctor` checks that the config is valid, git is present, path directories exist, and the registry is up to date. Fix anything it flags before continuing.

```bash
rk validate
```

`validate` runs all validators and prints findings. P0 and P1 findings block the run loop — they must be clean before an agent can proceed. A fresh `--example` project validates with zero findings.

## See what runs next

```bash
rk next
```

Prints the next runnable sprint and why it was selected. If nothing is runnable it explains what is blocking.

```bash
rk status
```

Shows a project health summary: sprint counts by status, max finding severity, and the next sprint for the default lane.

## Run your first agent sprint

```bash
rk run E-001 --agent fake --limit 1
```

`--agent fake` is a deterministic test agent — it reads the context packet, writes a `.txt` file, commits it, and returns a sentinel result. Use it to verify the full run loop before connecting a real agent.

The run loop:

1. Resolves the next sprint for the epic.
2. Creates or reuses an isolated git worktree.
3. Generates a context packet for the agent.
4. Invokes the agent.
5. Validates the result against `allowed_paths` / `denied_paths`.
6. Transitions the sprint to `review`.
7. Pauses and prints the resume command (in assisted mode).

## Review and advance

After the run pauses for review, set the verdict:

```bash
rk review-verdict R-001 accepted
```

Then resume:

```bash
rk run --resume RUN-001
```

The sprint closes and the loop advances to the next sprint, or completes the epic.

## Dry-run before committing

Preview the worktree path, branch, and wave plan without making any changes:

```bash
rk run E-001 --dry-run
```

## Next steps

- [Concepts](concepts.md) — understand epics, sprints, lanes, and queues
- [Run loop](run-loop.md) — how a run proceeds step by step
- [Agent adapters](agent-adapters.md) — connect a real AI agent
- [Config reference](config-reference.md) — all configuration options
