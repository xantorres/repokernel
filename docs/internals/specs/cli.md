# CLI

The `repokernel` CLI is a thin wrapper around the core. Commands accept a global `--cwd <path>` (default: `process.cwd()`).

Running `repokernel` with no subcommand prints the same human project summary as `repokernel status`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean: no findings at or above threshold. |
| `1` | Findings at or above threshold, drift detected, or an expected blocked state. |
| `2` | Config / runtime / tool error. For `rk run`: runtime error during the loop. |

## Config error semantics

| Situation | Where it surfaces | Exit code |
|---|---|---|
| Config file missing or unreadable | Stderr message; no findings | `2` |
| Config YAML parse error | Synthetic `CONFIG_INVALID` (P0) finding | `1` |
| Config schema violation | Synthetic `CONFIG_INVALID` (P0) finding (with Zod issues in `data.issues`) | `1` |
| Filesystem error during walk | Thrown `RepoKernelError`; stderr message | `2` |

In short: **missing config = exit 2 for validation-style commands, invalid config = exit 1 with `CONFIG_INVALID`**. `repokernel`, `status`, and `doctor` render setup guidance for missing config. Other validators do not run when the config fails to load.

## `repokernel validate`

Loads the project, parses entities, builds the graph, runs validators, prints findings.

```
repokernel validate [--cwd <path>] [--json] [--fail-on P0|P1|P2|P3]
                    [--only P0|P1|P2|P3] [--min P0|P1|P2|P3]
                    [--code CODE...] [--entity ID] [--open]
```

When omitted, `--fail-on` uses `policies.severityFailThreshold` from config. If config is invalid, the fallback threshold is `P1`. Findings are sorted by `(severity, code, entityId, file)`.

Filters affect displayed findings and filtered JSON output only. The exit code always reflects full project health so hidden P0/P1 findings cannot pass validation. `--open` opens the first displayed finding's file and cannot be combined with `--json`.

JSON output:

```json
{
  "configPath": "...",
  "cwd": "...",
  "findings": [...],
  "threshold": "P1"
}
```

When filters are provided, JSON includes a `filters` object and `findings` contains only matching findings.

## `repokernel status`

Summarizes project health, sprint counts, max severity, and the next runnable sprint for the default lane. This is also the default output for bare `repokernel`.

```
repokernel status [--cwd <path>] [--json]
```

JSON output (abbreviated):

```json
{
  "blocked": false,
  "configPath": "...",
  "counts": { "active": 1, "epics": 1, "queued": 1, "reviews": 1, "shipped": 1, "sprints": 4 },
  "findingCounts": { "P0": 0, "P1": 0, "P2": 0, "P3": 0 },
  "maxSeverity": null,
  "next": { "lane": "main", "result": "runnable", "sprintId": "S-002" },
  "project": { "id": "basic", "name": "RepoKernel Basic Example" },
  "registryPath": ".repokernel/registry.json"
}
```

## `repokernel next`

Resolves the next runnable sprint.

```
repokernel next [--cwd <path>] [--json] [--lane <lane>]
```

Resolution priority:

1. If a global blocking finding exists (severity ≥ threshold), return `blocked` with the offending findings.
2. If the target lane has an `active` sprint, return it (active work has priority).
3. Otherwise walk the queue in `order` and return the first `queued` sprint whose `depends_on` are all shipped.
4. If queue exists but everything is blocked, return `blocked` with per-slot reasons.
5. Else return `none`.

Exit codes: `0` for `runnable`, `1` for `blocked` or `none`, `2` for runtime errors.

JSON output:

```json
{
  "blockers": [...],
  "lane": "main",
  "result": "runnable",
  "sprintId": "S-002"
}
```

Human output includes the selected sprint title, epic, lane, status, why it was selected, allowed paths, and queue-slot blocked reasons when no sprint is runnable.

## `repokernel doctor`

Diagnoses setup problems and exits `1` when setup is incomplete.

```
repokernel doctor [--cwd <path>]
```

Checks include config presence/validity, git repository presence, configured paths, sprint and queue files, default lane queue, registry validity, generated files, source package build artifacts when run in this repository, and example fixture availability.

## `repokernel init`

Creates a conservative default RepoKernel project layout without overwriting existing files.

```
repokernel init [--cwd <path>] [--example]
```

The default generated layout is:

```
repokernel.config.yaml
.repokernel/plan/epics/
.repokernel/plan/sprints/
.repokernel/plan/reviews/
.repokernel/plan/queues/
.repokernel/plan/lanes/
.repokernel/registry.json
```

`--example` additionally creates one epic, one shipped sprint, one active sprint, one queued sprint, one queue file, and one accepted review so `repokernel validate` and `repokernel next` work immediately.

## `repokernel inspect`

Shows a human-readable entity view.

```
repokernel inspect S-002
repokernel inspect E-001
repokernel inspect R-001
repokernel inspect main
```

Sprint inspection includes status, epic, lane, timestamps, dependency state, review state, path policy, and source file.

## `repokernel explain`

Explains a validation code.

```
repokernel explain ACTIVE_SPRINT_MISSING_BASE_SHA
```

The output includes severity, why it matters, expected state, fix guidance, and a related command when one exists.

## `repokernel open`

Opens an entity source file using `$EDITOR`, then VS Code's `code` command when available. In non-interactive contexts it prints the resolved file path.

```
repokernel open S-002
repokernel open E-001
repokernel open R-001
```

## `repokernel fix`

Previews safe mechanical fixes and separate manual suggestions. Applying fixes is intentionally unavailable in v0.

```
repokernel fix --preview
```

## `repokernel registry`

Generate, write, or check the registry.

```
repokernel registry [--cwd <path>] [--json] [--write] [--check]
```

Without flags, prints the registry as canonical JSON to stdout.

`--write` writes to `config.paths.registry` (creates parent dir if missing). Returns exit `0` on success.

`--check` compares regenerated state against the file on disk. Exit `0` if no drift, `1` with `REGISTRY_DRIFT` if content differs. Volatile metadata (`generatedAt`, `generatedBy`) is excluded from comparison.

The registry shape is documented in [`packages/core/src/schemas/registry.ts`](../../packages/core/src/schemas/registry.ts).

## `repokernel run`

Start an autonomous run for an epic. Resolves the next sprint, prepares a context packet, invokes the configured agent, validates the result, handles review, and advances to the next sprint. Repeats up to `--limit` sprints.

```
repokernel run <epic-id> [--agent <name>] [--mode assisted|autonomous]
                         [--limit <n>] [--resume <RUN-NNN>] [--dry-run]
                         [--parallel] [--sequential] [--concurrency <n>]
                         [--allow-overlap] [--cwd <path>]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--agent` | `manual` | Runner to use. Built-ins include `manual`, `fake`, `claude`, `codex`, and `ollama`; config can define additional external agents. |
| `--mode` | `assisted` | `assisted` pauses after each sprint's review step and prints the resume command. `autonomous` requires `automation.allowAutonomousClose: true` in config. |
| `--limit` | unlimited | Maximum number of sprints to execute in this run before pausing. |
| `--resume` | — | Resume an existing run by ID (e.g., `RUN-001`). Picks up from the last incomplete sprint. |
| `--dry-run` | — | Print the resolved worktree path, branch, and chain preview; exit `0` without making any changes. |
| `--parallel` | — | Assert parallel execution. The epic must declare `execution_strategy: parallel`; this flag cannot upgrade a sequential epic. |
| `--sequential` | — | Force sequential execution even if the epic declares `execution_strategy: parallel`. |
| `--concurrency` | config/default | Positive integer maximum for parallel sprints per wave, clamped by `epic.parallel_limit` when present. |
| `--allow-overlap` | — | Allow overlapping `allowed_paths` in a parallel wave. Requires `parallel.allowOverlapFlag: true`. |

**Assisted mode** — after the review step the run writes a pause record to `.git/repokernel/runs/<RUN-NNN>.json` and prints:

```
Sprint S-002 complete. Run paused.
Resume with: rk run --resume RUN-001
```

Exit code `0` on a normal assisted pause, `1` for blocked expected states, and `2` on runtime error.

**Autonomous mode** — requires `automation.allowAutonomousClose: true` in config. The run does not pause between sprints. The agent self-reviews. Use with care on epics that have comprehensive validation coverage.

**Worktree invocation guard** — `rk run` must be invoked from the main checkout, not from inside a worktree. If the CWD is detected as a managed worktree path, the command exits `1` with a descriptive error.

Dry-run output is human-readable. It includes the resolved worktree path, the epic branch (`rk/epic/<epic-id>` by default), and a chain preview scoped to the requested epic and lane.

## `repokernel runs`

List run records stored in `.git/repokernel/runs/`.

```
repokernel runs [--status running|paused|completed|failed] [--epic <epic-id>] [--json]
                [--cwd <path>]
```

Human output is a table:

```
RUN-ID   EPIC   AGENT   STATUS    SPRINTS  STARTED              HALT
RUN-001  E-001  manual  paused    2/5      2026-04-25 14:32     S-003
RUN-002  E-002  claude  completed 4/4      2026-04-24 09:10     —
```

Columns: `RUN-ID` | `EPIC` | `AGENT` | `STATUS` | `SPRINTS` | `STARTED` | `HALT` (sprint ID where the run last paused, or `—`).

JSON output is an array of run record objects matching the shape in `.git/repokernel/runs/`.

## `repokernel review-verdict`

Set the review verdict for a review entity. Used in assisted mode after the run pauses for human review.

```
repokernel review-verdict <review-id> <accepted|changes_requested|rejected> [--summary "..."]
                          [--cwd <path>]
```

Example:

```bash
rk review-verdict R-003 accepted --summary "Looks good, minor nit on error message."
```

Writes the verdict and summary to the review file frontmatter and stages the file. Does not commit. After setting a verdict, resume the paused run with `rk run --resume <RUN-NNN>`.

Exit codes: `0` on success, `1` if the review ID is not found or is already in a terminal state, `2` on runtime error.

## `repokernel lane`

Subcommands for inspecting and managing lane state and worktree assignments.

### `rk lane ls`

List all lanes with health indicators.

```
repokernel lane ls [--json] [--cwd <path>]
```

Human output:

```
LANE   HEALTH  CLAIMED_BY   DEPTH  ACTIVE    NEXT
main   ●       RUN-001      3      S-002     S-003
feat   ○       —            1      —         S-010
```

Columns: `LANE` | `HEALTH` (green dot = healthy, yellow = warnings, red = P0/P1 findings) | `CLAIMED_BY` (run ID holding the lane lock, or `—`) | `DEPTH` (queue length) | `ACTIVE` (current active sprint) | `NEXT` (next queued sprint).

`rk lanes` is an alias for `rk lane ls`.

### `rk lane acquire`

Acquire a worktree and claim the lane lock for manual use.

```
repokernel lane acquire <epic-id> [--force] [--cwd <path>]
```

Creates the worktree at `worktrees.root/<repo-directory-name>/<epic-id>/`, checks out `<worktrees.branchPrefix>epic/<epic-id>` from `worktrees.baseBranch`, and writes a lock entry to `.git/repokernel/lanes/<lane>.lock`. Fails with exit `1` if the lane is already claimed unless `--force` is passed.

### `rk lane release`

Release the worktree and unclaim the lane lock.

```
repokernel lane release <epic-id> [--force] [--cwd <path>]
```

Removes the lock entry and deletes the worktree. Refuses to proceed if the worktree has uncommitted changes, unless `--force` is passed (which discards the changes). Exit `0` on success, `1` if the lane is not claimed or the worktree is dirty without `--force`.
