# Sprint state machine

The sprint state machine is deterministic. Lifecycle commands implement the core transitions, and validators enforce the state invariants.

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

## Transitions

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

RepoKernel enforces field invariants with validator rules and uses lifecycle commands to mutate sprint/review/queue frontmatter.

## Field invariants per state

| State | Required fields | Validator codes |
|---|---|---|
| `active` | `started_at`, `base_sha` (when `requireBaseShaForActive`) | `ACTIVE_SPRINT_MISSING_STARTED_AT`, `ACTIVE_SPRINT_MISSING_BASE_SHA` |
| `shipped` | `closed_at`, `end_sha` (when `requireEndShaForShipped`), accepted review (when `requireReviewForShipped` and `review_required`) | `SHIPPED_SPRINT_MISSING_CLOSED_AT`, `SHIPPED_SPRINT_MISSING_END_SHA`, `SHIPPED_SPRINT_MISSING_REVIEW` |

## Diff correctness rule

Review diff must always be derived from `base_sha..HEAD`, never from dates. `started_at` is metadata; `base_sha` is the diff authority. This is non-negotiable.

Lifecycle commands:

- capture `base_sha` at start (current HEAD)
- never use dates to compute diffs
- never `git add .`
- block close/review transitions on dirty or invalid lifecycle state
- block review/parallel completion on edits outside `allowed_paths` or inside `denied_paths`
