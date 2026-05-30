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
| `rk task list --json` | bare array | `.[]` |
| `rk task status --json` | root `TaskAlias` | `jq '.'` |
| `rk task inspect --json` | `{ alias, paths }` | `.alias`, `.paths` |

Example: `rk ls epics --json | jq '.epics[] | .id'`

## Exit codes

Mapped from `packages/cli/src/exitCodes.ts` (sourced verbatim by the
`docs-truth` test, so this table cannot drift without breaking CI).

| Code | Constant | Meaning |
|---|---|---|
| `0`  | `EXIT_OK`               | Clean: no findings at or above threshold. |
| `1`  | `EXIT_FINDINGS` / `EXIT_BLOCKED` | Findings at/above threshold, expected project-state error (lane already claimed, review pending, etc). |
| `2`  | `EXIT_RUNTIME`          | Tool or environment error not attributable to project state (IO failure, internal assertion, unhandled exception). |
| `3`  | `EXIT_BUDGET_EXCEEDED`  | `rk context` payload exceeds the configured budget — increase budget or shrink scope. |
| `4`  | `EXIT_BUDGET_TOO_SMALL` | Budget is smaller than the essential capsule itself — raise the budget. |
| `64` | `EXIT_USAGE`            | Bad command-line invocation (unknown enum value, mutually exclusive flags, malformed numeric option). Follows `sysexits.h` so agent shells can distinguish "fix your CLI args" from `EXIT_RUNTIME`. |

Agent shells that need to disambiguate between transient runtime errors and
input mistakes should branch on `64` first, then `2` for crashes, then `1`
for project-state findings, then `3`/`4` for context-budget gates.

---

## Validation

### `rk validate`

Run validators and print findings. By default runs only `live`-scope rules — invariants on current state that are fixable now (broken refs, dependency cycles, queue presence, missing fields on active sprints, etc). `audit`-scope rules (historical hygiene on frozen state — e.g. shipped sprints missing `base_sha` / `closed_at` / `end_sha` that were not captured at close time) are opt-in via `--audit`. This keeps day-to-day validation noise-free on long-lived projects while preserving full audit visibility on demand.

```bash
rk validate [--cwd <path>] [--json] [--audit]
            [--fail-on P0|P1|P2|P3] [--only P0|P1|P2|P3] [--min P0|P1|P2|P3]
            [--code CODE...] [--entity ID] [--open]
```

| Flag | Description |
|---|---|
| `--audit` | Include `audit`-scope rules (historical hygiene on shipped/frozen state). Off by default. |
| `--fail-on` | Override severity threshold for exit code (default: `policies.severityFailThreshold`) |
| `--only` | Show only findings at this severity |
| `--min` | Show findings at this severity and above |
| `--code CODE` | Filter to a specific finding code. Repeatable. |
| `--entity ID` | Filter to a specific entity (e.g., `S-001`) |
| `--open` | Open the first finding's file in `$EDITOR`. Cannot be combined with `--json`. |
| `--json` | Machine-stable JSON output |

Filters affect displayed findings only. The exit code always reflects full project health (within the active scope — `--audit` widens the surface).

#### Validator scopes

Every validator rule is tagged with one of two scopes:

| Scope | Purpose | Examples |
|---|---|---|
| `live` (default) | Invariants on current state. Re-firing on every run is useful because the user can act now. | broken epic/sprint refs, dependency cycles, `SHIPPED_SPRINT_IN_QUEUE`, `ACTIVE_SPRINT_MISSING_BASE_SHA`, queue ordering, lane orphans |
| `audit` (opt-in) | Historical hygiene on frozen state. Re-firing forever produces noise without an actionable target — better surfaced on demand. | `SHIPPED_SPRINT_MISSING_CLOSED_AT`, `SHIPPED_SPRINT_MISSING_END_SHA`, `SHIPPED_SPRINT_MISSING_BASE_SHA`, `SHIPPED_SPRINT_MISSING_REVIEW` |

`rk report`, `rk status`, and lifecycle gates (`rk run`, `rk start`, `rk close`, etc.) all default to `live` scope. `rk fix` always runs both scopes — its job is to repair what it can find, including historical-hygiene gaps. `rk validate --audit` is the one place to widen the surface for human review.

---

### `rk status`

Project health summary: sprint counts, max severity, next sprint.

```bash
rk status [--cwd <path>] [--json]
```

Running `rk` with no subcommand is equivalent to `rk status`.

`rk status --brief` (and `--brief --json`) additionally reports per-lane
availability under `lanes[]` (`{ name, active, free }`, where `free` means no
active sprint) and a single `nextCommand` — the exact command to make progress
now (`rk run <S>`, or `rk queue add <S> --lane <L> && rk start <S>`).

---

### `rk next`

Resolve the next runnable sprint for a lane.

```bash
rk next [--cwd <path>] [--json] [--lane <lane>] [--epic <epic-id>] [--include-planned]
```

| Flag | Description |
|---|---|
| `--lane <lane>` | Restrict lookup to one lane. |
| `--epic <id>` | Restrict lookup to one epic. |
| `--include-planned` | If no queued sprint is runnable, return the next dependency-unblocked planned sprint with `result: "planned"`. |
| `--json` | Machine-stable JSON output. |

Exit `0` for `runnable` or `planned`, `1` for blocked or none, `2` for runtime errors.

---

### `rk chain preview`

Show which queued sprints would execute next in a chain run. When `--epic` is given, also lists `planned`/`pending` sprints belonging to that epic that are not yet queued — useful for pre-flight inspection before `rk start`.

`rk chain <E-NNN>` is a shorthand for `rk chain preview --epic <E-NNN>` (text output). For `--json`, `--lane`, or `--limit`, use the full `rk chain preview` form. A sprint id or other non-epic argument is rejected with a usage error.

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

### `rk plan <epic-id>`

Preview or create sprint work for an existing epic. Default mode is preview-only. Straightforward epics can be turned into one sprint and queued in one command; broad epics produce a proposed split unless `--single-sprint` overrides it.

```bash
rk plan E-001 [--create-sprint] [--enqueue] [--single-sprint] [--split] [--no-sprint]
              [--allowed-path <glob>...] [--yes] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--create-sprint` | Create a sprint when planning resolves to single-sprint mode. |
| `--enqueue` | Queue the created sprint immediately. |
| `--single-sprint` | Force one-sprint planning. |
| `--split` | Force split-preview mode. |
| `--no-sprint` | Preview without creating or proposing sprint files. |
| `--allowed-path <glob>` | Allowed path for the created sprint. Repeatable; each value is one glob (commas are literal). |

---

### `rk wave <selector>`

Preview dependency order across one or more epics. Selectors accept one id (`E-035`), comma-separated ids, or a range (`E-035..E-040`). Mutations require `--apply`.

```bash
rk wave E-035..E-040 [--apply] [--enqueue] [--json] [--cwd <path>]
```

`--apply --enqueue` queues eligible planned sprints whose dependencies are already shipped or cancelled. Blocked sprints are listed with the unmet dependency reason.

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
rk registry [--cwd <path>] [--json] [--write] [--check] [--explain]
```

| Flag | Description |
|---|---|
| (none) | Print registry as canonical JSON to stdout |
| `--write` | Write to `config.paths.registry` |
| `--check` | Compare regenerated state against file on disk. Exit `1` with `REGISTRY_DRIFT` if different. |
| `--explain` | With `--check`, print the first drift reason and suggest `rk registry --write`. |

---

## Lifecycle

### `rk start <sprint-id>`

Transition a sprint to `active`. Records `base_sha` and `started_at`.

```bash
rk start S-001 [--cwd <path>] [--worktree | --no-worktree]
```

Worktree acquisition is governed by `start.worktree` in `repokernel.config.yaml`:

- `auto` (default) — acquire an isolated sprint worktree only when RepoKernel
  owns the execution environment: not already inside a worktree, and not under
  an external agent/editor (Cursor, Claude Code, Codex, VS Code).
- `always` — always acquire, unless already inside a worktree.
- `never` — metadata-only; never acquire a worktree.

`--worktree` / `--no-worktree` override the config per-invocation. When a
worktree is acquired the sprint metadata is mutated inside it, and the worktree
path and branch are printed.

---

### `rk review <sprint-id>`

Create a review stub and transition the sprint to `review`.

```bash
rk review S-001 [--cwd <path>]
```

The generated review stub uses `automation.reviewer` for its `reviewer:` frontmatter value, falling back to `automation.defaultReviewer`.

---

### `rk review-evidence <id>`

Append command evidence to a review. The target may be a review id or a sprint id with a linked review.

```bash
rk review-evidence S-001 --label focused-tests --command "pnpm test -- filter" [--summary "..."] [--json]
rk review-evidence R-001 --label full-gates --command "rk gates S-001"
```

Evidence lands in review frontmatter as `command_evidence[]`. `rk ship` and `rk gates` record their own evidence automatically. `--exit-code` imports already-run evidence without executing the command and does not satisfy review gates.

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

The output reports structured phase timings (`precheck`, `checks`, `mutate`, `commit`) so a long unattended close shows attributable boundaries, plus a baseline-aware warning summary (`N new, M baseline-suppressed`) that distinguishes genuinely new P2/P3 findings from ones already waived in `warnings-baseline.json`. Both appear under `data.phases` and `data.warning_summary` in `--json`.

---

### `rk gate <subcommand>`

Human checkpoints that pause an autonomous run. Distinct from `rk gates` (the per-sprint check bundle below).

```bash
rk gate ls [--epic <id>] [--json] [--cwd <path>]
rk gate add <gate-name> --sprint <S-NNN> [--json] [--cwd <path>]
rk gate resolve <gate-name> [--epic <id>] [--force] [--dry-run] [--cwd <path>]
```

`rk gate add` declares a gate on planned/pending/queued sprints (repeatable `--sprint`) so a run pauses before them; a sprint that has already started is rejected. `rk gate resolve` clears the gate so the run can continue.

---

### `rk gates <sprint-id>`

Run the repo-configured gate bundle for a sprint: `automation.checksCmd` when configured, diff/path checks, `rk validate --fail-on P1`, and `rk registry --check --explain`. The command is repo-agnostic; it never hardcodes `pnpm`.

```bash
rk gates S-001 [--json] [--cwd <path>]
```

The output prints `allowed_paths` / `denied_paths` before the risky checks. If the sprint has a linked review, the command appends `command_evidence`.

---

### `rk ship <sprint-id>`

Run the boring sprint ceremony in one visible flow: `rk review`, `rk review-sprint`, accepted verdict check, `rk close`, validation, and registry check.

```bash
rk ship S-001 [--dry-run] [--skip-checks] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--dry-run` | Preview the ship flow without writing files. |
| `--skip-checks` | Bypass `automation.checksCmd` during the internal `rk close`. Use sparingly and record why. |
| `--json` | Emit step status and evidence as JSON. |

`rk ship` stops at the first failed step. Review, validation, and registry steps are appended to review `command_evidence`.

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

### `rk epic ship <epic-id>`

Close an eligible epic, then validate and registry-check the project. All sprints must already be `shipped` or `cancelled`.

```bash
rk epic ship E-001 [--dry-run] [--run-checks] [--json] [--cwd <path>]
```

Use this after the last sprint ships. It is the epic-level counterpart to `rk ship S-001`.

---

### `rk reopen <sprint-id>`

Reopen a review, shipped, or active sprint for regression or re-work. Cancelled sprints are restored to `planned` so they can be queued fresh.

```bash
rk reopen S-001 [--cwd <path>]
```

---

### `rk rebase-sprint <sprint-id>`

Realign an active sprint's recorded `base_sha` onto a git ref (default `HEAD`). Use this after out-of-band commits — a hotfix on another lane, for instance — land beneath a long-running sprint, so diff- and scope-based checks compute against the right starting point.

```bash
rk rebase-sprint S-001 [--to <ref>] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--to <ref>` | Git ref (branch, tag, or SHA) to realign onto. Default `HEAD`. |
| `--json` | Machine-stable JSON output. |

This rewrites recorded plan state only — it does **not** run a git rebase of any worktree. The sprint must be `active`. A no-op (base already at the ref) exits `0` with `changed: false`.

---

### `rk queue add <sprint-id>`

Add a sprint to a lane queue. `planned` and `reopened` sprints become `queued`; `pending` requires `--force`.

```bash
rk queue add S-001 --lane main [--force] [--json] [--cwd <path>]
```

### `rk queue remove <sprint-id>`

Remove a sprint from a lane queue. `queued` sprints return to `planned`; terminal queue cleanup leaves sprint status unchanged. Active sprints cannot be removed directly.

```bash
rk queue remove S-001 --lane main [--json] [--cwd <path>]
```

### `rk queue move <sprint-id>`

Relocate a sprint between lane queues in one step, preserving its `queued` status. This is the supported recovery path for a sprint stuck behind a busy lane: unlike `remove` + `add`, it keeps status `queued` (no `queued → planned → queued` churn) and is a single journaled operation. It appends to the target queue before removing from the source, so an interrupted move fails safe toward a recoverable duplicate (which `rk validate` flags) rather than a slot lost from both lanes; `rk recover` completes a half-applied move forward. A lane move cannot orphan dependents, so the `--cascade-dependents` machinery does not apply.

```bash
rk queue move S-001 --from main --to ui [--force] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--from <name>` | Source lane (required). |
| `--to <name>` | Target lane (required). |
| `--force` | Allow moving a `pending` sprint. |
| `--json` | Machine-stable JSON output, including a `next` command hint. |

Active sprints cannot be moved. The JSON output includes `next` (`rk start <id>`) so an agent knows the immediate follow-up.

---

## Out-of-band fixes

### `rk hotfix <description>`

Record an out-of-band fix as a fastpath task (`T-NNN`) with a backing review-skipping sprint, without a full planning cycle. Reference the `T-NNN` id in your commit, then `rk close T-NNN`.

```bash
rk hotfix "patch broken auth" [--lane <name|auto>] [--allow <glob>] [--deny <glob>] [--ac <criterion>] [--json]
```

| Flag | Description |
|---|---|
| `--lane <name\|auto>` | Lane placement. Omitted → `policies.defaultLane` (unchanged). `auto` → first free lane, else the default lane (with a note). Any other value → that named lane. |
| `--allow <glob>` | Allowed path glob (repeatable). Scopes the hotfix. With none given, the hotfix is **unscoped** and the command warns. |
| `--deny <glob>` | Denied path glob (repeatable). |
| `--ac <criterion>` | Acceptance criterion (repeatable). |
| `--json` | Machine-stable JSON output (`lane`, `laneFellBackToDefault`, `unscoped`). |

### `rk fork-hotfix-from <sprint-id> <reason>`

Spin a review-skipping hotfix off an **active** sprint without disturbing it. Common in test/E2E epics when a bug needs product code the parent sprint isn't scoped for. The hotfix lands on a free lane (so it never contends with the parent), inherits the parent's `allowed_paths` (overridable with `--allow`), records `forked_from` / `parent_base_sha`, and prints the exact follow-up: close the hotfix, then `rk rebase-sprint <parent> --to HEAD`.

```bash
rk fork-hotfix-from S-001 "engagement selector unusable" [--allow <glob>] [--deny <glob>] [--ac <criterion>] [--json]
```

It does not block, resume, or otherwise mutate the parent sprint. `--json` emits the standard envelope with `next_actions`.

---

## Fastpath task aliases

Read-only inspection commands for `T-NNN` task aliases synthesized by `rk run -m "..."`. Mutation lives in `rk run`, `rk close`, and `rk discard` — there is no `rk task close` alias.

### `rk task list`

List every task alias the project has produced. Sorted by id.

```bash
rk task list [--status active|review|shipped|cancelled] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--status` | Filter to one of `active`, `review`, `shipped`, `cancelled` |
| `--json` | Emit the raw `TaskAlias[]` array; no envelope |

### `rk task status <id>`

Show one task's status, sprint linkage, source, created/closed timestamps and (when present) a truncated `review_sha`.

```bash
rk task status T-001 [--json] [--cwd <path>]
```

`--json` emits the raw `TaskAlias` object. Accepts non-padded ids (`T-1` resolves to `T-001`).

### `rk task inspect <id>`

Same fields as `rk task status` plus the resolved on-disk paths to the alias JSON, the synthesized sprint markdown and (when available) the review markdown.

```bash
rk task inspect T-001 [--json] [--cwd <path>]
```

`--json` emits an `{ alias, paths: { alias, sprint, review } }` envelope. Inspect is diagnostic — when the project graph fails to load the command still surfaces the alias plus a `(not found)` placeholder for the sprint/review paths rather than failing the whole call.

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
rk create epic "Core parser" [--from-tracker <source>:<ref>] [--allow-tracker-fallback] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--from-tracker <ref>` | Seed title and body from an external tracker. Forms: `gh:owner/repo#NNN`, `jira:KEY-NN`, `linear:ABC-NN`. See [Tracker integration](../usage/trackers.md). |
| `--allow-tracker-fallback` | If the tracker fetch fails, create a plain epic from the positional title. Without this flag, fetch failures exit `2` before any disk write. |
| `--json` | Machine-stable JSON output. |

When `--from-tracker` is set and the fetch succeeds, the positional title is replaced with the tracker title. Linkage is recorded in `extras.external_id`, `extras.tracker_source`, `extras.tracker_url`, `extras.tracker_labels`, `extras.tracker_assignee`. Bridge failures (offline, 401, 404, 5s timeout, missing creds) emit a stderr warning and exit `EXIT_RUNTIME` (`2`) before any disk write unless `--allow-tracker-fallback` is present. Malformed `--from-tracker` values exit `EXIT_USAGE` (`64`) before any disk write.

---

### `rk create sprint --epic <epic-id> <title>`

Scaffold a sprint under an epic.

```bash
rk create sprint --epic E-001 "Parse tokens" [--lane <name>] [--status planned|pending] [--after S-NNN] [--allowed-path <glob>...] [--denied-path <glob>...] [--enqueue] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--lane` | Lane name (default: `main`) |
| `--status` | Initial status: `planned` or `pending` |
| `--after S-NNN` | Add `depends_on` for the given sprint. Repeatable; also accepts comma-separated values. |
| `--allowed-path <glob>` | Restrict the sprint to this path. Repeatable; each value is one glob (commas are literal). |
| `--denied-path <glob>` | Forbid this path inside the sprint scope. Repeatable; each value is one glob (commas are literal). |
| `--enqueue` | Create the lane queue slot and set status to `queued` in the same mutation |

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

Defaults `reviewer:` from `automation.reviewer`, falling back to `automation.defaultReviewer`; pass `--reviewer <name>` to override for this review.

---

### `rk import <file>`

Create epics and sprints in bulk from a declarative plan YAML. Ids are allocated by rk; `depends_on` is written with local aliases and resolved to real `S-NNN` ids (forward references included). The whole import is one transaction with a single registry refresh.

```bash
rk import plan.yaml [--dry-run] [--skip-existing] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--dry-run` | Print the epics/sprints that would be created (ids advisory) without writing |
| `--skip-existing` | Skip any epic whose title already exists, for idempotent re-runs |
| `--json` | Emit a `{ kind, created_epics, created_sprints, skipped_epics, ... }` envelope |

The plan schema is versioned (`schemaVersion: 1`) and strict — an unknown key fails the import. Each epic has an `alias`, `title`, optional `extras`, and `sprints[]`; each sprint has an `alias`, `title`, and optional `lane`, `status`, `depends_on`, `allowed_paths`, `denied_paths`, `adr_links`, `target_date`, `body`, and `extras`.

---

### `rk export`

Emit the current project as an import plan YAML on stdout, with `alias` set to each entity's id. `rk export > plan.yaml` then `rk import plan.yaml --skip-existing` round-trips to zero new entities.

```bash
rk export [--cwd <path>]
```

---

## Reject

### `rk reject`

Record an append-only rejection ADR for work the project has explicitly ruled
out. The pattern is compiled as a JavaScript regex and later matched against
tracker title/body during intake.

```bash
rk reject --pattern <regex> --reason <text> --scope feature|bug|enhancement [--ref <source>:<ref>] [--close] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--pattern <regex>` | Non-empty JavaScript regex. Malformed or unsafe patterns exit `EXIT_USAGE` (`64`) before any disk write. |
| `--reason <text>` | Human-readable rationale, at least 20 characters. |
| `--scope <scope>` | Rejection category: `feature`, `bug`, or `enhancement`. |
| `--ref <ref>` | Optional source issue (`gh:owner/repo#NNN`, `jira:KEY-NN`, `linear:ABC-NN`). Malformed refs exit `EXIT_USAGE` (`64`). |
| `--close` | Attempts a tracker comment plus close transition. Requires `--ref`; tracker write failures return `EXIT_RUNTIME` (`2`) while preserving the local ADR. |
| `--json` | Machine-stable JSON output with `ok`, `action`, `id`, and `tracker` status. |

Duplicate `(pattern, scope)` writes are idempotent and return the existing ADR.

---

## Hooks

### `rk path-policy <file>`

Classify a file path against the configured RepoKernel state paths. Used by the bundled `pre-tool-use.sh` hook to decide whether to deny an Edit/Write on RepoKernel-managed files. Always exits 0 and emits JSON.

```bash
rk path-policy <file> [--cwd <path>]
```

Output shape:

```json
{ "kind": "registry|run|generated|epic|sprint|queue|review|lane|none", "reason": "..." }
```

`kind: "none"` means the file is not under RepoKernel control. The `reason` field is only present for non-`none` results and is suitable to surface in a hook deny message.

---

## Reporting

### `rk report`

Print a lean project snapshot to stdout: headline (project · epic count · sprint count · health), the next runnable sprint, and sprint groups by status. Findings appear only when present; shipped/done sprints and the epic table are hidden by default. ANSI-colored on TTYs; respects `NO_COLOR`.

```bash
rk report [--all] [--json] [--cwd <path>]
```

| Flag | Description |
|---|---|
| `--all` | Include shipped/done sprints and the full epic table |
| `--json` | Emit the full structured report as canonical JSON instead of the human-readable view |

The JSON payload contains `project`, `generatedAt`, `counts`, `maxSeverity`, `next`, `epics[]`, `sprints[]`, and `findings[]` regardless of `--all`.

---

## Setup

### `rk init`

Create a default RepoKernel project layout without overwriting existing files.

```bash
rk init [--cwd <path>] [--example] [--commit] [--dir <path>]
```

`--example` creates a working project with one epic, multiple sprints, a queue, and an accepted review so that `rk validate` and `rk next` work immediately.

`--commit` commits the initialized RepoKernel metadata (`repokernel.config.yaml` and generated state) so worktree-backed commands can run from a clean main checkout.

`--dir <path>` relocates everything RepoKernel writes to a custom repo-relative base directory. The default is `.repokernel`. Layout is always `<dir>/plan/<entity>` for plan files (epics, sprints, reviews, queues, lanes), and `<dir>` itself for generated state and the registry. Example: `rk init --dir rk` writes epics to `rk/plan/epics`, registry to `rk/registry.json`, and so on. Nothing leaks into `.repokernel/` when `--dir` is set.

The bundled agent edit-block hook (`pre-tool-use.sh`) delegates path classification to `rk path-policy <file>`, so it stays correct regardless of where state files live.

---

### `rk fix`

Preview or apply safe mechanical fixes.

```bash
rk fix --preview [--cwd <path>]
rk fix --apply --yes [--cwd <path>]
```

`--apply` writes only repairs classified as safe by RepoKernel. Some findings remain manual and are printed as suggestions.

---

### `rk recover`

Audit (and optionally repair) operational state under `<git-common-dir>/repokernel/`. Detects corrupt `worktrees.json` / `RUN-NNN.json` / lane-claim files, and replays pending entries in the multi-file mutation journal.

```bash
rk recover [--preview] [--cwd <path>]                # default — list findings
rk recover --apply [--cwd <path>]                    # heal + replay journals + write recover.report.json
rk recover --dry-run                                 # alias for --preview
rk recover --journal-only [--apply]                  # skip worktrees / runs / lane-claim phases
rk recover --json                                    # JSON output
```

Journal classification (each pending journal lands in exactly one bucket):

| Classification    | Outcome                                                                                          |
|-------------------|--------------------------------------------------------------------------------------------------|
| `safe_replay`     | Replay incomplete steps from `step.content`; rename `pending → done`.                            |
| `already_applied` | Mark steps complete; rename `pending → done`. No file mutation.                                  |
| `diverged`        | Quarantine to `OP-<ulid>.unrecoverable.<ts>.<rand>.json`; surface P1 finding; non-zero exit.     |
| `unknown_schema`  | Leave pending in place; surface P1 finding; non-zero exit. Newer rk may know how to replay it.   |
| `corrupt`         | Quarantine; surface P1 finding; non-zero exit. Journal itself is unreadable or tampered.         |

After `--apply`, a structured report is written to `<opRoot>/recover.report.json` (see [json-schemas.md](json-schemas.md) for shape).

---

For deeper detail on any command, see [specs/cli.md](specs/cli.md).
