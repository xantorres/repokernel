# Config (`repokernel.config.yaml`)

The config defines project policy. It is the single source of policy truth — no project-specific behavior lives in framework code.

## Location

`repokernel.config.yaml` at the repo root (configurable via `--cwd`).

`repokernel init` creates this file with the default `.repokernel/plan/...` layout. Existing projects may use any repo-local paths by editing `paths`.

All configured `paths` values must be repo-relative. Absolute paths, NUL bytes, and `..` path segments are rejected as `CONFIG_INVALID`.

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

## `git` (optional)

| Key | Default | Notes |
|---|---|---|
| `requireCleanWorkingTreeForClose` | `true` | `repokernel close` refuses dirty worktrees unless the caller uses an explicit escape hatch where available. |

## `generated` (optional)

| Key | Default | Notes |
|---|---|---|
| `files` | `[]` | Files whose drift is tracked. Reserved. |

## `chaining` (optional)

| Key | Type | Default | Effect |
|---|---|---|---|
| `enabled` | boolean | `false` | Enables chain preview commands. The run loop still resolves a chain internally. |
| `maxSprintsPerRun` | positive int | `1` | Default cap for chain-oriented flows. |
| `requireReviewBetweenSprints` | boolean | `true` | Requires review checkpoints between sprints. |
| `stopOnSeverity` | `P0`\|`P1`\|`P2`\|`P3` | `P1` | Severity at which chaining halts. |
| `sameEpicOnly` | boolean | `true` | Chain resolution is scoped to the requested epic by default. |
| `sameLaneOnly` | boolean | `true` | Chain resolution is scoped to the selected lane by default. |

## `worktrees` (optional)

| Key | Type | Default | Effect |
|---|---|---|---|
| `root` | string | `../.repokernel-worktrees` | Root directory for managed worktrees. May be absolute or relative to the control checkout. |
| `branchPrefix` | string | `rk/` | Prefix for managed branches. Epic branches use `<prefix>epic/<epic-id>`; sprint branches use `<prefix>sprint/<epic-id>/<sprint-id>`. |
| `baseBranch` | string | `main` | Base branch used when creating a new epic worktree branch. |
| `autoAcquire` | boolean | `true` | `rk run` automatically creates/reuses the epic worktree. |
| `branchPattern` | string | omitted | Shorthand branch template. Without `{sprintId}`, applies to epic branches; with `{sprintId}`, applies to sprint branches. Rendered refs are validated at config load. |
| `epicBranchPattern` | string | omitted | Explicit epic branch template. Cannot contain `{sprintId}` and must render to a valid non-colliding Git ref. |
| `sprintBranchPattern` | string | omitted | Explicit sprint branch template. Must contain `{sprintId}` and must render to a valid non-colliding Git ref. |

## `automation` (optional)

| Key | Type | Default | Effect |
|---|---|---|---|
| `allowAutonomousClose` | boolean | `false` | Required before `rk run --mode autonomous` may close sprints. |
| `defaultMode` | `assisted`\|`autonomous` | `assisted` | Default automation mode for generated config/UX. |
| `defaultAgent` | string | `manual` | Agent used when `rk run` is invoked without `--agent`. |

## `parallel` (optional)

| Key | Type | Default | Effect |
|---|---|---|---|
| `maxConcurrentSprints` | positive int | `4` | Default upper bound for parallel wave size. |
| `conflictStrategy` | `block` | `block` | Parallel sprints with overlapping or unconstrained `allowed_paths` are blocked unless explicitly overridden. |
| `allowOverlapFlag` | boolean | `false` | Must be true before `rk run --allow-overlap` is accepted. |

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
