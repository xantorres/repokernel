# Validation

## Severity

Four levels, lower numbers are more severe.

| Level | Meaning |
|---|---|
| P0 | State corruption or data loss risk. |
| P1 | Wrong work, wrong review, or wrong commit. |
| P2 | Stale planning or future collision. |
| P3 | Hygiene, formatting, consistency. |

## Threshold

`policies.severityFailThreshold` (default `P1`) controls:

- `validate` exit code (1 if any finding ≥ threshold)
- `next` global block (returns `blocked` if any finding ≥ threshold exists anywhere)

## Finding shape

Each finding is:

```ts
{
  severity: 'P0' | 'P1' | 'P2' | 'P3'
  code: string                          // SCREAMING_SNAKE_CASE
  message: string
  file?: string                         // repo-relative
  entityType?: 'sprint' | 'epic' | 'review' | 'queue' | 'lane' | 'config'
  entityId?: string
  suggestion?: string
  data?: Record<string, unknown>
}
```

Findings are sorted by `(severityRank, code, entityId, file)` for deterministic output.

## Codes

| Code | Severity | Source | Meaning |
|---|---|---|---|
| `CONFIG_INVALID` | P0 | synthetic | Config YAML parse error or schema violation. |
| `PARSER_FAILURE` | P0 | parser | File unreadable, malformed frontmatter, or schema mismatch. |
| `DUPLICATE_SPRINT_ID` | P0 | rule | Same sprint id in multiple files. |
| `DUPLICATE_EPIC_ID` | P0 | rule | Same epic id in multiple files. |
| `DUPLICATE_REVIEW_ID` | P0 | rule | Same review id in multiple files. |
| `QUEUE_REFERENCES_MISSING_SPRINT` | P1 | rule | Queue slot points to a sprint id that doesn't exist. |
| `QUEUE_SLOT_LANE_MISMATCH` | P1 | rule | Queue slot points to a sprint whose `lane` differs from the queue's lane. |
| `EPIC_REFERENCES_MISSING_SPRINT` | P1 | rule | Epic.sprints lists a sprint id that doesn't exist. |
| `DEPENDENCY_REFERENCES_MISSING_SPRINT` | P1 | rule | `sprint.depends_on` lists a sprint id that doesn't exist. |
| `DEPENDENCY_CYCLE` | P1 | rule | `depends_on` forms a cycle (Tarjan SCC). |
| `QUEUED_DEPENDENCY_NOT_SHIPPED` | P1 | rule | Queued sprint has a dependency that isn't shipped. |
| `SPRINT_STATUS_NOT_ALLOWED` | P1 | rule | Sprint status is canonical but disallowed by project policy. |
| `ACTIVE_SPRINT_MISSING_STARTED_AT` | P1 | rule | Active sprint has no `started_at`. |
| `ACTIVE_SPRINT_MISSING_BASE_SHA` | P1 | rule | Active sprint has no `base_sha`. |
| `MULTIPLE_ACTIVE_SPRINTS_IN_LANE` | P1 | rule | More than one active sprint exists in a lane while policy disallows it. |
| `SHIPPED_SPRINT_MISSING_CLOSED_AT` | P1 | rule | Shipped sprint has no `closed_at`. |
| `SHIPPED_SPRINT_MISSING_END_SHA` | P1 | rule | Shipped sprint has no `end_sha`. |
| `SHIPPED_SPRINT_MISSING_REVIEW` | P1 | rule | Shipped sprint with `review_required: true` has no accepted review. |
| `REVIEW_REFERENCES_MISSING_SPRINT` | P1 | rule | Review's `sprint_id` doesn't exist. |
| `SPRINT_REVIEW_ID_MISSING_REVIEW` | P1 | rule | Sprint's `review_id` points to a review that doesn't exist. |
| `SPRINT_REVIEW_ID_WRONG_SPRINT` | P1 | rule | Sprint's `review_id` points to a review whose `sprint_id` is different. |
| `SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED` | P1 | rule | Shipped sprint has reviews but none have `verdict: accepted`. |
| `REVIEW_BASE_SHA_MISMATCH` | P1 | rule | Sprint `base_sha` differs from its review's `base_sha`. |
| `REVIEW_END_SHA_MISMATCH` | P1 | rule | Sprint `end_sha` differs from its review's `end_sha`. |
| `SPRINT_WITHOUT_EPIC` | P1 | rule | Sprint's `epic_id` has no matching epic file. |
| `SPRINT_IN_MULTIPLE_EPICS` | P1 | rule | Sprint id appears in two or more epics' `sprints` arrays. |
| `PENDING_SPRINT_IN_QUEUE_AS_RUNNABLE` | P1 | rule | Pending sprint is in a queue slot. |
| `SHIPPED_SPRINT_IN_QUEUE` | P2 | rule | Shipped sprint is still in a queue. |
| `CANCELLED_SPRINT_IN_QUEUE` | P2 | rule | Cancelled sprint is still in a queue. |
| `ACTIVE_SPRINT_NOT_IN_QUEUE` | P2 | rule | Active sprint is not represented in any queue. Below default threshold; `next` will still return it. |
| `DUPLICATE_QUEUE_ORDER` | P2 | rule | Two slots in the same queue share an `order`. |
| `DUPLICATE_QUEUE_SLOT_ID` | P2 | rule | Two slots share a slot id. |
| `DUPLICATE_QUEUE_SPRINT` | P2 | rule | Same sprint appears more than once in one queue lane. |
| `MULTIPLE_QUEUE_FILES_FOR_LANE` | P1 | rule | Two or more queue files declare the same lane. |
| `QUEUE_FILE_LANE_MISMATCH` | P3 | rule | Queue filename stem differs from the `lane` field. |
| `QUEUE_SLOT_ORDER_GAP` | P3 | rule | Queue slot orders are not contiguous integers starting at 0. |
| `REGISTRY_DRIFT` | P2 | `registry --check` | Registry file content differs from regenerated state. |
| `UNKNOWN_FRONTMATTER_FIELD` | P3 | parser | Frontmatter key not in the schema. |
| `FILENAME_ID_MISMATCH` | P3 | parser | Filename does not contain the entity id. |

## Determinism

For the same input, validators always produce the same output: same findings, same order, byte-identical canonical JSON.
