# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`rk review-aggregate` — compute the panel verdict (GREEN/YELLOW/RED) outside `rk review-sprint`.** Wraps the existing `aggregateVerdict()` helper as a top-level CLI command so downstream protocol authors building their own multi-agent panels can ask RepoKernel for the canonical RED-dominant aggregate without re-implementing the rule. Two modes: `rk review-aggregate <SPRINT_ID>` reads the latest panel run from the sprint's review and returns its aggregate; `rk review-aggregate --verdicts GREEN,YELLOW,RED` aggregates an inline list with no project context required. Flags: `--json` emits a structured envelope (`aggregate`, `source`, `sprint_id`, `review_id`, `round`, `reviewers[]`); `--fail-on <GREEN|YELLOW|RED>` returns `EXIT_FINDINGS` when the aggregate is at least this severe, for shell-pipeline gating.
- **`rk brief` — render a markdown action-handoff brief from sprint or epic state.** Closes the pause-gate brief gap noted in downstream protocol audits. Sprint mode auto-detects the gate from current state — `review-fail` (verdict is `changes_requested` or `rejected`), `ready-to-close` (`accepted`), `pause` (`pending`), `blocked` (unshipped `depends_on`), or `status` (default) — and renders a templated markdown brief including the latest panel-run breakdown, findings, and a fenced "Suggested next action" with the exact `rk` command to unstick the gate. Epic mode renders the sprint table with per-row status, progress fraction, the next runnable sprint, and the suggested next action (`rk start`, `rk next`, or `rk epic close` depending on completion state). Flags: `--gate <type>` forces a specific template; `--json` emits a structured envelope including the markdown.
- **`rk scaffold command <name>` — generate the canonical `.claude/commands/<name>.md` + optional `.agents/protocol/<name>.md` skeleton pair.** Removes the boilerplate every downstream consumer otherwise writes by hand. Output is intentionally vendor-agnostic — the command file records the caller's abstract tier (e.g. `orchestrate`, `fast`, `synthesis`) as a comment, not a `model:` field; consumers add `model:` per their harness's tier-to-model mapping after scaffolding. The `vendorAgnostic` CI guard in `@repokernel/core` ensures no vendor model identifier (haiku/sonnet/opus/gpt-N/claude-N) leaks into the runtime source. Flags: `--description`, `--arg-hint`, `--tier`, `--with-protocol`, `--commands-dir`, `--protocol-dir`, `--force`, `--json`. Naming is enforced kebab-case for filesystem and slash-command-surface portability. Files refuse to overwrite by default; `--force` opts in.
- **`docs/recipes/protocol-layer.md` — cookbook for project-owned orchestration on top of `rk`.** Reference walkthrough for downstream consumers building their `.agents/protocol/*.md` + `.claude/commands/*.md` layer. Covers why `rk` intentionally does not ship project-specific orchestration (multi-agent panels, founder-action briefs, chained-epic loops), the two-layer commands+protocols pattern with the canonical 1-line command body, anatomy of both file types, worked examples using the new `rk review-aggregate` and `rk brief` helpers, the chained-epic sub-agent spawn pattern with halt conditions, anti-patterns, and how the recipe relates to the operator skill. Plus `docs/recipes/README.md` as the recipe index.

### Changed

- **Lifecycle verbs reordered (plan first) in README and the bundled plugin skill.** Both surfaces previously listed the six verbs in implementation order (`status, next, run, review, doctor, plan`), placing `plan` last despite being the first verb a new user should reach for. Reordered to lifecycle order — `plan` first (scope work before anything else), `doctor` last (diagnostic, not lifecycle): `plan → status → next → run → review → doctor`.

## [1.8.0] - 2026-04-29

### Added

- **Cost-aware agent routing — `rk route` and `rk context --with-routing`.** RepoKernel now ships a deterministic recommender that picks an abstract agent tier (`light` / `standard` / `heavy` by default; consumer-overridable) for any sprint or epic from frontmatter + context state. RK is **agent- and vendor-agnostic by hard contract** — no model-vendor strings (`haiku`, `sonnet`, `opus`, `gpt-N`, `llama-N`, `claude-<id>`) appear in `packages/core` or `packages/cli`; the mapping from tier → concrete model ID lives in the consumer's skill or config. A CI grep guard (`packages/core/test/vendorAgnostic.test.ts`) keeps it that way.
- **New CLI surfaces.** `rk route <ID> [--profile <p>]` returns a JSON payload with `routing_hint` (tier, tier_set, reason, rule_id, fanout, signals, score). `rk context <ID> --with-routing` embeds the same hint in the full packet. Both call the same resolver — same answer, two surfaces. `rk route` is fast (<50ms) and skips the packet body for dispatcher use; `--with-routing` keeps the full packet for agents that need both at once.
- **Resolution order (first match wins).** (1) `extras.routing.pin_tier` — hard override; (2) `routing.rules` config policy — first match wins, AND across keys; (3) `extras.routing.prefer_tier` — soft hint; (4) `extras.routing.complexity` — `trivial|standard|deep` mapped ordinally into the configured tier list (vendor-agnostic); (5) score-based fallback over four signals: profile, estimated_tokens, allowed_paths_count, depends_on_count. The `score` integer plus full `tier_set` are exposed in every hint so threshold drift is auditable.
- **Project-level routing policy in `repokernel.config.yaml`.** Optional `routing.tiers` (length 2–8, unique, ordered cheap → expensive — defaults to `[light, standard, heavy]`) and `routing.rules` (max 16; flat `when` matcher, AND across keys, suffix operators `_lt|_lte|_gt|_gte`, bare key for equality). Closed `when` signal set: `profile`, `est_tokens`, `allowed_paths_count`, `depends_on_count`, `ac_count`, `review_required`, `gate`, `lane`, `extras_complexity`. Rules may declare `then.fanout` (max 8) for review-panel-style parallel dispatch. RK ships **zero baked-in rules**; the score fallback is the only built-in behavior.
- **Sprint/epic frontmatter `extras.routing` (opt-in).** Strict-validated namespaced jar: `complexity`, `prefer_tier`, `pin_tier`, `fanout`. `safeParse` + structured findings — typos surface as P2 routing findings rather than silently falling through to scoring. Invalid `pin_tier` against the configured `tier_set` becomes a P1 and falls back to scoring; the pin is never silently honored against an unknown tier name.
- **Two-tier and 4+-tier configs supported.** Length-aware tier indexing collapses or expands automatically; consumers configure `tiers: [a, b]` or `tiers: [t1, t2, t3, t4]` and the resolver and complexity hints adapt.
- **Markdown rendering of routing block.** `rk context <ID> --with-routing --format md` appends a fenced `## Routing` JSON block at the end of the packet so humans can read the hint when reviewing the packet by eye.
- **27 routing-resolver unit tests + 12 CLI integration tests + 14 config-validation negative-path tests + 2 vendor-agnosticism CI guards.**

### Public framing

RepoKernel can recommend a cheaper or stronger agent tier from deterministic sprint state. Cost-savings telemetry (audit log + savings calc) is intentionally deferred to a future release; the v1 surface is read-only by design.

## [1.7.0] - 2026-04-28

Reviewer-9 hardening epic: closes the four sharp public-contract gaps an independent reviewer flagged after 1.6.0 — custom-path close, NEXT.md parser blind spot, missing task surface, and tarball smoke that didn't exercise fastpath.

### Fixed

- **`rk close T-NNN` now honours custom config paths.** The pre-merge stage helper hardcoded `.repokernel` when restricting `git status --porcelain` and `git add` to RK-managed files, so configs that placed sprints/reviews/queues outside `.repokernel/` (e.g. `paths.sprints: docs/sprints`) silently dropped the worktree-side review-state mutation. The merge then carried stale state into main and the post-merge close guard tripped with `sprint S-001 is in queued after merge`. The stage set is now derived from a new `materialPaths(config)` helper in `@repokernel/core` that exposes the canonical RK-managed path set with `worktreeStaged` / `mainStaged` subsets.
- **`rk queue add` no longer prints a hardcoded registry path.** The "Updated:" line now uses `config.paths.registry` instead of literal `.repokernel/registry.json`, so custom registry locations are reflected truthfully.
- **`NEXT_MD_INVALID_ID` is now reachable for malformed slot bullets.** The parser regex pre-filtered to `S-\d+` so malformed entries (`- S-ABC`, `- s-001`, `- bogus`) were silently dropped and the documented P0 finding code never fired. The bullet capture is now permissive (`-\s+(\S+)`) and `SPRINT_ID_RE` does the validation, with `NEXT_MD_INVALID_ID` surfacing for each malformed bullet inside a `## Slot N` section. Prose bullets above the first slot still produce no false positives.
- **`rk close T-NNN` no longer prints a stale "git add … && git commit" hint.** The wrapper commits the close-side metadata itself and now passes `omitCommitHint: true` to the underlying close pipeline so the suggestion is suppressed.

### Added

- **`rk task list|status|inspect` for fastpath task aliases.** Read-only inspection commands over the existing `listTaskAliases()` / `readTaskAlias()` helpers. `list` supports `--status active|review|shipped|cancelled` plus `--json`. `status` shows id, sprint linkage, source, timestamps and (when present) the truncated `review_sha`. `inspect` adds resolved on-disk paths to the alias JSON, the synthesized sprint markdown and (when available) the review markdown, with `(not found)` placeholders when the project graph fails to load. The previously-stale `run \`rk task list\` to see available tasks` hint at the unknown-T-NNN error path now points to a real command.
- **Direct unit coverage for fastpath `closeTask`, `runTask`, `render`, `editor`, and `taskCommands`.** Coverage moves 54.91 % → 56.19 % statements and 36.82 % → 49.33 % on the fastpath module. Vitest thresholds raised 48 → 55 statements, 65 → 68 functions, 68 → 72 branches.
- **End-to-end fastpath round-trip in tarball smoke.** `scripts/smoke-fastpath.sh` drives `rk init` → `rk run -m "smoke fastpath" --agent fake` → `rk close T-001` against the published tarball and asserts the alias reaches `shipped` with a clean working tree. The publish workflow runs the script twice — once with the default `.repokernel/plan/*` layout and once with a `docs/`-rooted custom layout — replacing the previous `rk init` + `rk validate`-only smoke that could not have caught the custom-path close regression.

## [1.6.0] - 2026-04-28

Bundles three waves of fixes from an async-Nygaard-style review covering
lifecycle transactions, core dependency semantics, and CLI/release
contract.

### Fixed

- **Autonomous run loop no longer fails on its own metadata.** Between
  `runReviewCommand` and `runCloseCommand`, the loop now stages and commits
  the sprint→review flip, the review file, and the refreshed registry. After
  close it commits the close-side mutations (sprint→shipped, queue slot
  removal, review end_sha, registry). A single autonomous run leaves the
  repository fully recorded and clean.
- **Wave merge is transactional.** `mergeWaveBranches` captures the epic
  branch tip before the loop and, on conflict mid-wave, aborts the in-progress
  merge AND `git reset --hard`s back to the pre-wave tip. The returned
  `merged` list is empty on rollback, so callers see the wave as atomic. No
  more half-shipped state where some sprints landed in the epic branch and
  others left their lifecycle metadata stale.
- **`blocked_by` actually blocks.** Previously the validator checked
  `blocked_by` for missing references and cycles, but the resolver and wave
  builder ignored it at execution time — a sprint could declare itself
  blocked and still be selected to run. Now `blocked_by` is treated the same
  as `depends_on` in `nextRunnable`, `buildExecutionWaves`, and the parallel
  run loop's shipped-set.
- **`cancelled` upstream is now a soft block.** The parallel run loop used to
  treat `cancelled` upstream as satisfying a downstream `depends_on`, while
  the sequential resolver required `shipped`. The two paths now agree:
  `cancelled` upstream blocks downstream until a human re-targets or cancels
  it. Codified as the canonical rule in a new shared helper
  `isDependencyMet` (`core/graph/readiness.ts`).
- **Configured checks gate enforced before close.** `automation.checksCmd`
  was previously only invoked by `rk epic close --run-checks`. It now runs
  before every sprint close (sprint, fastpath, autonomous run loop). New
  `--skip-checks` opt-out for emergencies.
- **Autonomous multi-sprint review no longer halts on findings about other
  sprints.** `runReviewCommand` previously refused to proceed if a downstream
  queued sprint had an unshipped dependency — even when the dependency was
  the very sprint being reviewed. New `findingAppliesToSprint` filter scopes
  the blocking check to findings about the sprint, its review, its queue
  slot, or its epic.
- **Review panel policy snapshotted on the result.** The
  `reviewPanelConflictRule` validator no longer self-invalidates a YELLOW +
  `changes_requested` result produced under `yellow_blocks_close: true` if
  the policy is later flipped. Each panel run records its
  `panel_policy_snapshot`, and the validator reads the snapshot, not the
  live config.
- **Discard tells the truth about worktree release.** `rk task discard` now
  prints "released" only when the best-effort `git worktree remove` actually
  succeeded. On failure it prints "NOT released — clean up later with
  `rk lane release`" instead of misleading the user.
- **`worktrees.json` is crash-safe and race-safe.** All read-modify-writes
  go through a repo-level lock (`withLockRetrying`, 5s deadline) and use
  temp-file + rename for atomic writes. Concurrent rk processes can no
  longer clobber each other's records, and a crash mid-write leaves the old
  file intact.

### Added

- **`rk run T-NNN` resolves to the underlying epic and dispatches.** The
  retry path printed in error suggestions now actually runs. Errors clearly
  when the alias doesn't exist, is shipped, or was cancelled.
- **`rk run -m "..." --dry-run` actually previews.** Plumbs `dryRun` into
  the fastpath and prints a deterministic preview without writing files,
  committing, or invoking the agent.
- **`rk validate` surfaces leaked worktrees.** Both sprint-level
  (`findLeakedSprintWorktrees`, was unwired) and epic-level
  (`findLeakedEpicWorktrees`, new) leak validators run as part of every
  `rk validate`. Stale fastpath epic worktrees no longer accumulate
  invisibly.
- **`UNKNOWN_FRONTMATTER_FIELD` demoted to P3 advisory.** Unknown fields
  were always silently dropped at parse — the P1 severity was misleading.
  Now P3, matching the docs/UX in `explanations.ts`. Users wanting strict
  loading can lower their `severityFailThreshold`.

### Changed

- **`RegistrySprintSchema` v2 with previously-missing fields.** The registry
  was documented as the machine source of truth but omitted `blocked_by`,
  `allowed_paths`, `denied_paths`, `generated_paths`, and `review_required`
  — all of which gate runtime decisions. Schema bumped to v2; older registry
  files must be regenerated with `rk validate --write`.
- **`--lane` and `--limit` rejected on fastpath.** Both are epic-driven
  concepts; silently ignoring them on a single ad-hoc task was a
  trust-breaking CLI behavior. Now an explicit error before any mutation.
- **`scripts/release.sh` runs preflight before any version write.** A trap
  rolls bumped files back via `git checkout --` if any step between bump
  and commit fails, so an aborted release leaves the working tree clean.
- **`.github/workflows/publish.yml` smoke no longer swallows
  `rk validate` failures.** Dropped `|| true`. A broken `rk init` contract
  now blocks publish.

## [1.5.6] - 2026-04-28

### Fixed

- **`rk` works from any subdirectory of an initialized repo.** Every command
  now walks up from the caller's cwd to find `repokernel.config.yaml` before
  resolving plan paths, so `rk status`, `rk review`, `rk close`, etc. no
  longer ENOENT when invoked from `apps/web/` or another subdir. Implemented
  via a new sync helper `findProjectRootSync()` in `@repokernel/core` and a
  `resolveProjectCwd()` wrapper at the CLI entry layer. `rk init` is
  intentionally exempt — it must initialize at the caller's actual cwd.
- **`CONFIG_FILE_NOT_FOUND` error spells out the walk-up failure.** Replaces
  the old "config not found at <path>" with "repokernel.config.yaml not found
  in `<dir>` or any parent — run from a directory inside a
  repokernel-initialized repo, or run `rk init` here".
- **`allowed_paths`/`denied_paths` no longer flag rk-managed plan-state
  writes.** `rk start` and `rk close` mutate the sprint's own frontmatter
  file, the queue file, and `registry.json` as part of normal lifecycle —
  these are exempt from the path-policy check at review time. Sprints with
  `allowed_paths: ['src/**']` no longer need `.agents/plan/**` widening for
  `rk review` to proceed. Out-of-scope source changes are still caught.
  Exemption is config-driven from `paths.{sprints,reviews,queues,registry}`.

### Added

- **`rk close` surfaces newly-unblocked planned sprints.** When a close ships
  a sprint that completes another sprint's `depends_on` set, the close output
  now includes a `Newly unblocked:` section listing those sprints with their
  dep status, plus a copy-paste `rk queue add … && rk start …` next-step
  hint instead of the generic `rk next`. Backed by a new pure helper
  `findNewlyUnblockedSprints(graph, justClosedId)` exported from
  `@repokernel/core`.

### Changed

- **README rewrite for layered messaging.** H1 and 60-second fastpath
  unchanged. New `## For multi-task workflows` and `## Agent-operated by
  design` subsections introduce `rk next`, `rk epic status`, `allowed_paths`,
  and atomic review allocation as the level-2 pitch. `## Why` bullets
  refreshed and softened (no overpromising claims). Soft link to
  `docs/internals/parallel-waves.md` from both the new subsection and
  `## Advanced`.

## [1.5.5] - 2026-04-28

### Fixed

- **Fastpath: prose constraints are no longer dumped into `denied_paths`.**
  `rk run -m`/`rk run --stdin` synthesize a sprint from free-text input that may
  include human-readable constraints ("Do not add dependencies", "Keep
  implementation minimal"). v1.5.4 and earlier wrote those strings directly into
  `sprint.denied_paths`, where the path-policy validator interprets them as
  globs — a string like "Do not add dependencies" is meaningless as a glob and
  could even be a denial of an unintended path. Synthesized sprints now write
  `denied_paths: []`. The constraints remain visible in `extras.task_constraints`
  and in the rendered sprint body's "Constraints" section, so the audit trail is
  preserved.
- **Test flake: parallel fakeAgent teardown race against git pack files.**
  `removeRepo()` and the parallel-test `afterEach` now pass
  `{ maxRetries: 5, retryDelay: 100 }` to `fs.rm`, which is the documented
  remedy for the `ENOTEMPTY: directory not empty, rmdir '.git/objects/pack'`
  race on Linux (git gc subprocesses briefly hold pack files past test exit).
  Affected `test/fakeAgent/parallel.test.ts > pending_wave contains both sprint
  IDs`, intermittently failing the publish workflow; CI ran clean here is the
  publish loop.

### Changed

- **Package descriptions and keywords aligned with the v1.5.x positioning.**
  Root, CLI, and core `package.json` now describe the project as "Run AI coding
  tasks in isolated Git worktrees, with checks before merge." The CLI package
  keywords are reduced to `ai`, `agents`, `git`, `worktree`, `cli`,
  `developer-tools` — `orchestration`, `sprint`, and `workflow` are removed
  because they overpromise the higher-level epic/queue surface that is now
  intentionally secondary in the public README.



### Added

- **`rk cancel <id> [--reason <text>]` command.** Transitions any non-terminal
  sprint (`planned | pending | queued | active | review | reopened`) to
  `cancelled`, sets `closed_at`, records `cancel_reason`, and removes the sprint
  from its lane queue. No review pipeline is run — this is the rk-canonical path
  for abandoning stale-active sprints (e.g. one that was started but never
  produced any code) so the next queued sprint in the lane can start. The
  `LANE_ALREADY_ACTIVE` error from `rk start` now suggests `rk cancel <id>` as
  one of the remediation options. Adds optional `cancel_reason: string` to the
  Sprint frontmatter schema.
- **`REVIEW_INVALID_VERDICT` and `REVIEW_INVALID_FINDING_SHAPE` finding codes.**
  When a review file fails parse-time schema validation, `rk validate` now
  emits dedicated P0 findings instead of (or in addition to) the generic
  `PARSER_FAILURE`:
  - `REVIEW_INVALID_VERDICT` fires when `verdict` is outside the enum (e.g.
    `yellow`, `green`, `red`); the message quotes the offending value and the
    suggestion lists the valid set (`pending | accepted | changes_requested |
    rejected`).
  - `REVIEW_INVALID_FINDING_SHAPE` fires when any `findings[]` entry is malformed
    (e.g. legacy nested `{severity, category, data:{message}}`); the suggestion
    points to the flat `{severity, message}` shape required since v1.5.x.

  Both codes only apply to review entities; sprint, epic, queue, and lane parse
  failures continue to emit `PARSER_FAILURE` unchanged.

### Changed

- **`rk review-allocate` is now idempotent by `sprint_id`.** Before allocating
  a fresh review ID, the command scans the reviews directory under the existing
  `review-id` lock and reuses any review file that has matching `sprint_id` and
  `verdict: pending` — no counter advance, no file write, no orphan stubs from
  repeated probes. JSON output gains a per-row `reused: boolean` flag; non-JSON
  output marks reused rows with a trailing `(reused)`. Stubs that have already
  received a verdict (`accepted | rejected | changes_requested`) are NOT reused
  — calling allocate again for the same sprint produces a fresh ID, which is
  the correct behavior for re-reviews.

### Internal

- `allocateReviewIds()` now returns `Map<SprintId, { reviewId, reused }>`
  instead of `Map<SprintId, string>`. `rk run`, `rk review-reconcile`, and
  `rk review-allocate` callers updated.

## [1.5.3] - 2026-04-28

### Removed

- **`rk migrate` command deleted.** The migration surface was premature infrastructure
  for a tool with a single consumer. Schema migration concerns are handled at parse time
  via the new `LEGACY_IGNORED_FIELDS` mechanism (see below); there is no command to
  run on upgrade.
- **`schema_version` field removed from all entity schemas.** Sprint, review, queue, and
  run frontmatter no longer declare or validate a `schema_version` integer. The field
  was noise with no meaningful enforcement. Existing files that still carry
  `schema_version: 1` (or `2`) are silently ignored at parse time — no
  `UNKNOWN_FRONTMATTER_FIELD` finding is emitted and no file edits are required.
- **Schema-version finding codes removed.** `REVIEW_SCHEMA_OUTDATED`,
  `REVIEW_SCHEMA_FUTURE`, `SPRINT_SCHEMA_FUTURE`, and `QUEUE_SCHEMA_FUTURE` are no
  longer emitted. Their explanation entries and `FindingCode` union members are removed
  from `@repokernel/core`.
- **`isV1Review` / `migrateReviewV1ToV2` removed from `@repokernel/core` public API.**
  The review-v1-to-v2 migration module is deleted entirely.

### Changed

- **`ParsedNextMd.schemaVersion` removed.** The `schemaVersion` field is no longer
  present on the object returned by `parseNextMd`. Consumers that read this field should
  drop the reference.

## [1.5.2] - 2026-04-28

### Added

- **`rk review-allocate` command.** Public CLI surface for the locked review-id
  allocator that `rk run` already used internally. Worktree agents that need a
  review ID outside the orchestrated wave path now have an rk-canonical entry
  point (`rk review-allocate --sprint S-NNN [--sprint S-MMM ...] [--json]`)
  instead of rolling their own scan-and-write logic.
- **`rk review-reconcile` command.** Detects sprints whose `review_id`
  references a missing review file, points at a review targeting another
  sprint, or shares an ID with another sprint. With `--apply`, allocates fresh
  review IDs through the locked allocator and rewrites the affected sprint
  frontmatter — a one-shot repair tool for projects that hit a parallel-write
  race in older versions.
- **`rk hotfix <description>` command.** Records an out-of-band fix as a
  fastpath task (T-NNN) without scaffolding a full sprint planning cycle.
  Reuses the existing fastpath synthesis path; the user references the T-NNN
  id in their commit message and runs `rk close T-NNN` later. Closes the ADR
  49 gap that left ad-hoc bug fixes with no rk-canonical home.
- **`rk epic close` pre-flight review-integrity gate.** Before mutating the
  epic frontmatter, close runs the `reviewIntegrityRule` for the epic's
  sprints and refuses to proceed when any P0/P1 finding is present (sprint
  references missing review, or review targets another sprint, or shipped
  sprint has no accepted review). `--force` bypasses, matching the existing
  incomplete-sprints behavior.
- **`rk create sprint` ergonomic flags.** `--after` is now repeatable and
  accepts comma-separated values for multi-edge fan-in (e.g.
  `--after S-185,S-182`). New flags `--allowed-path`, `--denied-path`, `--adr`,
  `--target-date`, and `--body-file` populate frontmatter at creation time so
  agents no longer need to edit the scaffolded file post-create. The
  next-step recommendation now prints `rk validate --fail-on P0,P1` to match
  the documented session protocol.
- **`reviewIntegrityRule` exported from `@repokernel/core`.** The rule was
  previously private to the validator engine; surfacing it lets `rk epic
  close` and other consumers call the integrity check directly without
  re-running the full validator suite.
- **`severityFailOnOrThrow` parser.** New CLI helper that accepts both
  single-value and comma-list forms for `--fail-on` (e.g.
  `rk validate --fail-on P0,P1`). The list collapses to the least-severe
  entry as the threshold; `--fail-on P0,P1` is equivalent to `--fail-on P1`,
  matching the threshold semantics already documented for the operator skill.

### Changed

- **ID counters moved to `<opRoot>/counters/<kind>s.json`.** Sprint, epic, and
  review IDs are now allocated from monotonic counter files at the operational
  root (`<git-common-dir>/repokernel/counters/`), not from a directory scan of
  the local working tree. The counter is shared across all worktrees of the
  same repository, so concurrent worktree agents get distinct IDs even when
  each is writing into its own working-tree copy. The counter is seeded from a
  one-time directory scan on first use to migrate existing projects
  transparently.
- **Lock acquisition gains a retry-with-backoff variant
  (`withLockRetrying`).** Used by the review-id allocator and the create-time
  ID counters so concurrent rk processes serialize cleanly through brief
  contention windows. The default `acquireLock`/`withLock` path is unchanged
  (immediate failure on contention) to preserve existing wave-lock semantics.
- **`rk registry --write` surfaces actual findings on config-invalid.** The
  prior `'config invalid; see validate output'` stub is replaced with the
  formatted findings table (or `--json` with the findings array), so users no
  longer need a second `rk validate` round-trip to learn what is wrong.
- **`operationalRootBestEffort` helper.** A non-throwing variant of
  `operationalRoot` that falls back to a project-local `.repokernel/_op`
  directory when no git repository is detected. Used by `rk create *`
  commands so they can scaffold entities before `git init` (e.g. fresh
  templates, test fixtures).

### Fixed

- **Parallel review-id collisions across worktrees.** Reproduces the
  DomicileVault E-025/E-029/E-030 failure: three worktree agents each running
  their own review pipeline assigned overlapping `R-NNN` values from
  worktree-local directory scans. The new counter-file allocator at the
  shared operational root, plus retry-aware locking, eliminates the race.
- **`rk create sprint --after` was single-edge only.** Multi-edge fan-in
  (e.g. `S-186 → [S-185, S-182]`) required manual frontmatter edits that
  contradicted the rk-canonical contract. Now repeatable + comma-aware.

## [1.5.1] - 2026-04-28

### Added

- **Process output limits.** External agent processes are killed after emitting more than 10 MB of combined stdout+stderr; reviewer processes are killed after 5 MB combined stdout+stderr. Both use a two-stage kill (SIGTERM → 5 s grace → SIGKILL) and the run/review resolves with the configured `failure_verdict` rather than hanging.
- **Owner-side SIGTERM/SIGINT handler.** When `rk run abort` signals the owner process, the handler synchronously kills every tracked agent process group and escalates to SIGKILL after a 5 s grace, preventing orphaned grandchildren that would otherwise keep writing to the worktree after the owner exited.
- **Run abort flag (`abort_requested`).** Setting this flag on a run signals the owner process to stop at the next checkpoint without waiting for the current sprint to finish. The abort subcommand now persists both `abort_requested: true` and `status: aborted` atomically, and the lane is released even if the state write fails.
- **`rk close` drift guard.** Each task alias records the worktree-branch HEAD captured the moment checks last passed (`review_sha`). `rk close` refuses to merge if the branch has advanced since, so manual commits made between `rk run` and `rk close` cannot bypass the check pipeline.
- **Duplicate entity detection.** `loadProject` now reports `DUPLICATE_SPRINT_ID`, `DUPLICATE_EPIC_ID`, and `DUPLICATE_REVIEW_ID` findings at P1 severity before graph construction, preventing silent ID collisions. Non-blocking parse findings are surfaced alongside duplicate failures so users see the full diagnostic set in one pass.
- **`RepoRelativeGlob` and `RepoRelativePath` path schemas.** New Zod schemas exported from `@repokernel/core` that reject absolute paths, `..` traversal, `.git` segments, and NUL bytes. The glob variant is used for `allowed_paths`, `denied_paths`, `generated_paths`, and quality-rule patterns; the path variant is used for `changed_files` and refuses `*` to keep literal-path semantics.

### Changed

- **Secret scanner scoped to staged paths.** `stagePathsAndCommit` now scans only the staged content for the paths it is committing, so an unrelated `scratch/.env.local` or other untracked file in the working tree no longer blocks RK metadata commits. The full-tree scanner is preserved as a separate exported helper for explicit use.
- **`UNKNOWN_FRONTMATTER_FIELD` severity raised from P3 → P1.** Files with unrecognised frontmatter keys now block project loading at the default threshold. Remove stray keys or update to a supported schema version.
- **Schema versions are now strict literals.** Sprint, queue, review, and run `schema_version` fields now accept only the exact supported version integer. Files written by a newer version of `rk` will emit a P0 `*_SCHEMA_FUTURE` finding rather than silently parsing.
- **Release script validates before tagging.** `pnpm release` now requires a clean working tree, runs `pnpm check`, `pnpm typecheck`, `pnpm -r build`, `pnpm -r test`, and a dry-run `pnpm pack` before writing the version commit and tag. Duplicate tags are rejected.
- **Publish workflow installs the packed tarball before publishing.** `pnpm pack` is now followed by an `npm install -g <tarball>` smoke step that runs `rk --version` and `rk init` in a fresh tmp repo, so a regression in CLI bundling cannot reach npm.
- Node.js `>=20` is now declared in `engines` for both packages.

### Breaking Changes

- **`allowed_paths` / `denied_paths` / `generated_paths` in sprint YAML**, and **`globs` in quality rules**, now reject absolute paths and paths containing `..` or `.git` segments. Update any project files that use absolute globs.
- **`changed_files` in review YAML and review packet** is now validated as a literal repo-relative path (`RepoRelativePathSchema`); values containing `*` are rejected. Move any glob patterns to one of the dedicated glob fields.
- **Any YAML file with an unrecognised frontmatter field** will now fail validation at the default P1 threshold instead of emitting a low-severity hint. Remove unknown fields before upgrading.

## [1.5.0] — 2026-04-27

### Added

- **Built-in `ollama` agent for local model execution.** Talks to a local [Ollama](https://ollama.ai) HTTP endpoint (default `http://localhost:11434`), reads the sprint packet plus up to 20 tracked files from the worktree, asks the model for a JSON response (`{ summary, files: [{path, content}] }`), writes the returned files, and commits. Configure via env: `OLLAMA_MODEL` (default `llama3.1`), `OLLAMA_HOST`, `OLLAMA_TIMEOUT_MS`. Whole-file replacement only — small local models cannot reliably emit diffs; richer multi-turn agents are still better served by the custom-adapter pattern (e.g. aider against an Ollama backend).

## [1.4.2] — 2026-04-27

### Fixed

- Review panel reviewer execution no longer crashes the test runner with an unhandled `EPIPE` when a reviewer process exits before the parent finishes writing its JSON input (e.g. timeout-driven `SIGTERM`, fast bail). `child.stdin` now has an `error` listener that swallows writer-side pipe errors; the failure path is already handled by the existing `child.on('error')` and the close handler's non-zero-exit branch. Surfaced as a CI failure on the v1.4.0 build.

## [1.4.1] — 2026-04-27

### Changed

- README quickstart now uses `--agent fake` so the three-command flow runs without API credentials. A follow-up note explains how to swap in `--agent claude` or `--agent codex`.
- Slimmer README subtitle: "Each task gets its own branch, audit trail, and review gate." replaces "RepoKernel keeps agent work isolated, reviewable, and tied to Git."
- "Auditable" bullet rewritten to be precise about what is committed and what is not: synthesis, agent commits, the auto-accepted review, and the merge each land as separate commits.
- "Vendor-neutral" bullet now lists the built-in adapters explicitly (Claude Code, Codex, `fake`, `manual`, plus any shell command).
- "Configuring checks" section makes the edit step explicit ("Edit it and add the commands…") instead of leaving the YAML as a floating example.
- "Advanced" section reframed as a question ("Need more than one task?") instead of "wraps a deeper machinery".
- Removed a placeholder TODO comment about the asciinema demo from the README; the demo embed will be added when the recording is published.

## [1.4.0] — 2026-04-27

### Added

- **Fastpath: `rk run` accepts a single task instead of an epic id.** New invocation modes: `rk run` (opens `$EDITOR` with a structured template), `rk run -m "<task>"` (inline), `rk run task.md` (file), `echo ... | rk run --stdin`. Existing `rk run E-NNN` flow is unchanged.
- `rk close T-NNN` and `rk discard T-NNN`. Close merges the worktree branch into the current branch, auto-accepts the review, marks the sprint shipped, and releases the worktree — atomically. Discard cancels the sprint and epic and releases the worktree without merging. Both refuse to operate on tasks in the wrong state.
- `.repokernel/tasks/T-NNN.json` alias files. Map the user-visible `T-NNN` to the underlying synthesized epic and sprint ids; auto-allocated by scanning the directory (no counter in `registry.json`). The synthesized epic and sprint conform to the existing schemas — no schema migration.
- `examples/fastpath/` — runnable minimal demo project.
- `docs/fastpath.md` — user-facing guide explaining the three-command flow and the audit trail it produces.
- `scripts/record-fastpath-demo.sh` — reproducible script for `asciinema rec` and similar tooling.

### Changed

- README rewritten around the fastpath as the entry point. Detailed feature surface preserved verbatim at `docs/internals/README-detailed.md`.
- `docs/` reorganized: deep references moved under `docs/internals/`. User-facing entry points (`docs/fastpath.md`) live at the top of `docs/`.
- `rk run` first positional argument renamed from `<epic-id>` to `<target>` to reflect the broader accepted forms (epic id, file path, or omitted for editor mode).
- `rk close` now accepts an optional id (`[id]` instead of `<id>`) and dispatches to the fastpath when given a `T-NNN` argument or no argument at all.

## [1.3.0] — 2026-04-27

### Added

- `rk epic close --run-checks` flag. Runs a configurable shell command (`automation.checksCmd` in config, or `--checks-cmd <cmd>` CLI override) before writing `status: done`. Non-zero exit blocks the close with a `CHECKS_FAILED` error. `--dry-run` skips execution. Enforces the build gate at the CLI layer rather than relying on protocol alone.
- `automation.checksCmd` config field. Shell command invoked by `rk epic close --run-checks`. Example: `"pnpm lint && pnpm type-check && pnpm test && pnpm build"`.
- `rk chain preview --epic <id>` now surfaces `planned` and `pending` sprints belonging to the epic as a "Planned (not yet queued)" section (text output) and `planned_for_epic` array (JSON output). Allows agents to pre-flight the full epic sprint chain before any sprint is queued.
- `rk chain preview` documented in `docs/cli-reference.md`.

### Fixed

- `rk close E-NNN`, `rk start E-NNN`, `rk review E-NNN`, `rk reopen E-NNN` now detect that the ID is an epic and return a targeted error message (e.g. "E-NNN is an epic; use `rk epic close E-NNN`") instead of the misleading "sprint E-NNN not found".

## [1.2.0] — 2026-04-27

### Added

- `rk epic close <EPIC_ID>` command. Transitions an epic to `done`, records `closed_at`. Requires all sprints to be `shipped` or `cancelled`; `--force` bypasses the guard with a warning. `--dry-run` previews the mutation without writing files. Closes the previous gap where agents had to edit epic frontmatter directly to mark an epic done.
- `closed_at` field on `EpicFrontmatterSchema`. Optional nullable ISO 8601 datetime, matching the pattern on `SprintFrontmatterSchema`.
- `mutateEpicFrontmatter` utility in `packages/cli/src/lifecycle/mutate.ts`.

### Changed

- `repokernel-operator` skill (§2 Pre-work checks) now uses a three-tier cost model. Tier 1 (`rk epic status`, `rk ls epics`, `rk next`) is the default session-start query. Tier 2 (`rk validate --fail-on P0,P1`) runs before touching code. Tier 3 (bare `rk validate`, `rk status`) is explicit-only. Prevents the 100+ P2 `SHIPPED_SPRINT_MISSING_BASE_SHA` flood from burning context budget at session start on mature repos.
- `repokernel-operator` skill §4 now shows `rk epic close` as a required step after all sprints ship.
- `docs/concepts.md` updated: epics now have a lifecycle command (`rk epic close`); `on_hold` and `cancelled` remain frontmatter-only transitions.
- `docs/cli-reference.md` and `docs/resume-recovery.md` updated for `rk epic close`.

## [1.1.0] — 2026-04-27

### Added

- `extras: {}` opaque pass-through field on `ReviewFrontmatter` (matching the existing field on `EpicFrontmatter` / `SprintFrontmatter`). Consumer-defined sidecar fields (e.g. `reviewers_run`, `cost_usd`, `iterations`) pass through without `UNKNOWN_FRONTMATTER_FIELD` warnings.
- `requires:` semver gate in `repokernel.config.yaml`. Projects can pin a minimum `rk` version; mismatched versions surface as `CONFIG_REQUIRES_NOT_MET` with a finding explanation.
- `repokernel-operator` agent skill at `examples/skills/repokernel-operator/SKILL.md`. Teaches AI coding agents to drive RepoKernel through `rk` commands rather than inferring lifecycle from prose.

### Changed

- `generatedBy` field on the registry now derives from the live `rk` version (no more drift between `package.json` and a hardcoded constant). Core's `generateRegistry` accepts an optional `generatedBy` input; CLI passes its own version automatically.
- Documentation rewritten for first-time visitors. README restructured around a hero, "why it exists", "what it is not", quickstart, and core concepts before reference material.

### Fixed

- `exactOptionalPropertyTypes` typecheck failure in `validate` command.

## [1.0.0] — 2026-04-27

### Added

- Epic membership now derived from `sprint.epic_id` (canonical source); `epic.sprints[]` becomes a curated ordering hint, not the membership source. Sprints with a back-pointer are always in the registry list; unlisted back-pointer sprints append at end. Eliminates bidirectional maintenance across all epics.
- New P2 finding codes: `EPIC_SPRINT_BACK_POINTER_CONFLICT` (ordering hint lists sprint whose `epic_id` points elsewhere) and `EPIC_SPRINT_NOT_IN_ORDERING` (sprint has back-pointer but is absent from ordering hint).
- `extras: {}` opaque pass-through field on `EpicFrontmatter` and `SprintFrontmatter`. RK validates known fields; `extras` content passes through unchanged. Unknown top-level fields still fail via `.strict()`. Eliminates the need for project-level sidecar YAML files.
- `rk registry --out <path>` for one-off registry generation to an override path. `--check` always uses the canonical config path.
- `rk doctor --fix` auto-creates missing `paths.generated` directory and parent dirs for `generated.files` entries. Non-generated paths remain user-managed.
- `rk --version` / `rk -v` — standard semver output from `package.json`.
- JSON output envelope table documented in `docs/cli-reference.md` with per-command `jq` accessors.

### Changed

- `paths.registry` now defaults to `.repokernel/registry.json`; no longer required in `repokernel.config.yaml`.
- `REGISTRY_GENERATED_BY` updated to reflect current version.

## [1.0.0-rc.3] — 2026-04-27

### Added

- `rk start --enqueue` flag for one-shot `planned → queued → active` transition without silent state-machine relaxation (F9).
- `rk reopen` now accepts `active` sprints; clears `started_at` on transition (F10).
- `rk chain preview --epic <id>` filters chain to a single epic (F11).
- `rk next --epic <id>` scopes the resolver to one epic and warns on unspawned sprints referenced by `epic.sprints[]` (F12). No heuristic context inference.
- `rk validate --since <sha>` triage-only filter that hides findings whose file did not change since `<sha>`. Display-only — does NOT propagate to ship/close/run paths (F14).
- `rk lane acquire --allow-dirty` escape hatch; default behavior now refuses acquiring a worktree from a dirty main tree with `WORKTREE_ACQUIRE_DIRTY_TREE` (F3).
- `rk fix --apply` wired with real regeneration for the four existing safe fixes (mkdir, registry regeneration via `generateRegistry()`, default-queue scaffolding, deprecated-field stripping). Added `--apply --yes` for CI; `--base-sha <sha> --sprint <id>` for operator-asserted base_sha repair (F7a/b/c/d).
- `rk migrate` now also walks `<paths.reviews>` and applies the v1→v2 review schema transform (collapses `category|description|fix_hint` into `message`). Idempotent (F5).
- `findProjectRoot()` exported from `@repokernel/core`; `loadConfig` walks parent directories git-style (F13).
- New finding codes: `DEPRECATED_FIELD` (P3), `UNKNOWN_LANE` (P2), `SHIPPED_SPRINT_MISSING_BASE_SHA` (P2), `REVIEW_SCHEMA_OUTDATED` (P2), `REVIEW_SCHEMA_FUTURE` (P0).
- `KNOWN_DEPRECATED_FIELDS` map in config schema; recursive walk strips known-deprecated keys before Zod parse and emits P3 warnings (F1).
- `unknownLaneRule` validator (F4) — authoritative lanes are lane files + queue lanes only; sprint frontmatter declaring a lane never makes that lane authoritative.
- `REVIEW_SCHEMA_VERSION = 2`; review schema gains `schema_version` field.

### Changed

- `rk start` on a `planned` sprint now returns an actionable error pointing at `rk queue add` or `--enqueue`, instead of the previous generic "requires status queued or reopened" message (F9).
- `rk close` resolves the working-tree clean check via the worktrees registry → control cwd, never via lane derivation (F2). Now honors `config.git.requireCleanWorkingTreeForClose`.
- `rk review` generates deterministic `R-NNN` review IDs from sprint IDs (S-007 → R-007) instead of relying on the central `nextId()` counter; falls back on collision (F6).
- `LoadConfigResult` and `LoadProjectResult` carry a `warnings` channel; `validateProject()` merges config warnings into the sorted findings array.
- `rk fix --apply` regenerates registries from the live project graph rather than writing empty stubs.

### Fixed

- Root config discovery now works from any subdirectory of the project (F13).
- `rk run --lane <X>` rejects unknown lanes with an authoritative-lane suggestion list (F4).
- Review parser auto-migrates v1 frontmatter in-memory so legacy review files load with a P2 hint instead of failing the whole project parse (F5).
- `duplicateIdsRule` already covered reviews — no duplicate validator rule was added (F6); F7c safe fix renumbers the duplicate via `nextId()` and updates the linked sprint's back-reference.

### Security

- `rk fix --apply` never guesses a `base_sha`. Only fills from `run.completed_sprints[].start_sha`, the linked review's `base_sha`, or operator-asserted `--base-sha`. Otherwise the finding stays in manual-required (F8).

## [1.0.0-beta.1] — 2026-04-26

### Fixed

- `rk run --resume` on terminal runs now returns a clear, actionable error instead of
  "not yet implemented". Affected halt_reason values: `epic_completed`, `no_runnable_sprint`,
  `config_error`, `epic_not_found`, `path_conflict`, `user_abort`.
- `rk review-verdict <id> rejected` now surfaces a warning to stderr and provides manual
  resolution instructions when the auto-revert encounters a merge conflict. Previously the
  conflict was silently swallowed, leaving the working tree dirty and sprint status unchanged.
  On conflict, `git revert --abort` is called automatically so the working tree is left clean.

### Added

- Coverage reporting via `vitest --coverage` (`test:coverage` script in both packages).
- `@vitest/coverage-v8` devDependency; produces `text` + `lcov` reports under `coverage/`.
- npm publish workflow (`.github/workflows/publish.yml`) triggered on `v*` tags.

### Chores

- Version bumped from `0.1.0-alpha.1` to `1.0.0-beta.1`.

## [0.1.0-alpha.1] — 2026-04-25

Initial alpha release.
