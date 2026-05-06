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

## Phase 2: transaction journal — implemented

### Goal

Every multi-file lifecycle operation is crash-safe and idempotent. On restart after a crash, `rk recover --apply` reads the journal and either replays the partial operation forward to completion, marks it already-applied, or quarantines it for operator review.

### Journal location

```
<git-common-dir>/repokernel/journal/
  OP-<ulid>.pending.json                          # written BEFORE first mutation
  OP-<ulid>.done.json                             # written AFTER closing rename (commit point)
  OP-<ulid>.unrecoverable.<isoUtc>.<rand>.json    # quarantined by `rk recover`
```

Living under `<git-common-dir>/repokernel/` keeps journals out of the tracked tree (same scope as run records and worktrees.json). It also means worktrees of the same clone share a journal directory, while different clones have independent journals.

**Scope (load-bearing).** The journal is **strictly local-clone**. It is never versioned, never travels through `git push`/`git fetch`/PR merges. Recovery promises one thing: heal the clone that crashed. Cross-clone consistency is the merge-driver's job, not the journal's.

### Entry schema

Defined in [`packages/core/src/schemas/journal.ts`](../../packages/core/src/schemas/journal.ts):

```json
{
  "schemaVersion": 1,
  "opId": "OP-01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "command": "close",
  "args": { "sprintId": "S-003" },
  "startedAt": "2026-05-01T12:00:34.567Z",
  "completedAt": null,
  "steps": [
    {
      "stepIndex": 0,
      "op": "write",
      "path": "sprints/S-003.md",
      "prevHash": "abc…",
      "nextHash": "def…",
      "content": "---\nstatus: shipped\nclosed_at: 2026-05-01T12:00:34.567Z\n…",
      "encoding": "utf8",
      "subCommand": "mutate-sprint-frontmatter",
      "startedAt": "2026-05-01T12:00:34.600Z",
      "completedAt": null
    }
  ]
}
```

`step.content` records the exact bytes the op intended to write — this is mandatory. Mutation content is often non-deterministic (timestamps, runtime IDs); without inline content, the crash-before-write window is unrecoverable. The recovery replayer verifies `sha256(content) === nextHash` before applying.

### Recovery decision matrix

`rk recover --apply` classifies each pending journal into exactly one of:

| Classification | Detection | Outcome |
|---|---|---|
| **safe_replay** | JSON parses, schema valid, content hashes match `nextHash`, every uncompleted step's `cur` matches `prevHash` | Re-run primitive with `step.content`, verify `nextHash`, mark done; rename `pending → done`. |
| **already_applied** | JSON parses, schema valid, every uncompleted step's `cur` matches `nextHash` | Mark each step `completedAt`, rename `pending → done`. No mutation. |
| **diverged** | JSON parses, but for some step `cur` matches neither `prevHash` nor `nextHash` | **Quarantine** to `.unrecoverable.<ts>.<rand>.json`, surface P1 finding, exit non-zero. |
| **unknown_schema** | JSON parses but `schemaVersion` outside the supported range | **Leave pending** in place (do not delete, do not quarantine, do not mutate target files), surface P1 finding, exit non-zero. A newer rk version may know how to replay. |
| **corrupt** | `JSON.parse` throws, schema validation fails, OR `step.content` SHA does not match `step.nextHash` | **Quarantine**, surface P1 finding, exit non-zero. The journal itself is unusable. |

Forward-completion is always possible because each step carries its content inline. Rollback would require recording pre-images of files outside the current op — not implemented; quarantine + finding + non-zero exit is the conservative substitute.

### Locking

Single global `journal-write` mutex per opRoot, acquired by every outermost `withJournal` and by `rk recover --apply`. Serializes all journaled state mutations across commands so two journals can never interleave file mutations. Existing fine-grained locks (`lane-<lane>`, `queue-<lane>`, `sprint-claim-<id>`, `wave-<runId>`, `run-<id>`) remain at their primitive call sites and are acquired inside the journal-write lock.

`AsyncLocalStorage` cooperative nesting in `withJournal` ensures that primitives invoked from inside an outer command's journal piggy-back on the outer journal — one journal file per user-facing command, regardless of nesting depth. Step-level `subCommand` records which primitive emitted each step.

### Interface

```bash
rk recover                     # default --preview: list findings, no mutation
rk recover --apply             # heal everything: replay, mark, quarantine; write recover.report.json
rk recover --dry-run           # alias for --preview
rk recover --journal-only      # skip worktrees / runs / lane-claim phases
rk recover --json              # JSON output of findings + actions
```

### Retention

`gcJournals` keeps the most recent 50 `.done.json` files (lex order = ULID monotonic time). Unrecoverable journals are kept indefinitely as forensic state.

### Schema versioning

`SUPPORTED_JOURNAL_SCHEMA_VERSIONS = [1]`. Future versions land one minor before becoming default; the v1 reader stays one minor past the v2 default per existing core schemas policy ([json-schemas.md](json-schemas.md)). Recovery refuses to apply unknown future versions — only quarantines and surfaces — so a downgrade-after-upgrade does not corrupt state.

### Operator notes

- **Secrets in journals**: the journal mirrors what state files already store on disk (sprint frontmatter, registry, run records). Nothing secret-like belongs in those files. Journals + `.done.json` retention extend the blast radius of any rule violation.
- **Locks held during recovery**: `rk recover --apply` acquires the existing `recover` lock and the new `journal-write` lock. Concurrent live `withJournal` callers wait. CI and watchdog re-triggers therefore serialize cleanly.

---

## References

- `packages/cli/src/commands/lifecycle.ts` — `runCloseCommand`, `runStartCommand`, `runCancelCommand`, `runReopenCommand`
- `packages/cli/src/lifecycle/mutate.ts` — `mutateSprintFrontmatter`, `mutateReviewFrontmatter`
- `packages/cli/src/lifecycle/atomicWrite.ts` — single-file atomicity via temp+rename
- `packages/cli/src/lifecycle/locks.ts` — per-lane locking for queue operations
- `packages/cli/src/commands/recover.ts` — current operational recovery
- [resume-recovery.md](resume-recovery.md) — user-facing recovery guide
- [#38 Transaction journal for multi-file lifecycle mutations](https://github.com/xantorres/repokernel/issues/38) — Phase 2 tracking issue
