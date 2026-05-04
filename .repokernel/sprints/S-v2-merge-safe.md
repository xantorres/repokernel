---
id: S-v2-merge-safe
title: "P0: Merge-Safe State (Registry Conflict Resolution)"
epic_id: E-v2-core
status: planned
lane: core
depends_on: []
blocked_by: []
allowed_paths:
  - "packages/core/src/schemas/registry.ts"
  - "packages/core/src/schemas/sprint.ts"
  - "packages/cli/src/lifecycle/registry/**"
  - "packages/cli/src/lifecycle/atomicWrite.ts"
  - "packages/core/src/graph/**"
review_required: true
target_date: "2026-05-18"
adr_links:
  - "docs/internals/adr-planning-storage.md"
---

## Problem

Currently, if two agents write `.repokernel/registry.json` concurrently:
- Git conflict on merge
- Manual resolution required
- Team workflow breaks

Symphony's tracker-as-truth model avoids this. RK must solve it to stay viable.

## Solution

Implement deterministic merge strategy for registry state:

### 1. Conflict Resolution Logic
Add merge helper for `registry.json`:
- Per-file conflict detection (compare base, local, remote)
- Deterministic resolution (e.g., sort by sprint ID, keep higher priority)
- Validate merged state is consistent (no orphaned references)
- Test: two agents modify registry concurrently → merge cleanly

### 2. Sprint Record Format
Ensure sprint records are merge-safe:
- Immutable sprint ID (no rename collisions)
- Status transitions are additive (no lost state)
- Depends_on/blocked_by are sets (no duplication)

### 3. Validation on Merge
After merge: run full registry validation:
- All sprint refs resolve
- No circular dependencies
- No orphaned review IDs
- Generated paths don't conflict

## Files to Modify

1. `packages/core/src/schemas/registry.ts` - add merge conflict handler
2. `packages/cli/src/lifecycle/registry/` - validation + merge logic
3. `packages/cli/src/lifecycle/atomicWrite.ts` - conflict resolution hook
4. `packages/core/src/graph/` - dependency checks on merge

## Verification

1. Two feature branches: `feature-1` (agent-A), `feature-2` (agent-B)
2. Both modify `.repokernel/registry.json` independently
3. Merge `feature-1 → feature-2`
4. No manual conflict resolution needed
5. Registry validates clean, no lost state
6. Run `rk doctor` on merged state → no errors

## Acceptance Criteria

- ✓ Registry merges without conflict
- ✓ Validation passes post-merge
- ✓ Test: 5+ concurrent agent edits → clean merge
- ✓ Zero lost sprint state after merge
