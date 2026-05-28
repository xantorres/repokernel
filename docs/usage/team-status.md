# Team status

`rk team status` is RepoKernel's answer to "what is each agent doing right now?" — a single command that joins runtime data (run files), declared state (the registry), and operational lane state into one snapshot.

## Quick start

```bash
rk team status                      # human-friendly dashboard
rk team status --json               # machine-readable; pipe into anything
rk team status --watch              # refresh every 30s (15s minimum)
rk team status --watch --interval 60
rk team status --sprint S-042       # drill into a single sprint
```

## What the dashboard shows

```
team status — 2026-05-04T13:30:00Z

Runs
RUN     EPIC      STATUS    ACTIVE  READY  REVIEW  STARTED              ETA
RUN-005 E-team-core running 3       1      1       2026-05-04 13:00:00  2026-05-04 14:12:00

Sprints
SPRINT          STATUS  LANE  AGENT  PROGRESS  TITLE
S-merge-safe    active  core  claude 67%       P0: Merge-Safe State
S-team          active  core  codex  33%       P1: Team Status Visibility
S-tracker       review  core  —      —         P1: Tracker Bridge

Registry
  health=OK  ready_to_merge=true  conflicts=0  files_changed=0

Bottlenecks
  • S-tracker: awaiting_review
  • E-team-core: 2 concurrent runs (lane saturated)
```

### Runs

Per-active-run row with:
- `STATUS` — running / paused / completed / failed / aborted
- `ACTIVE` — count of sprints currently in flight for this run
- `READY` — sprints in the queue, eligible to dispatch
- `REVIEW` — sprints awaiting a review verdict
- `STARTED` — wall-clock start time
- `ETA` — derived from elapsed time + completed-sprint count + remaining work

### Sprints

Per-sprint snapshot. The `AGENT` column resolves to whichever run owns the active claim (first-writer-wins on the join — divergence here is itself a registry-level conflict surfaced elsewhere).

`PROGRESS` is exact when `run.limit` is set, raw `N sprint(s)` otherwise. Past versions of this command reported a synthetic `~50%` for limit-less runs; that's fixed.

### Registry health

| Field | Meaning |
|---|---|
| `health` | `OK` / `DEGRADED` (P1 findings present) / `BLOCKED` (P0 or threshold-meeting findings) |
| `ready_to_merge` | `true` only when health is `OK` |
| `conflicts` | Count of P0 findings (true blockers) |
| `files_changed` | Count of files carrying findings (P0+P1+P2) — surfaces triage volume |

### Bottlenecks

A short list of conditions blocking forward progress:

- `S-NNN: awaiting_review` — review verdict outstanding
- `S-NNN: blocked_by S-MMM` — declared dependency unmet
- `E-NNN: K concurrent runs (lane saturated)` — multiple runs in flight on the same epic

## JSON output

```bash
rk team status --json | jq '.runs[] | {id: .run_id, status: .status, eta: .eta}'
```

The shape is stable and Zod-validated server-side (`TeamStatusSchema` in `@repokernel/core`). It's intentionally permissive (`z.object`, not `.strict()`) so future fields don't break consumers.

```json
{
  "timestamp": "2026-05-04T13:30:00.000Z",
  "runs": [
    {
      "run_id": "RUN-005",
      "epic_id": "E-team-core",
      "status": "running",
      "active_sprints": 3,
      "states": { "ready": 1, "active": 1, "review": 1, "merging": 0 },
      "started_at": "2026-05-04T13:00:00.000Z",
      "ended_at": null,
      "eta": "2026-05-04T14:12:00.000Z"
    }
  ],
  "sprints": [
    {
      "id": "S-merge-safe",
      "title": "P0: Merge-Safe State",
      "status": "active",
      "agent": "claude",
      "lane": "core",
      "run_id": "RUN-005",
      "progress": "67%",
      "started_at": "2026-05-04T13:00:00.000Z",
      "eta": "2026-05-04T14:12:00.000Z"
    }
  ],
  "registry": {
    "files_changed": 0,
    "conflicts": 0,
    "ready_to_merge": true,
    "health": "OK"
  },
  "bottlenecks": ["S-tracker: awaiting_review"]
}
```

## Watch mode

```bash
rk team status --watch
rk team status --watch --interval 60
```

- Default interval: 30 seconds.
- Floor: 15 seconds (re-running the validator + registry generation every tick is expensive on large projects).
- Clears the screen between iterations with `ESC[2J ESC[H` (works on dumb terminals + CI runners).
- SIGINT / SIGTERM exit cleanly; the loop's signal handlers are registered for the duration of the watch and removed on exit, so embedding hosts (tests, daemons) don't leak listeners.

For tests and embedding, the underlying `runTeamStatusCommand` accepts:

- `maxIterations: number` — bound the loop to N renders
- `sleep: (ms) => Promise<void>` — replace the wall-clock sleep with a synchronous resolver

## Composition

Internally, `getTeamStatus` is `composeTeamStatus(registry, runs, ...)`. The pure compose function is exported from `lifecycle/teamStatus.ts` so callers that already have the runs in memory (e.g. an in-process dashboard) can avoid the filesystem round-trip:

```ts
import { composeTeamStatus } from 'repokernel/lifecycle/teamStatus.js';

const status = composeTeamStatus({
  registry,         // already-generated Registry
  runs,             // Run[] you fetched however you like
  now: new Date(),
  sprintId: 'S-042' // optional filter
});
```

## See also

- [Multi-agent operations in the README](../../README.md#multi-agent-operations)
- [Merge safety](merge-safety.md)
- [Tracker bridge](trackers.md)
- [PR bridge](pr-bridge.md)
