---
id: S-v2-pr-bridge
title: "P1: PR Bridge (GitHub PR metadata)"
epic_id: E-v2-core
status: planned
lane: core
depends_on:
  - S-v2-merge-safe
  - S-v2-team-status
blocked_by: []
allowed_paths:
  - "packages/cli/src/commands/pr.ts"
  - "packages/cli/src/integrations/github/**"
  - "packages/core/src/schemas/integration.ts"
  - "packages/cli/src/lifecycle/runState.ts"
review_required: true
target_date: "2026-06-01"
---

## Problem

Agents generate PRs. GitHub is where they land. RK should shepherd the flow:
- Generate PR body from sprint state
- Monitor CI status
- Link back to sprint
- Post agent feedback

## Solution

Implement PR bridge commands to manage sprint ↔ PR metadata lifecycle.
Initial scope: read/write metadata (body, comments, links).
Future: watch CI, rebase, conflict resolution.

## Commands to Implement

```bash
# PR generation & linking
rk pr body <sprint-id>              # Generate PR description from sprint
rk pr body <sprint-id> --write      # Auto-generate + post to PR
rk pr link <sprint-id> <pr-url>     # Store PR URL in sprint state
rk pr sync <sprint-id>              # Sync PR state ← GitHub

# PR status & feedback
rk pr status <sprint-id>            # Show PR state (open, draft, ready, merged)
rk pr comment <sprint-id> <msg>     # Post agent comment to PR
rk pr feedback <sprint-id>          # Generate agent-review comment

# Config (future)
# rk pr config set auto-generate true
# rk pr config set rebase-strategy auto
```

## Integration: Agent → PR Flow

1. Agent finishes sprint, creates PR
2. `rk pr link S-042 https://github.com/.../pull/123`
3. `rk pr body S-042 --write` generates description from sprint
4. `rk pr comment S-042 "Agent feedback: tests passing, ready for review"`
5. (Future) Watch CI → rebase if needed → post status

## PR Body Template

```markdown
## Description

{sprint.title}

{sprint.body}

---

**Sprint:** S-042  
**Lane:** {sprint.lane}  
**Paths:** {sprint.allowed_paths}  
**Review Required:** {sprint.review_required}  

## Agent Summary

{agent output}

## Checklist

- [ ] Tests passing
- [ ] No new warnings
- [ ] Documentation updated
- [ ] Ready for review
```

## Files to Create/Modify

1. `packages/cli/src/commands/pr.ts` (new) - PR commands
2. `packages/cli/src/integrations/github/` (new) - GitHub client
3. `packages/core/src/schemas/integration.ts` - PR metadata
4. `packages/cli/src/lifecycle/prMetadata.ts` (new) - PR state tracking

## Verification

1. Create sprint, agent finishes
2. `rk pr link S-042 <pr-url>` stores URL
3. `rk pr body S-042 --write` posts description
4. `rk pr status S-042` shows correct state
5. `rk pr comment S-042 "Done"` posts to PR
6. Verify PR body includes all required info
7. Test: PR merged → sprint state updated

## Acceptance Criteria

- ✓ PR body generated correctly
- ✓ PR URL stored in sprint metadata
- ✓ Comment posts to PR
- ✓ Status syncs from GitHub
- ✓ No write conflicts
- ✓ Graceful if no GitHub token
