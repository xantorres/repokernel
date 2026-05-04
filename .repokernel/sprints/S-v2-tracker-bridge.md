---
id: S-v2-tracker-bridge
title: "P1: Tracker Bridge (Linear/Jira integration)"
epic_id: E-v2-core
status: planned
lane: core
depends_on:
  - S-v2-merge-safe
  - S-v2-team-status
blocked_by: []
allowed_paths:
  - "packages/cli/src/commands/tracker.ts"
  - "packages/cli/src/integrations/tracker/**"
  - "packages/core/src/schemas/integration.ts"
  - "packages/cli/src/lifecycle/runState.ts"
review_required: true
target_date: "2026-06-01"
---

## Problem

Teams use Linear/Jira as PM tool. RK must integrate without making tracker canonical state.
Rule: RK owns execution state; tracker is view + notification channel.

## Solution

Implement tracker bridge commands:
1. Import work: Linear issue → RK sprint
2. Sync status: RK state → tracker updates
3. Link: PR URLs → tracker for visibility

Agent never directly writes tracker—RK does, after agent completes.

## Commands to Implement

```bash
# Import from tracker
rk create sprint --from-tracker https://linear.app/issue/RK-42
rk create sprint --from-tracker --bulk <lane> <project>

# View sync status
rk tracker status <sprint-id>
rk tracker log <sprint-id>

# Update tracker
rk tracker comment <sprint-id> "Agent output: {snippet}"
rk tracker link-pr <sprint-id> <pr-url>
rk tracker transition <sprint-id> <state>

# Sync config (optional, future)
# rk tracker config set linear_project RK
# rk tracker config set auto-sync true
```

## Integration Architecture

1. **Tracker Adapters** (pluggable):
   - Linear (GraphQL)
   - Jira (REST)
   - GitHub Issues (GraphQL)

2. **Sync Metadata** (stored in RK):
   ```yaml
   tracker:
     provider: linear
     issue_id: RK-42
     sync_at: 2026-05-10T14:00:00Z
     synced_fields: [status, comment]
   ```

3. **Bidirectional (but careful)**:
   - RK → tracker: Always safe (status, links, comments)
   - tracker → RK: Import only (via `--from-tracker` cmd)

## Files to Create/Modify

1. `packages/cli/src/commands/tracker.ts` (new) - CLI commands
2. `packages/cli/src/integrations/tracker/` (new) - adapters
3. `packages/cli/src/integrations/tracker/linear.ts` - Linear impl
4. `packages/core/src/schemas/integration.ts` - Tracker metadata
5. `packages/cli/src/lifecycle/sync.ts` (new) - sync logic

## Verification

1. Create RK sprint from Linear issue → metadata stored
2. Run agent → completes
3. `rk tracker comment` posts result to Linear
4. `rk tracker link-pr` adds PR URL to Linear issue
5. Verify no write conflicts (RK is source of truth)
6. Test: tracker issue deleted externally → RK sprint unaffected

## Acceptance Criteria

- ✓ Import works: issue → sprint
- ✓ Comment works: agent output → tracker
- ✓ Link works: PR URL → tracker
- ✓ Metadata stored correctly
- ✓ No double-writes or conflicts
- ✓ Graceful degradation if tracker unavailable
