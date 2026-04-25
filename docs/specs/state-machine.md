# Sprint state machine

The sprint state machine is deterministic. Lifecycle commands are not implemented in v0, but the validator and resolver assume the following transitions.

## States

| Status | Meaning | Runnable? |
|---|---|---|
| `planned` | Defined but not queue-ready. | No |
| `pending` | Blocked or waiting for a trigger. | No |
| `queued` | Eligible to run when dependencies are shipped. | Yes (subject to deps) |
| `active` | Currently being worked on. | Resumable (priority) |
| `review` | Implementation complete, under review. | No |
| `shipped` | Accepted and closed. | No |
| `reopened` | Returned after review or regression. | No |
| `cancelled` | Intentionally abandoned. | No |

## Transitions (intended)

```
planned  -> pending
planned  -> queued
pending  -> queued
queued   -> active        (lifecycle: start; captures base_sha + started_at)
active   -> review        (lifecycle: review; requires base_sha)
review   -> shipped       (lifecycle: close; captures end_sha + closed_at; requires accepted review)
review   -> reopened      (lifecycle: reopen)
reopened -> active
queued   -> cancelled
active   -> cancelled
shipped  -> reopened      (lifecycle: reopen for regression)
```

v0 enforces the field invariants for each state via validator rules but does not transition states itself.

## Field invariants per state

| State | Required fields | Validator codes |
|---|---|---|
| `active` | `started_at`, `base_sha` (when `requireBaseShaForActive`) | `ACTIVE_SPRINT_MISSING_STARTED_AT`, `ACTIVE_SPRINT_MISSING_BASE_SHA` |
| `shipped` | `closed_at`, `end_sha` (when `requireEndShaForShipped`), accepted review (when `requireReviewForShipped` and `review_required`) | `SHIPPED_SPRINT_MISSING_CLOSED_AT`, `SHIPPED_SPRINT_MISSING_END_SHA`, `SHIPPED_SPRINT_MISSING_REVIEW` |

## Diff correctness rule

Review diff must always be derived from `base_sha..HEAD`, never from dates. `started_at` is metadata; `base_sha` is the diff authority. This is non-negotiable.

When lifecycle commands ship in a future version, they will:

- capture `base_sha` at start (current HEAD)
- never use dates to compute diffs
- never `git add .`
- block close on dirty unrelated tracked files
- block close on edits outside `allowed_paths`
