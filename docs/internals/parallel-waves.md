# Parallel waves

Parallel execution runs multiple sprints concurrently within the same epic, each in its own isolated git worktree, then merges results back into the epic worktree.

## When to use parallel execution

Use parallel execution when:

- Sprints touch non-overlapping parts of the codebase
- Sprints have no data or code dependencies on each other
- You want to reduce wall-clock time for large epics

Do not use parallel execution when sprints share files or depend on each other's output — sequential mode is correct there.

## Enabling parallel execution

Set `execution_strategy: parallel` in the epic frontmatter:

```yaml
# epics/E-001-auth.md
---
id: E-001
title: Authentication system
status: active
execution_strategy: parallel
sprints:
  - S-001
  - S-002
  - S-003
---
```

## `allowed_paths` is required

Every sprint in a parallel epic must declare `allowed_paths`. An empty `allowed_paths` means "could touch anything," which makes path conflict detection impossible. The validator blocks parallel waves that contain sprints without `allowed_paths`.

```yaml
# sprints/S-001-jwt.md
---
id: S-001
epic_id: E-001
status: queued
lane: main
allowed_paths:
  - src/auth/jwt/**
  - tests/auth/jwt/**
---
```

```yaml
# sprints/S-002-session.md
---
id: S-002
epic_id: E-001
status: queued
lane: main
allowed_paths:
  - src/auth/session/**
  - tests/auth/session/**
---
```

Paths must not overlap between sprints in the same wave. If they do, the validator raises a conflict and blocks execution.

## How waves are built

The run loop groups sprints into dependency waves:

- **Wave 1**: sprints with no `depends_on`, or whose dependencies are already `shipped`
- **Wave 2**: sprints whose dependencies were in wave 1
- And so on.

Within each wave, sprints with non-overlapping `allowed_paths` run concurrently. Sprints with overlapping paths would conflict and are blocked unless `--allow-overlap` is passed (see below).

## Preview before running

Always preview the wave plan before executing:

```bash
rk run E-001 --dry-run
```

Dry-run output includes:

- Resolved worktree paths for each sprint
- Branch names (`rk/sprint/<epic-id>/<sprint-id>`)
- Wave groupings
- Any path conflicts detected

This is free — no git state is modified.

## Running a parallel epic

```bash
rk run E-001 --agent fake
```

With a concurrency cap:

```bash
rk run E-001 --agent fake --concurrency 2
```

`--concurrency` caps the number of sprints per wave. If a wave has 5 sprints and `--concurrency 2` is set, the first 2 run, then the next 2, then the last 1.

The global cap is set in config:

```yaml
parallel:
  maxConcurrentSprints: 4
```

## What happens during a wave

For each sprint in the wave:

1. A sprint worktree is created at `<worktrees.root>/<repo-directory-name>/<epic-id>-sprints/<sprint-id>/` on branch `rk/sprint/<epic-id>/<sprint-id>`.
2. The sprint is transitioned to `active` and the agent is invoked.
3. Agent results are validated (files checked against `allowed_paths`).
4. The sprint is transitioned to `review`.

After all sprints in the wave finish:

5. The run pauses with halt reason `awaiting_reviews`.
6. You review and accept each sprint's review.
7. On resume, each sprint's branch is merged into the epic worktree (`rk/epic/<epic-id>`).
8. The sprints are closed (`shipped`).
9. Sprint worktrees are removed.
10. The next wave starts.

## Reviewing a parallel wave

The run pauses after a wave completes and all sprints are in `review`. Set verdicts for each:

```bash
rk review-verdict R-001 accepted
rk review-verdict R-002 accepted
```

Then resume:

```bash
rk run --resume RUN-001
```

If `rk run` printed commands with `--cwd`, keep those flags; review files live in the epic worktree during managed runs.

The loop merges the accepted sprints and moves on.

## Merge conflicts

If two sprint branches conflict during merge into the epic worktree, the run halts with halt reason `merge_conflict:<sprint-id>`. This should not happen if `allowed_paths` are correctly scoped, but it can occur if paths overlap in ways the validator did not catch (e.g., shared generated files).

Resolution:

1. Inspect the conflict: `rk run logs RUN-001`
2. Resolve manually in the epic worktree
3. Start a fresh run — merge-conflicted runs cannot be resumed

## Overlapping paths

By default, sprints with overlapping `allowed_paths` are blocked from running in the same wave. To allow overlap explicitly (use with caution — you accept responsibility for conflicts):

First enable the override in config:

```yaml
parallel:
  allowOverlapFlag: true
```

Then pass the flag at runtime:

```bash
rk run E-001 --allow-overlap
```

## Review gates

You can add review gates between waves using the `gate` field on sprints. Sprints with the same `gate` value form a checkpoint: all must be accepted before any downstream sprint can run. See [Review gates](review-gates.md) for details.

## Related

- [Worktrees](worktrees.md) — how worktree isolation works
- [Review gates](review-gates.md) — checkpoint groups within an epic
- [Path safety](path-safety.md) — how `allowed_paths` and `denied_paths` are enforced
- [Run loop](run-loop.md) — the full run loop description
