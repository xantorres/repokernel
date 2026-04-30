# Config reference

RepoKernel is configured by `repokernel.config.yaml` at the root of your repository. All behavior is policy-driven — no project-specific behavior lives in framework code.

Generate the default layout:

```bash
rk init --commit
```

The schema is strict: unknown top-level keys produce a `CONFIG_INVALID` (P0) finding.

For detailed schema notes and validation rules, see [specs/config.md](specs/config.md).

---

## Top-level required fields

| Field | Type | Description |
|---|---|---|
| `schemaVersion` | `1` | Must be `1`. Mismatch produces a P0 finding. |
| `projectId` | string | Stable identifier for the project. Used in generated registry metadata. |
| `projectName` | string | Human-readable project name. |
| `paths` | object | Directory paths for each entity type. See below. |

---

## `paths`

All paths must be repo-relative. Absolute paths, `..` segments, and NUL bytes are rejected as `CONFIG_INVALID`.

| Key | Required | Default suggestion | Purpose |
|---|---|---|---|
| `epics` | yes | `.repokernel/plan/epics` | Directory of epic Markdown files |
| `sprints` | yes | `.repokernel/plan/sprints` | Directory of sprint Markdown files |
| `reviews` | yes | `.repokernel/plan/reviews` | Directory of review Markdown files |
| `queues` | yes | `.repokernel/plan/queues` | Directory of queue lane files |
| `lanes` | yes | `.repokernel/plan/lanes` | Directory of lane files |
| `generated` | yes | `.repokernel` | Root directory for generated artifacts |
| `registry` | yes | `.repokernel/registry.json` | Path where the registry file is written |
| `decisions` | no | `.repokernel/plan/decisions` | Reserved for future ADR validation |

---

## `policies`

All fields are optional. Defaults are applied when omitted.

| Field | Type | Default | Description |
|---|---|---|---|
| `allowedStatuses` | string[] | all 8 canonical | Sprint statuses valid in this project. Unlisted canonical statuses produce `SPRINT_STATUS_NOT_ALLOWED`. |
| `requireReviewForShipped` | boolean | `true` | Shipped sprints with `review_required: true` must have an accepted review. |
| `requireBaseShaForActive` | boolean | `true` | Active sprints must have `base_sha`. |
| `requireEndShaForShipped` | boolean | `true` | Shipped sprints must have `end_sha`. |
| `allowMultipleActivePerLane` | boolean | `false` | If `false`, multiple active sprints in one lane produce `MULTIPLE_ACTIVE_SPRINTS_IN_LANE`. |
| `defaultLane` | string | `main` | Lane used by `rk next` and `rk status` when not specified. |
| `severityFailThreshold` | `P0`\|`P1`\|`P2`\|`P3` | `P1` | Findings at or above this severity block `rk next` and cause `rk validate` to exit `1`. |

---

## `git`

| Field | Type | Default | Description |
|---|---|---|---|
| `requireCleanWorkingTreeForClose` | boolean | `true` | `rk close` refuses dirty worktrees. |

---

## `worktrees`

| Field | Type | Default | Description |
|---|---|---|---|
| `root` | string | `../.repokernel-worktrees` | Root directory for managed worktrees. May be absolute or relative to the main checkout. |
| `branchPrefix` | string | `rk/` | Prefix for managed branches. Epic branches: `<prefix>epic/<epic-id>`. Sprint branches: `<prefix>sprint/<epic-id>/<sprint-id>`. |
| `baseBranch` | string | `main` | Branch used as the base when creating a new epic worktree. |
| `autoAcquire` | boolean | `true` | `rk run` creates or reuses the epic worktree automatically. |
| `branchPattern` | string \| omitted | omitted | Compatibility shorthand. Without `{sprintId}`, applies to epic branches only. With `{sprintId}`, applies to sprint branches only. See below. |
| `epicBranchPattern` | string \| omitted | omitted | Explicit epic branch template. Cannot contain `{sprintId}`. |
| `sprintBranchPattern` | string \| omitted | omitted | Explicit sprint branch template. Must contain `{sprintId}`. |

### `branchPattern`

Optional template strings for managed worktree branch refs. When omitted, defaults apply unchanged:

- Epic branch: `{branchPrefix}epic/{epicId}`.
- Sprint branch: `{branchPrefix}sprint/{epicId}/{sprintId}`.

Prefer explicit `epicBranchPattern` + `sprintBranchPattern` for team-specific naming. `branchPattern` remains as shorthand:

- If it does not contain `{sprintId}`, it applies to epic branches only; sprint branches keep the default unless `sprintBranchPattern` is set.
- If it contains `{sprintId}`, it applies to sprint branches only; epic branches keep the default unless `epicBranchPattern` is set.

**Supported tokens (v1.13):**

| Token | Replaced with | Notes |
|---|---|---|
| `{branchPrefix}` | `worktrees.branchPrefix` (default `rk/`) | Verbatim. |
| `{epicId}` | Epic ID, e.g. `E-001` | Always available. |
| `{sprintId}` | Sprint ID, e.g. `S-003` | Sprint-level helper only. `epicBranchPattern` cannot use it; `sprintBranchPattern` must use it. |

**Reserved for v1.14 (rejected at render time):**

| Token | Future meaning |
|---|---|
| `{ticket}` | Resolves from `epic.extras.external_id` written by `rk create epic --from-tracker`. |
| `{slug}` | Kebab-cased epic title, capped at 40 chars. |

**Validation rules** (enforced at config load via Zod refinement):

- Non-empty string.
- No whitespace, NUL, or other ASCII control characters in static segments.
- Forbidden sequences: `..`, `//`, `\\`, `@{`, leading `/`, trailing `/`, trailing `.`, trailing `.lock`.
- Forbidden characters in static segments: `~`, `^`, `:`, `?`, `*`, `[`, `]`.
- Token braces (`{...}`) must be matched. Unmatched `{` or `}` rejected.

RepoKernel also renders representative epic and sprint refs at config load and validates the final Git ref strings. This catches unsafe `branchPrefix` values, dot-prefixed path components, `.lock` components, accidental double slashes after token substitution, and epic/sprint ref collisions such as `feature/E-001` plus `feature/E-001/S-001`.

**Examples:**

```yaml
worktrees:
  branchPattern: "feature/{epicId}"
# epic worktree branch: feature/E-001
# sprint worktree branch: rk/sprint/E-001/S-003
```

```yaml
worktrees:
  branchPattern: "wip/{epicId}/{sprintId}"
# epic worktree branch: rk/epic/E-001
# sprint worktree branch: wip/E-001/S-003
```

```yaml
worktrees:
  epicBranchPattern: "feature/epic/{epicId}"
  sprintBranchPattern: "feature/sprint/{epicId}/{sprintId}"
# epic worktree branch: feature/epic/E-001
# sprint worktree branch: feature/sprint/E-001/S-003
```

**Caveats:**

- A pattern change mid-project does NOT rename existing branches. New worktree acquisitions use the new pattern; existing `rk/epic/E-001` style branches stay until manually renamed.
- Git cannot store both `feature/E-001` and `feature/E-001/S-001` as branches because one ref path is a prefix of the other. Use distinct namespaces such as `feature/epic/...` and `feature/sprint/...`.
- Keep `{branchPrefix}` in custom patterns (or use another static managed prefix) to maintain a namespace listable by `git branch | grep ^rk/`.

See [Worktrees](worktrees.md) for the full worktree lifecycle.

---

## `automation`

| Field | Type | Default | Description |
|---|---|---|---|
| `allowAutonomousClose` | boolean | `false` | Must be `true` before `rk run --mode autonomous` can close sprints without human review. |
| `defaultMode` | `assisted`\|`autonomous` | `assisted` | Default automation mode. |
| `defaultAgent` | string | `manual` | Agent used when `rk run` is invoked without `--agent`. |
| `checksCmd` | string | — | Shell command run by `rk epic close --run-checks` before marking the epic done. Non-zero exit blocks the close. Example: `"pnpm lint && pnpm type-check && pnpm test && pnpm build"`. |

---

## `parallel`

| Field | Type | Default | Description |
|---|---|---|---|
| `maxConcurrentSprints` | positive int | `4` | Default upper bound for sprints per wave. |
| `conflictStrategy` | `block` | `block` | Parallel sprints with overlapping `allowed_paths` are blocked. The only supported value is `block`. |
| `allowOverlapFlag` | boolean | `false` | Must be `true` before `rk run --allow-overlap` is accepted. |

See [Parallel waves](parallel-waves.md) for usage.

---

## `chaining`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Enables chain preview commands. |
| `maxSprintsPerRun` | positive int | `1` | Default cap for chain-oriented flows. |
| `requireReviewBetweenSprints` | boolean | `true` | Requires review checkpoints between sprints. |
| `stopOnSeverity` | `P0`\|`P1`\|`P2`\|`P3` | `P1` | Severity at which chaining halts. |
| `sameEpicOnly` | boolean | `true` | Chain resolution is scoped to the target epic. |
| `sameLaneOnly` | boolean | `true` | Chain resolution is scoped to the selected lane. |

---

## `agents`

Define external agent adapters. Each key under `agents` becomes a valid `--agent` name.

```yaml
agents:
  my-agent:
    command: ./scripts/run-agent.sh
    args:
      - "{packet_path}"
      - "{worktree}"
    resultFormat: sentinel-json
    timeoutSeconds: 1800
```

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | string | yes | Path to the executable or script |
| `args` | string[] | no | Arguments passed to the command. Supports placeholders (see below). |
| `resultFormat` | string | yes | Must be `sentinel-json` |
| `timeoutSeconds` | positive int | no | Seconds before the agent process is killed (default: 1800) |

**Arg placeholders:**

| Placeholder | Value |
|---|---|
| `{packet_path}` | Absolute path to the context packet JSON |
| `{worktree}` | Absolute path to the agent's working directory |
| `{sprint_id}` | Sprint ID (e.g., `S-001`) |
| `{run_id}` | Run ID (e.g., `RUN-001`) |
| `{epic_id}` | Epic ID (e.g., `E-001`) |
| `{op_root}` | Root of the main checkout |
| `{registry_path}` | Absolute path to `registry.json` |
| `{mode}` | `assisted` or `autonomous` |

See [Agent adapters](agent-adapters.md) for usage.

---

## Minimal example

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

## Full example

```yaml
schemaVersion: 1
projectId: my-project
projectName: My Project

paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json

policies:
  allowedStatuses:
    - planned
    - pending
    - queued
    - active
    - review
    - shipped
    - reopened
    - cancelled
  requireReviewForShipped: true
  requireBaseShaForActive: true
  requireEndShaForShipped: true
  allowMultipleActivePerLane: false
  defaultLane: main
  severityFailThreshold: P1

git:
  requireCleanWorkingTreeForClose: true

worktrees:
  root: ../.repokernel-worktrees
  branchPrefix: rk/
  baseBranch: main
  autoAcquire: true

automation:
  allowAutonomousClose: false
  defaultMode: assisted
  defaultAgent: manual

parallel:
  maxConcurrentSprints: 4
  conflictStrategy: block
  allowOverlapFlag: false

chaining:
  enabled: false
  maxSprintsPerRun: 1
  requireReviewBetweenSprints: true
  stopOnSeverity: P1
  sameEpicOnly: true
  sameLaneOnly: true

agents:
  my-agent:
    command: ./scripts/run-agent.sh
    args:
      - "{packet_path}"
      - "{worktree}"
    resultFormat: sentinel-json
    timeoutSeconds: 1800
```

---

For the authoritative schema definition and strictness rules, see [specs/config.md](specs/config.md).
