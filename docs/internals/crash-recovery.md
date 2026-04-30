# Crash recovery: multi-file mutation gaps

This document describes the current atomicity guarantees, known failure windows in multi-file lifecycle commands, and the planned transaction journal for Phase 2.

For user-facing recovery workflows (paused runs, `rk run --resume`, stuck active sprints) see [resume-recovery.md](resume-recovery.md).

---

## Current guarantees

| Scope | Guaranteed | Mechanism |
|---|---|---|
| Single-file write | Atomic | `atomicWriteText` (temp + rename) |
| Queue slot operations | Atomic per lane | `withLockRetrying` + temp + rename |
| Multi-file sequences | **Not atomic** | Sequential `await` calls — no journal |

A crash or `SIGKILL` between two writes in a lifecycle command can leave the project in a partially mutated state. `rk fix --apply` can repair some of these mechanically; `rk validate` will flag P0/P1 findings for the rest.

---

## Failure scenarios by command

### `rk close <sprint-id>`

Mutations execute in this order:

| # | File mutated | Change | If crash here |
|---|---|---|---|
| 1 | `sprints/S-NNN.md` | `status: shipped`, `closed_at`, `end_sha` | Sprint is `shipped` but still in queue, registry stale. `rk fix` detects `SHIPPED_SPRINT_IN_QUEUE`. |
| 2 | `reviews/R-NNN.md` | `end_sha` backfill (optional — only if review lacks `end_sha`) | Review missing `end_sha`, registry stale. Low impact; cosmetic. |
| 3 | `queues/<lane>.md` | Remove slot, renumber | Sprint is `shipped`, slot present. `rk fix` detects `SHIPPED_SPRINT_IN_QUEUE` and removes the slot. |
| 4 | `.repokernel/registry.json` | `refreshRegistry` | Registry stale. `rk fix --apply` or `rk registry --write` regenerates it. |

**Current detection:** `SHIPPED_SPRINT_IN_QUEUE` finding + `rk fix --apply` covers the most common partial state (crash after step 1, before step 3). All other fragments are recoverable via `rk fix` or `rk registry --write`.

### `rk start <sprint-id>`

| # | File mutated | Change | If crash here |
|---|---|---|---|
| 1 | `queues/<lane>.md` | Append slot (only with `--enqueue`) | Slot added but sprint still `planned`. `rk validate` flags `QUEUE_SPRINT_NOT_RUNNING`. |
| 2 | `sprints/S-NNN.md` | `status: active`, `base_sha` | Sprint `active`, queue slot may or may not exist. |
| 3 | `.repokernel/registry.json` | `refreshRegistry` | Registry stale. |

### `rk cancel <sprint-id>`

| # | File mutated | Change | If crash here |
|---|---|---|---|
| 1 | `sprints/S-NNN.md` | `status: cancelled` | Sprint cancelled but still in queue. `rk fix` detects `CANCELLED_SPRINT_IN_QUEUE`. |
| 2 | `queues/<lane>.md` | Remove slot | Sprint cancelled, slot present. `rk fix --apply` removes it. |
| 3 | `.repokernel/registry.json` | `refreshRegistry` | Registry stale. |

### `rk reopen <sprint-id>`

| # | File mutated | Change | If crash here |
|---|---|---|---|
| 1 | `sprints/S-NNN.md` | `status: reopened` | Sprint reopened, registry stale. |
| 2 | `.repokernel/registry.json` | `refreshRegistry` | Registry stale. |

---

## What `rk recover` and `rk fix` cover today

`rk recover` targets **operational** corruption: orphaned worktrees, stale run records, leaked lock files. It does NOT address lifecycle-command partial mutations.

`rk fix --apply` covers these lifecycle fragments:

- `SHIPPED_SPRINT_IN_QUEUE` → removes stale queue slot
- `CANCELLED_SPRINT_IN_QUEUE` → removes stale queue slot
- Missing directories → creates them
- Missing or invalid `registry.json` → regenerates from disk state

**Gap:** No command currently detects or repairs crash between step 1 and step 2 of `rk start` (sprint becomes `active` before queue is updated), or other multi-step windows not yet mapped to validator findings.

---

## Phase 2: transaction journal design

### Goal

Make every multi-file lifecycle operation crash-safe and idempotent. On restart after a crash, `rk recover --apply` reads the journal and either completes or rolls back the partial operation.

### Proposed journal location

```
.git/repokernel/journal/
  <operation-id>.pending.json   # written BEFORE first mutation
  <operation-id>.done           # written AFTER last mutation (sentinel)
```

Using `.git/repokernel/` keeps journal files out of the tracked tree (same pattern as run records and worktrees.json). The journal directory is already the `operationalRoot`.

### Entry schema (sketch)

```json
{
  "schemaVersion": 1,
  "id": "close-S-003-1746001234567",
  "command": "close",
  "sprintId": "S-003",
  "startedAt": "2026-05-01T12:00:34.567Z",
  "mutations": [
    { "step": 1, "file": "sprints/S-003.md",          "op": "mutate-frontmatter", "patch": { "status": "shipped", "end_sha": "abc...", "closed_at": "..." }, "completedAt": null },
    { "step": 2, "file": "reviews/R-005.md",           "op": "mutate-frontmatter", "patch": { "end_sha": "abc..." },                                          "completedAt": null },
    { "step": 3, "file": "queues/main.md",             "op": "remove-queue-slot",  "sprintId": "S-003",                                                        "completedAt": null },
    { "step": 4, "file": ".repokernel/registry.json",  "op": "refresh-registry",                                                                              "completedAt": null }
  ]
}
```

Each mutation's `completedAt` is updated atomically (journal itself written with temp+rename) after the step finishes. If a crash occurs, the last `completedAt` timestamp identifies the resume point.

### Recovery protocol

On startup, `rk recover` (or a new `rk recover --replay-journal`) scans `journal/*.pending.json` files lacking a matching `*.done` sentinel:

1. **Complete forward**: apply any remaining `null`-completedAt steps in order, then write `.done`.
2. **Rollback**: reverse the completed steps in reverse order, then delete the `.pending.json`.

Forward-completion is preferred: it leaves the project in the expected post-command state and is idempotent (each step checks current file state before patching). Rollback is for steps that cannot safely be replayed (e.g., a queue slot was added and the sprint is no longer queue-eligible).

### Interface additions

```bash
rk recover --list-pending        # show any unfinished journal entries
rk recover --apply               # existing; gains journal replay step
rk recover --replay-journal      # explicit journal-only mode
```

### Implementation phases

| Phase | Scope | Scope notes |
|---|---|---|
| 2a | Journal write for `rk close` | Highest crash risk; most mutations |
| 2b | Journal write for `rk start`, `rk cancel`, `rk reopen` | Cover remaining lifecycle commands |
| 2c | `rk recover --apply` journal replay | Forward-completion path only |
| 2d | Rollback support | Reverse path, more complex |

### Options considered

| Option | Pros | Cons |
|---|---|---|
| **Journal file** (proposed) | Crash-safe by design; auditable; maps cleanly to `rk recover`; no schema changes | Adds journal write per command; complicates `rk recover` |
| In-memory transaction list | Zero file I/O overhead | Lost on crash — solves nothing |
| SQLite WAL | True ACID | Major dependency; overkill for file-based project |
| Copy-on-write snapshot | Simple to reason about | High disk I/O; copying sprint trees is wasteful |
| Idempotent re-run (current) | Already works for most cases | Requires manual intervention; not fully automated |

---

## References

- `packages/cli/src/commands/lifecycle.ts` — `runCloseCommand`, `runStartCommand`, `runCancelCommand`, `runReopenCommand`
- `packages/cli/src/lifecycle/mutate.ts` — `mutateSprintFrontmatter`, `mutateReviewFrontmatter`
- `packages/cli/src/lifecycle/atomicWrite.ts` — single-file atomicity via temp+rename
- `packages/cli/src/lifecycle/locks.ts` — per-lane locking for queue operations
- `packages/cli/src/commands/recover.ts` — current operational recovery
- [resume-recovery.md](resume-recovery.md) — user-facing recovery guide
- [#38 Transaction journal for multi-file lifecycle mutations](https://github.com/xantorres/repokernel/issues/38) — Phase 2 tracking issue
