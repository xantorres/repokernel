---
id: S-v2-advanced-dispatch
title: "P2: Advanced Dispatch (Per-state limits, stall detection, atomic claims)"
epic_id: E-v2-core
status: planned
lane: core
depends_on:
  - S-v2-merge-safe
  - S-v2-team-status
blocked_by: []
allowed_paths:
  - "packages/core/src/config/schema.ts"
  - "packages/cli/src/lifecycle/parallelRunner.ts"
  - "packages/core/src/schemas/sprint.ts"
  - "packages/core/src/schemas/run.ts"
  - "packages/cli/src/lifecycle/runState.ts"
  - "packages/cli/src/agents/external.ts"
review_required: true
target_date: "2026-06-15"
---

## Problem

Current model: global `maxConcurrentSprints` limit (e.g., 4). But bottlenecks vary:
- Triage sprints are low-risk (could run 2+)
- Implement sprints need more resources (6+)
- Review sprints are bottleneck (limit to 1)

Also: hung agents consume slots forever. No stall detection.

## Solution

Three improvements:

### 1. Per-State Concurrency Overrides

Add to config schema:
```yaml
max_concurrent_agents: 10  # global
max_concurrent_agents_by_state:
  planned: 1    # low-priority, can wait
  pending: 2    # pre-impl, light agent
  active: 6     # main work
  review: 1     # bottleneck, careful
```

Wire into wave chunking: check both global + state-specific caps before queueing.

### 2. Stall Detection + Auto-Recovery

Track `lastActivityAt` per worker. Poll every 30s:
- If no output for stalledThresholdMs (e.g., 5 min): SIGTERM agent
- Requeue sprint for retry (back to pending)
- Log stall incident for debugging

Prevents zombie agents from consuming slots.

### 3. Atomic Sprint Claim

Add `claimed_by_run_id` to sprint record. Before dispatch:
1. Acquire lock on sprint
2. Check `claimed_by_run_id` is null
3. Atomic write: set to current run ID
4. Release lock
5. Dispatch agent

Prevents collision if two runs race to claim same sprint.

## Implementation Steps

### Step 1: Config Schema

Modify `packages/core/src/config/schema.ts`:
```typescript
max_concurrent_agents_by_state?: Record<SprintStatus, number>
```

### Step 2: Parallel Runner

Modify `packages/cli/src/lifecycle/parallelRunner.ts`:
- Add `lastActivityAt` tracking per worker
- Add 30s poll checking for stalls
- On stall: SIGTERM + log
- Pass state-specific cap to wave builder

### Step 3: Sprint Claim

Modify `packages/core/src/schemas/sprint.ts`:
- Add `claimed_by_run_id?: string | null`

Modify `packages/cli/src/lifecycle/runState.ts`:
- Add `claimSprint(sprintId, runId)` → atomic acquire
- Add `releaseSprint(sprintId)` → atomic release

### Step 4: Activity Tracking

Modify `packages/cli/src/agents/external.ts`:
- On agent spawn: set `lastActivityAt = now()`
- On stdout/stderr: update `lastActivityAt = now()`
- Return `lastActivityAt` in result

## Verification

1. **Per-state limits**: Deploy with triage:2, implement:6, review:1
   - Queue 3 triage + 10 implement + 2 review sprints
   - Verify triage queue respects 2-agent cap
   - Verify implement gets 6 agents (not capped at global 4)

2. **Stall detection**:
   - Spawn agent that produces no output
   - Wait 5+ min
   - Verify agent SIGTERM'd and requeued
   - Verify slot freed for next sprint

3. **Atomic claim**:
   - Race test: spawn 2 runs, both try to claim same sprint
   - Verify only 1 succeeds
   - Verify other gets error (already claimed)

4. **Integration**: Run full workflow with all three enabled
   - No conflicts, no stalls, correct dispatch limits

## Acceptance Criteria

- ✓ Per-state caps enforced correctly
- ✓ Stall detection works (5+ min no output → terminate)
- ✓ Atomic claims prevent collision
- ✓ Dispatch respects both global + state-specific limits
- ✓ Race tests pass (no double-claims)
- ✓ Full workflow stable
