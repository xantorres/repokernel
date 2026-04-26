# Review gates

Review gates are named checkpoints that group sprints within an epic. All sprints in a gate must be reviewed and accepted before any downstream sprint that depends on them can run.

## What a gate does

A gate is a label declared in sprint frontmatter. Sprints sharing a gate name form a checkpoint group. The run loop enforces that the gate clears before advancing.

Gates serve two purposes:

1. **Quality enforcement** — force a human review of a critical phase before the next phase begins.
2. **Parallel coordination** — in parallel epics, group related sprints that should be reviewed together before merging.

## Declaring a gate

Add a `gate` field to the sprint's frontmatter:

```yaml
# sprints/S-002-api-endpoints.md
---
id: S-002
title: Add API endpoints
epic_id: E-001
status: queued
lane: main
gate: backend-complete
allowed_paths:
  - src/api/**
---
```

```yaml
# sprints/S-003-validation.md
---
id: S-003
title: Add input validation
epic_id: E-001
status: queued
lane: main
gate: backend-complete
allowed_paths:
  - src/validation/**
---
```

Both `S-002` and `S-003` belong to the `backend-complete` gate. Any sprint with `depends_on` referencing either of these will not run until both are shipped.

## Gates in sequential epics

In sequential mode, gates act as review barriers. When the loop reaches a sprint that is gated and all sprints in that gate are now in `review`, the loop pauses and waits for all gate reviews to be accepted before proceeding with any sprint that depends on the gate.

This ensures a phase is fully reviewed before work that builds on it begins.

## Gates in parallel epics

In parallel mode, gates define review synchronization points between waves. Sprints in the same gate run in the same wave. The loop does not begin a new wave that depends on the gate until all gate sprints have accepted reviews.

Example:

```
Wave 1:  S-001 (gate: api-layer), S-002 (gate: api-layer)
   ↓  [both reviewed and accepted]
Wave 2:  S-003, S-004  (depend on gate: api-layer)
```

This is enforced through the combination of `gate` and `depends_on` — downstream sprints list the gated sprints in their `depends_on`.

## Reviewing a gate

Gates do not introduce new commands. The normal review flow applies:

```bash
rk review-verdict R-002 accepted
rk review-verdict R-003 accepted
rk run E-001 --resume RUN-001
```

On resume, the loop checks that all sprints in the gate are `shipped` (or, for the current wave, have accepted reviews ready to be closed). If any gate sprint has not been accepted, the resume is blocked.

## Inspecting gate state

```bash
rk inspect S-002
```

The inspect output includes gate membership and whether the gate is cleared.

```bash
rk next --json
```

The resolver output includes gate blocking reasons when a gate prevents the next sprint from running.

## Gate vs. `depends_on`

| Mechanism | Purpose |
|---|---|
| `depends_on` | Hard ordering: sprint B cannot start until sprint A is `shipped` |
| `gate` | Group checkpoint: all sprints in the gate must be accepted before dependents run |

You typically use both together: declare a gate on a set of sprints, and add those sprints to the `depends_on` of the next phase.

## Related

- [Parallel waves](parallel-waves.md) — how waves are built and gated
- [Sequential runs](sequential-runs.md) — using gates in linear epics
- [Concepts](concepts.md) — sprint and review entity schemas
