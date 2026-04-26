# Sequential runs

Sequential execution is the default. Sprints run one at a time in queue order, each building on the commits of the previous sprint.

## How it works

The run loop walks the queue for the target epic and lane. On each iteration it:

1. Finds the first `queued` sprint whose `depends_on` are all `shipped`
2. Starts the sprint, invokes the agent, handles review
3. Ships the sprint and repeats

Each sprint commits to the same epic worktree branch (`rk/<epic-id>`). Later sprints see the commits from earlier ones.

## Setting up a sequential epic

Epic frontmatter does not need an `execution_strategy` field for sequential mode — it is the default.

```yaml
# epics/E-001-auth.md
---
id: E-001
title: Authentication system
status: active
sprints:
  - S-001
  - S-002
  - S-003
---
```

Queue your sprints in order:

```yaml
# queues/main.md
---
lane: main
slots:
  - id: Q-001
    sprint_id: S-001
    order: 0
  - id: Q-002
    sprint_id: S-002
    order: 1
  - id: Q-003
    sprint_id: S-003
    order: 2
---
```

Express ordering constraints with `depends_on`:

```yaml
# sprints/S-002-add-refresh-tokens.md
---
id: S-002
epic_id: E-001
depends_on:
  - S-001
---
```

`depends_on` is enforced by the resolver: `S-002` will not run until `S-001` is `shipped`.

## Running

```bash
rk run E-001 --agent fake --limit 3
```

Omit `--limit` to run the entire epic without stopping (still pauses for review in assisted mode).

Preview the sprint chain before executing:

```bash
rk run E-001 --dry-run
```

Dry-run prints the resolved worktree path, branch, and the ordered chain of sprints without making any changes.

## Assisted vs. autonomous mode

**Assisted mode** (default) pauses after each sprint's review step. You review the diff, set the verdict, then resume.

```bash
rk review-verdict R-001 accepted
rk run E-001 --resume RUN-001
```

**Autonomous mode** requires `automation.allowAutonomousClose: true` in config. The loop does not pause for human review between sprints. Use it only when validators and `allowed_paths` coverage are comprehensive.

```bash
# repokernel.config.yaml
automation:
  allowAutonomousClose: true
```

```bash
rk run E-001 --agent fake --mode autonomous
```

## `allowed_paths` in sequential mode

Sequential sprints do not require `allowed_paths`. The field is optional and, when set, is validated at review time — files outside the declared paths will block the sprint from closing.

```yaml
allowed_paths:
  - src/auth/**
  - tests/auth/**
```

`denied_paths` is also checked at review: any changed file matching a denied pattern blocks the sprint.

## Resuming a paused run

Runs pause when they hit `--limit`, when a review is needed, or when an agent fails. List paused runs:

```bash
rk runs --status paused --epic E-001
```

Resume a specific run:

```bash
rk run E-001 --resume RUN-001
```

If you need to abandon a paused run:

```bash
rk run abort RUN-001
```

## What to do when a sprint fails

If the agent returns a `failed` or `blocked` result, the run halts with `agent_failed:<sprint-id>`. Check the logs:

```bash
rk run logs RUN-001 S-002
```

Fix the underlying issue (update sprint context, fix the repo, or adjust the agent), then start a fresh run. Failed runs cannot be resumed — the sprint is still `active` and can be picked up by a new run after manual intervention.

To manually advance a stuck sprint:

```bash
rk start S-002     # if it regressed to queued
rk review S-002    # transition to review manually
rk review-verdict R-002 accepted
rk close S-002
```

Then start a new run for the next sprint.

## Related

- [Run loop](run-loop.md) — full step-by-step loop description
- [Resume and recovery](resume-recovery.md) — halt reasons and recovery steps
- [Parallel waves](parallel-waves.md) — run sprints concurrently
