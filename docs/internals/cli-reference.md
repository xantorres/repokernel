# CLI reference

`rk` and `repokernel` are aliases for the same binary. All commands accept `--cwd <path>` (default: current directory).

Use `rk --version` or `rk -v` to print the installed version.

## JSON output envelope

Commands that accept `--json` return a **typed envelope**, not a bare array. The top-level key matches the entity type:

| Command | Top-level key | `jq` accessor |
|---|---|---|
| `rk ls epics --json` | `"epics"` | `.epics[]` |
| `rk ls sprints --json` | `"sprints"` | `.sprints[]` |
| `rk ls reviews --json` | `"reviews"` | `.reviews[]` |
| `rk ls lanes --json` | `"lanes"` | `.lanes[]` |
| `rk validate --json` | `"findings"` | `.findings[]` |
| `rk registry --json` | root object | `jq '.'` |

Example: `rk ls epics --json | jq '.epics[] | .id'`

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean: no findings at or above threshold |
| `1` | Findings at/above threshold, blocked state, or expected failure |
| `2` | Config or runtime error |

---

## Validation

### `rk validate`

Run all validators and print findings.

```bash
rk validate [--cwd <path>] [--json]
            [--fail-on P0|P1|P2|P3] [--only P0|P1|P2|P3] [--min P0|P1|P2|P3]
            [--code CODE...] [--entity ID] [--open]
```

| Flag | Description |
|---|---|
| `--fail-on` | Override severity threshold for exit code (default: `policies.severityFailThreshold`) |
| `--only` | Show only findings at this severity |
| `--min` | Show findings at this severity and above |
| `--code CODE` | Filter to a specific finding code. Repeatable. |
| `--entity ID` | Filter to a specific entity (e.g., `S-001`) |
| `--open` | Open the first finding's file in `$EDITOR`. Cannot be combined with `--json`. |
| `--json` | Machine-stable JSON output |

Filters affect displayed findings only. The exit code always reflects full project health.

---

### `rk status`

Project health summary: sprint counts, max severity, next sprint.

```bash
rk status [--cwd <path>] [--json]
```

Running `rk` with no subcommand is equivalent to `rk status`.

---

### `rk next`

Resolve the next runnable sprint for a lane.

```bash
rk next [--cwd <path>] [--json] [--lane <lane>]
```

Exit `0` for runnable, `1` for blocked or none, `2` for runtime errors.

---

### `rk chain preview`

Show which queued sprints would execute next in a chain run. When `--epic` is given, also lists `planned`/`pending` sprints belonging to that epic that are not yet queued — useful for pre-flight inspection before `rk start`.

```bash
rk chain preview [--lane <lane>] [--epic <epic-id>] [--limit N]
                 [--ignore-disabled] [--json] [--cwd <path>]
```

| Flag | Default | Description |
|---|---|---|
| `--lane` | default lane | Restrict preview to this lane |
| `--epic <id>` | — | Filter chain to sprints in this epic; also shows planned sprints for the epic |
| `--limit N` | `5` | Max sprints to show |
| `--ignore-disabled` | false | Show preview even when `chaining.enabled: false` |

JSON output includes `planned_for_epic` array (non-empty only when `--epic` is given):

```json
{
  "chain": [...],
  "ineligible": [...],
  "planned_for_epic": [{ "id": "S-012", "status": "planned", ... }]
}
```

---

### `rk doctor`

Diagnose setup problems: config, git, paths, queues, registry.

```bash
rk doctor [--cwd <path>]
```

Exits `1` when setup is incomplete.

---

### `rk validate` finding codes

Use `rk explain` to look up any code:

```bash
rk explain ACTIVE_SPRINT_MISSING_BASE_SHA
```

See [specs/validation.md](specs/validation.md) for the full code list.

---

### `rk inspect <id>`

Show entity details.

```bash
rk inspect S-001
rk inspect E-001
rk inspect R-001
rk inspect main       # lane
```

Sprint inspection includes status, epic, lane, timestamps, dependency state, review state, and path policy.

---

### `rk explain <CODE>`

Explain a validation finding code.

```bash
rk explain QUEUED_DEPENDENCY_NOT_SHIPPED
```

Output: severity, why it matters, expected state, fix guidance, related command.

---

### `rk registry`

Generate, write, or check the registry.

```bash
rk registry [--cwd <path>] [--json] [--write] [--check]
```

| Flag | Description |
|---|---|
| (none) | Print registry as canonical JSON to stdout |
| `--write` | Write to `config.paths.registry` |
| `--check` | Compare regenerated state against file on disk. Exit `1` with `REGISTRY_DRIFT` if different. |

---

## Lifecycle

### `rk start <sprint-id>`

Transition a sprint to `active`. Records `base_sha` and `started_at`.

```bash
rk start S-001 [--cwd <path>]
```

---

### `rk review <sprint-id>`

Create a review stub and transition the sprint to `review`.

```bash
rk review S-001 [--cwd <path>]
```

---

### `rk review-verdict <review-id> <verdict>`

Set the verdict on a review entity.

```bash
rk review-verdict R-001 accepted [--summary "..."] [--cwd <path>]
rk review-verdict R-001 changes_requested
rk review-verdict R-001 rejected
```

Verdicts: `accepted`, `changes_requested`, `rejected`.

Writes the verdict to frontmatter and stages the file. Does not commit. After setting a verdict, resume the paused run with `rk run --resume RUN-NNN`.

Exit `0` on success, `1` if the review ID is not found or already terminal, `2` on runtime error.

---

### `rk close <sprint-id>`

Close a sprint (transition to `shipped`). Records `end_sha` and `closed_at`. Requires an accepted review when `review_required: true`.

```bash
rk close S-001 [--cwd <path>]
```

---

### `rk epic close <epic-id>`

Close an epic (transition to `done`). Records `closed_at`. All sprints must be `shipped` or `cancelled` unless `--force` is passed.

```bash
rk epic close E-001 [--dry-run] [--force] [--run-checks] [--checks-cmd <cmd>] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--dry-run` | Preview the mutation without writing files |
| `--force` | Close even if some sprints are not yet shipped |
| `--run-checks` | Run check command before closing; blocks if non-zero exit |
| `--checks-cmd <cmd>` | Override check command (default: `automation.checksCmd` from config) |

Exit `0` on success, `1` if blocked (sprints not yet shipped, checks failed, or epic already `done`/`cancelled`), `2` on runtime error. Epics in `on_hold` or `planned` can be closed directly.

Passing `E-NNN` to `rk close`, `rk start`, `rk review`, or `rk reopen` now returns a helpful error directing to the correct command rather than a generic "sprint not found".

---

### `rk reopen <sprint-id>`

Reopen a shipped sprint for regression or re-work.

```bash
rk reopen S-001 [--cwd <path>]
```

---

## Run orchestrator

### `rk run <epic-id>`

Start or resume an autonomous run loop for an epic.

```bash
rk run <epic-id> [--agent <name>] [--mode assisted|autonomous]
                 [--limit N] [--resume RUN-NNN] [--dry-run]
                 [--parallel] [--sequential] [--concurrency N]
                 [--lane <name>] [--allow-overlap]
                 [--worktree] [--cwd <path>]
```

| Flag | Default | Description |
|---|---|---|
| `--agent` | `manual` | Agent to use: `fake`, `manual`, `claude`, `codex`, `ollama`, or a config-defined name |
| `--mode` | `assisted` | `assisted` pauses for human review; `autonomous` requires `allowAutonomousClose: true` |
| `--limit N` | unlimited | Stop after N sprints |
| `--resume RUN-NNN` | — | Resume a paused run |
| `--dry-run` | — | Preview without executing |
| `--parallel` | — | Assert parallel execution (epic must declare `execution_strategy: parallel`) |
| `--sequential` | — | Force sequential even on a parallel epic |
| `--concurrency N` | config | Max sprints per wave |
| `--lane <name>` | config default | Override the target lane |
| `--allow-overlap` | — | Allow overlapping `allowed_paths` (requires `parallel.allowOverlapFlag: true`) |
| `--worktree` | — | Force worktree isolation for sequential runs |

---

### `rk runs`

List run records.

```bash
rk runs [--status running|paused|completed|failed] [--epic <epic-id>] [--json] [--cwd <path>]
```

---

### `rk run inspect <run-id>`

Show run state and next steps.

```bash
rk run inspect RUN-001 [--cwd <path>]
```

---

### `rk run logs <run-id> [sprint-id]`

Show logs for a run or a specific sprint within a run.

```bash
rk run logs RUN-001
rk run logs RUN-001 S-002
```

---

### `rk run abort <run-id>`

Abort a paused run. Removes the run record. Sprint statuses are not changed.

```bash
rk run abort RUN-001 [--cwd <path>]
```

---

## Lane management

### `rk lane ls` / `rk lanes`

List all lanes with health, lock, queue depth, active sprint, and next sprint.

```bash
rk lane ls [--json] [--cwd <path>]
rk lanes   [--json] [--cwd <path>]
```

---

### `rk lane acquire <epic-id>`

Create a worktree and claim the lane lock for manual use.

```bash
rk lane acquire <epic-id> [--force] [--cwd <path>]
```

---

### `rk lane release <epic-id>`

Delete the worktree and release the lane lock.

```bash
rk lane release <epic-id> [--force] [--cwd <path>]
```

`--force` discards uncommitted changes in the worktree.

---

## Create

### `rk create epic <title>`

Scaffold a new epic file.

```bash
rk create epic "Core parser" [--cwd <path>]
```

---

### `rk create sprint --epic <epic-id> <title>`

Scaffold a sprint under an epic.

```bash
rk create sprint --epic E-001 "Parse tokens" [--lane <name>] [--status planned|pending] [--after S-NNN] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--lane` | Lane name (default: `main`) |
| `--status` | Initial status: `planned` or `pending` |
| `--after S-NNN` | Add `depends_on` for the given sprint |

---

### `rk create queue --lane <name>`

Scaffold a queue file for a lane.

```bash
rk create queue --lane main [--cwd <path>]
```

---

### `rk create review --sprint <sprint-id>`

Scaffold a review file for a sprint.

```bash
rk create review --sprint S-001 [--cwd <path>]
```

---

## Setup

### `rk init`

Create a default RepoKernel project layout without overwriting existing files.

```bash
rk init [--cwd <path>] [--example]
```

`--example` creates a working project with one epic, multiple sprints, a queue, and an accepted review so that `rk validate` and `rk next` work immediately.

---

### `rk fix`

Preview safe mechanical fixes.

```bash
rk fix --preview [--cwd <path>]
```

Applying fixes is unavailable in v0.

---

For deeper detail on any command, see [specs/cli.md](specs/cli.md).
