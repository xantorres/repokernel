# Config (`repokernel.config.yaml`)

The config defines project policy. It is the single source of policy truth — no project-specific behavior lives in framework code.

## Location

`repokernel.config.yaml` at the repo root (configurable via `--cwd`).

`repokernel init` creates this file with the default `.repokernel/plan/...` layout. Existing projects may use any repo-local paths by editing `paths`.

## Required top-level fields

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | Pinned to 1 in v0. Mismatch → P0. |
| `projectId` | string | Stable identifier. |
| `projectName` | string | Human-readable name. |
| `paths` | object | See below. All required. |

## `paths`

| Key | Required | Default suggestion | Purpose |
|---|---|---|---|
| `epics` | yes | `.repokernel/plan/epics` | Directory of epic markdown files. |
| `sprints` | yes | `.repokernel/plan/sprints` | Directory of sprint markdown files. |
| `reviews` | yes | `.repokernel/plan/reviews` | Directory of review markdown files. |
| `queues` | yes | `.repokernel/plan/queues` | Directory of queue lane files. |
| `lanes` | yes | `.repokernel/plan/lanes` | Directory of lane files (optional content). |
| `decisions` | no | `.repokernel/plan/decisions` | Reserved for future ADR validation. |
| `backlog` | no | `.repokernel/plan/backlog` | Reserved for future backlog parsing. |
| `generated` | yes | `.repokernel` | Generated artifacts root. |
| `registry` | yes | `.repokernel/registry.json` | Where the registry is written. |

## `policies` (optional, defaults applied)

| Key | Type | Default | Effect |
|---|---|---|---|
| `allowedStatuses` | string[] | all 8 canonical | Sprint statuses considered valid in this project. Disallowed canonical statuses produce `SPRINT_STATUS_NOT_ALLOWED`. |
| `requireReviewForShipped` | boolean | `true` | Shipped sprints with `review_required: true` must have an accepted review. |
| `requireBaseShaForActive` | boolean | `true` | Active sprints must have `base_sha`. |
| `requireEndShaForShipped` | boolean | `true` | Shipped sprints must have `end_sha`. |
| `allowMultipleActivePerLane` | boolean | `false` | If false, multiple active sprints in one lane produce `MULTIPLE_ACTIVE_SPRINTS_IN_LANE`. |
| `defaultLane` | string | `main` | Lane used by `next` and `status` when not specified. |
| `severityFailThreshold` | `P0`\|`P1`\|`P2`\|`P3` | `P1` | Findings ≥ this severity block `next` and break `validate` exit code. |

## `git` (optional, surfaced for future lifecycle commands)

| Key | Default | Notes |
|---|---|---|
| `requireCleanWorkingTreeForClose` | `true` | Will be enforced when `repokernel close` lands. |
| `blockUnassignedDirtyFiles` | `true` | Future enforcement. |
| `protectedPaths` | `[]` | Future enforcement. |

## `generated` (optional)

| Key | Default | Notes |
|---|---|---|
| `files` | `[]` | Files whose drift is tracked. Reserved. |

## Strictness

The schema is strict. Unknown top-level keys produce `CONFIG_INVALID` (P0).

For validation-style commands, if the file is missing or unreadable, the CLI exits with code `2`. `repokernel`, `repokernel status`, and `repokernel doctor` render setup guidance instead. If the file is structurally invalid, the engine returns a synthetic `CONFIG_INVALID` (P0) finding and the CLI exits `1`.

## Example

```yaml
schemaVersion: 1
projectId: my-project
projectName: My Project
paths:
  epics: .repokernel/plan/epics
  sprints: .repokernel/plan/sprints
  reviews: .repokernel/plan/reviews
  queues: .repokernel/plan/queues
  lanes: .repokernel/plan/lanes
  generated: .repokernel
  registry: .repokernel/registry.json
policies:
  defaultLane: main
  severityFailThreshold: P1
```
