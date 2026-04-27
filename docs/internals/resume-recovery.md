# Resume and recovery

`rk run` pauses for a variety of reasons. This page maps each halt reason to its diagnosis and recovery steps.

## Listing paused runs

```bash
rk runs --status paused
rk runs --status paused --epic E-001
```

Inspect a specific run:

```bash
rk run inspect RUN-001
rk run logs RUN-001
```

## Halt reasons

| Halt reason | What happened | How to recover |
|---|---|---|
| `awaiting_review` | Sprint complete, run is waiting for a human review verdict | `rk review-verdict R-NNN accepted` then `rk run --resume RUN-NNN` |
| `awaiting_reviews` | Parallel wave complete, all sprints in the wave need review verdicts | Set a verdict for each review, then `rk run --resume RUN-NNN` |
| `limit_reached` | Run hit the `--limit N` cap | `rk run --resume RUN-NNN` to continue; raise or omit `--limit` next time |
| `agent_failed:<sprint-id>` | Agent returned `failed` or `blocked` status | Check logs with `rk run logs RUN-NNN <sprint-id>`, fix the issue, start a fresh run |
| `merge_conflict:<sprint-id>` | Parallel sprint branch could not merge cleanly into the epic worktree | Resolve the conflict manually in the epic worktree, then start a fresh run |
| `epic_completed` | All sprints are shipped — the epic is done | Run `rk epic close E-001` (replace with your epic ID) to mark it `done`. |
| `no_runnable_sprints` | Nothing in the queue is eligible to run | Check `rk next --json` for blocking reasons; fix dependencies or add sprints to the queue |

## Resuming a paused run

```bash
rk run --resume RUN-001
```

The `--resume` flag looks up the paused run record and picks up from the last incomplete sprint. You do not need to pass `--agent` or `--limit` again — the run record stores those values.

When a run uses a managed worktree, use the exact review and resume commands printed by `rk run`; they include the required `--cwd` values.

## Checking what is blocking

```bash
rk next --json
```

Returns the next sprint and why it was (or was not) selected. When nothing is runnable, the JSON includes per-slot blocking reasons.

```bash
rk validate --json
```

Returns all findings. P0 and P1 findings block the run loop entirely — they must be fixed before any sprint can run.

```bash
rk explain QUEUED_DEPENDENCY_NOT_SHIPPED
```

Explains a specific finding code: what it means, what the expected state is, and how to fix it.

## Fixing a stuck active sprint

If a run terminated abnormally (crash, manual kill), a sprint may be left in `active` state with no paused run record. To recover:

1. Check what is active:

```bash
rk status --json
rk validate --json
```

2. If the sprint should be reviewed:

```bash
rk review S-002
rk review-verdict R-002 accepted
rk close S-002
```

3. Start a new run for the next sprint:

```bash
rk run E-001 --agent fake --limit 1
```

## Aborting a run

If you want to discard a paused run entirely:

```bash
rk run abort RUN-001
```

This removes the run record. The sprints retain their current status (e.g., a sprint in `review` stays in `review`). You can create a new run after aborting.

## Registry drift after recovery

After manual lifecycle operations, the registry may be out of sync. Regenerate it:

```bash
rk registry --write
rk registry --check
```

## Related

- [Run loop](run-loop.md) — how the loop works step by step
- [Sequential runs](sequential-runs.md) — recovery for sequential epics
- [Parallel waves](parallel-waves.md) — recovery for parallel waves and merge conflicts
- [CLI reference](cli-reference.md) — full command reference
