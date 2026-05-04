---
id: S-v2-team-status
title: "P1: Team Status Visibility (rk team status command)"
epic_id: E-v2-core
status: planned
lane: core
depends_on:
  - S-v2-merge-safe
blocked_by: []
allowed_paths:
  - "packages/cli/src/commands/team.ts"
  - "packages/cli/src/lifecycle/runState.ts"
  - "packages/core/src/schemas/run.ts"
review_required: true
target_date: "2026-05-25"
---

## Problem

Symphony's killer value: answer "what is each agent doing?" in one command.
RK has no equivalent visibility. Users must read Git, run state files, registry—scattered.

## Solution

Implement `rk team status` command: single JSON output showing:
- Active runs (run_id, sprint_count, ready, blocked, merging states)
- Per-sprint status (id, status, agent, started_at, eta, errors)
- Registry health (files_changed, conflicts, ready_to_merge)
- Bottlenecks (what's blocking progress)

Output is dashboard-ready. Teams can:
- View real-time orchestration state
- Spot blockers immediately
- Monitor merge progress

## Commands to Implement

```bash
rk team status                  # Human-friendly table
rk team status --json           # Machine-readable
rk team status --watch          # Live updates (30s polling)
rk team status --sprint <id>    # Details for one sprint
```

## Files to Create/Modify

1. `packages/cli/src/commands/team.ts` (new) - command impl
2. `packages/cli/src/lifecycle/runState.ts` - expose state queries
3. `packages/cli/src/cli.ts` - register command
4. `packages/core/src/schemas/` - status dto/types

## Output Format

```json
{
  "timestamp": "2026-05-10T14:30:00Z",
  "runs": [
    {
      "run_id": "RUN-001",
      "status": "running",
      "active_sprints": 3,
      "states": {
        "ready": 1,
        "active": 1,
        "review": 1,
        "merging": 0
      },
      "started_at": "2026-05-10T14:00:00Z",
      "eta": "2026-05-10T15:30:00Z"
    }
  ],
  "sprints": [
    {
      "id": "S-042",
      "title": "Fix auth flow",
      "status": "active",
      "agent": "claude",
      "lane": "backend",
      "progress": "60%",
      "started_at": "2026-05-10T14:05:00Z",
      "eta": "2026-05-10T14:45:00Z"
    }
  ],
  "registry": {
    "files_changed": 12,
    "conflicts": 0,
    "ready_to_merge": true,
    "health": "OK"
  },
  "bottlenecks": [
    "S-043: awaiting_review (3 reviewers, 0 approved)"
  ]
}
```

## Verification

1. Run active agents → `rk team status --json` shows correct state
2. Verify ETA accuracy (compare to actual completion)
3. Bottleneck detection works (blocked sprint shows in output)
4. Watch mode updates every 30s
5. Human format is readable (table layout, sorted by urgency)

## Acceptance Criteria

- ✓ Command returns accurate run/sprint/registry state
- ✓ JSON output is valid, complete
- ✓ Human output is readable
- ✓ Watch mode works
- ✓ Bottleneck detection accurate
