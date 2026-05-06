# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.16.0] - 2026-05-06

### Added

- **Multi-file mutation journal.** RepoKernel now writes a transaction
  journal under `<git-common-dir>/repokernel/journal/` for every multi-file
  lifecycle command (`rk start`, `rk close`, `rk reopen`, `rk cancel`,
  `rk review`, `rk review-verdict`, `rk next sync`, plus the underlying
  primitives in `mutate.ts`, `sprintExtras.ts`, `sprintClaim.ts`,
  `laneState.ts`, `runState.ts`, `registry.ts`). Each operation produces
  `OP-<ulid>.pending.json` before any disk mutation and renames it to
  `OP-<ulid>.done.json` on commit. Inline `step.content` records the exact
  bytes the op intended to write so recovery is correct even for
  non-deterministic content (timestamps, runtime IDs).
- **`rk recover` journal replay.** `rk recover` now scans for pending
  journals and classifies each into one of `safe_replay`, `already_applied`,
  `diverged`, `unknown_schema`, `corrupt`. The default `--preview` lists
  findings; `--apply` replays safe ones, marks already-applied ones, and
  quarantines diverged or corrupt ones to
  `OP-<ulid>.unrecoverable.<ts>.<rand>.json`. Future schema versions are
  left untouched (so a newer rk can replay them).
- **`rk recover --journal-only`** skips worktrees / runs / lane-claim
  phases and only scans the journal directory.
- **`rk recover --dry-run`** alias for `--preview`.
- **`<opRoot>/recover.report.json`** structured report written after
  `--apply` listing every journal inspected, its classification, and the
  number of steps applied vs already applied.

### Changed

- The journal is **strictly local-clone**. It lives under
  `.git/repokernel/journal/`, is never tracked by git, and never travels
  through `git push`/`git fetch`/PR merges. Different clones have
  independent journals; same-clone worktrees share one journal directory.
  Cross-clone or post-merge "journal recovery" is not a feature — registry
  merge correctness (already covered by the merge driver) is the cross-clone
  story.
- Single-mutex `journal-write` lock now serializes every journaled state
  mutation across commands. This prevents two commands (`rk run` +
  `rk close`, `rk close` + `rk next sync`, etc.) from interleaving writes
  on shared files such as `registry.json`. Existing fine-grained locks
  (lane, sprint-claim, queue) remain in place and are acquired inside the
  journal-write lock.

## [1.15.1] - 2026-05-06

### Added

- **Preflight cache invalidation on mutations.** Lifecycle mutations that go
  through `refreshRegistry` (rk start, rk close, rk review-verdict, rk fix
  --apply, rk hotfix, rk run, rk init, etc.) and sprint-extras mutations
  (`rk sprint routing set/clear`, tracker / PR metadata writes) now
  invalidate `<opRoot>/preflight.json` so the next `rk preflight` re-scans
  rather than returning the pre-mutation snapshot. Closes the gap between
  the 60s TTL and the moment of state change.

### Changed

- **README merge-driver section** explicitly scopes determinism to per-clone
  installs and calls out hosted-web merges as out-of-scope. The `rk doctor`
  remediation path (verifies `.gitattributes` + the three
  `merge.repokernel-registry.*` git-config keys) is mentioned alongside the
  workflow. Tightens the marketing claim to match reality.
- **README skill section** clarifies that the "agent never edits
  `.repokernel/**`" claim is scoped to skill-using agents (enforced by the
  bundled `PreToolUse` hook); humans can still hand-edit, and `rk validate`
  / `rk fix --apply` re-derive invariants.

### Fixed

- Stale issues triaged: closed #39 (DUPLICATE_REVIEW_ID dead code, fixed in
  1.14.1), #28 (file:line on findings, fixed in 1.15.0), #23
  (`--from-tracker` on fastpath `rk run`, fixed in 1.15.0), #25
  (registry merge driver, shipped in 1.14.0).

## [1.15.0] - 2026-05-06

### Added

- **`rk preflight` — canonical session-scoped operational gate.** Replaces the
  per-command `rk team status --json` invocations that `/rk-next`, `/rk-run`,
  and `/rk-review` previously each ran. Preflight caches under
  `<opRoot>/preflight.json` (default 60s TTL); `--refresh` forces a re-scan;
  `--max-age <seconds>` tunes the budget. Plugin commands trust the cache.
- **`TeamStatusSchema.schemaVersion: 2`** — explicit version field on the
  `rk team status --json` output. Pre-1.14 captures still parse: both
  `schemaVersion` and `operational` are defaulted on the Zod schema.
- **`operational.collection_errors: string[]`** — surfaces failures from the
  `rk team status` worktree scan instead of silently collapsing them to "no
  leaks". A green operational dashboard from a broken collector is worse than
  no dashboard.
- **`pnpm release:advance-major` and `pnpm release:minor:advance-major`** for
  explicit `v1` floating-tag advancement. The default `pnpm release` no longer
  advances the major tag; floating-tag promotion is now a deliberate "I attest
  this is backwards-compatible" act of trust (see
  [docs/internals/release-policy.md](docs/internals/release-policy.md)).
- **JSON schema versioning policy** documented in
  [docs/internals/json-schemas.md](docs/internals/json-schemas.md).
- **Routing-as-sidecar design** captured in
  [docs/internals/routing-sidecar-design.md](docs/internals/routing-sidecar-design.md).
  Implementation deferred to 1.16.0 with a one-shot `rk migrate
  routing-to-sidecar` verb and dual-read deprecation cycle.

### Changed

- **GitHub release creation runs before npm publish** in
  `.github/workflows/publish.yml`. Release-create is cheap and revertible
  (`gh release delete`); npm publish is permanent. A missing CHANGELOG section
  or transient `gh` failure now aborts before the artifact ships to npm.
- **CHANGELOG release-notes extraction uses literal-string matching**
  (`awk index()`) instead of regex, and accepts both ASCII hyphen and em-dash
  separators. Missing sections fail loud (`::error::`) instead of silently
  shipping a generic `RepoKernel <tag>` body.
- **`rk run --from-tracker` requires explicit `--agent`.** Tracker import +
  ID allocation + alias write + agent dispatch is four side effects under one
  verb; the implicit default-agent dispatch was a foot-gun. Pass
  `--agent manual` for import-without-dispatch.
- **`mutateSprintRouting`** centralises routing merge/replace/clear semantics
  in `packages/cli/src/integrations/routingMetadata.ts`. The three
  `rk sprint routing` callers no longer spread `...readRouting(extras),
  ...routing` at the call site.
- **`rk sprint routing` no longer requires `loadProject` to succeed.** A
  lighter `locateSprintFile` walks `paths.sprints` and matches on frontmatter
  id, so a project with unrelated findings does not block routing edits on a
  healthy sprint.
- **`rk sprint routing clear` returns `prior_routing`** in JSON output and
  prints the cleared keys in text mode.
- **Plugin commands no longer each invoke `rk team status`.** The session-level
  preflight is described once in `SKILL.md`.
- **`rk doctor` `.gitattributes` check tokenises** instead of byte-matching the
  full line. A user adding `text eol=lf` no longer triggers a false-positive
  doctor failure.
- **README mechanism table** reads "Git merge driver (per-clone install) — ..."
  for scan-time honesty parity with the body.

### Fixed

- **`collectOperationalStatus`** no longer swallows worktree-scan failures
  with a bare catch. Errors surface via `operational.collection_errors`.
- **`--from-tracker` parses the ref before consuming stdin.** A malformed
  `--from-tracker bad-ref` no longer eats stdin from a one-shot pipe before
  failing with a usage error.
- **Tracker ticket title rendering** strips leading markdown structural
  characters to neutralise heading-injection from attacker-controlled tracker
  titles.
- **Synthesized epic frontmatter routes every tracker scalar through
  `yamlScalar`.** `tracker_assignee` previously bypassed `yamlScalar` in the
  null branch; YAML-edge strings (`"null"`, `"true"`, `"yes"`, leading `*`)
  are now safe by contract.
- **`rk team status` no longer double-counts corrupt run files** between
  `operational.corrupt_run_files` and `bottlenecks`.
- **`rk validate` regex compile** hoisted out of the inner `findIndex`. ReDoS-
  safe (entityId escaped); compiles once per finding instead of once per
  finding × line.
- **Release script preflight** asserts CHANGELOG has either an `[1.15.0] - 2026-05-06`
  block or a literal `## [<next>] - YYYY-MM-DD` heading before the version
  bump. Missing notes abort before any mutation.
- **Release script post-commit recovery** prints exact recovery commands when
  `git push` fails after the local release commit and tag are created.
- **`docsTruth` test** no longer reads `git tag --list` (passes vacuously on
  shallow CI clones). Tag/CHANGELOG parity moved to `scripts/release.sh`
  preflight.

### Schema

- **TeamStatusSchema v2.** New `schemaVersion: literal(2).default(2)` field;
  new `operational.collection_errors: string[]` field. Backwards-compatible:
  pre-1.14 captures and v1 captures parse via Zod defaults.
- **Preflight cache schema v1.** `<opRoot>/preflight.json` carries
  `schemaVersion: 1`. Mismatched versions are rejected and trigger a re-scan.

## [1.14.1] - 2026-05-06

Brutal review fixes for the v2 merge-safety story. Three correctness bugs in
the registry merge primitives (sticky `health.blocked`, delete-vs-modify
resurrection, cross-sprint queue id borrow) plus an inverted `execution_strategy`
tiebreak made the marketed merge-safety guarantees unreliable in long-running
projects. Also reorganises the v2 register module by feature, hardens the gh
bridge against PR-body leakage in error paths, and reintroduces the deprecated
`parallel.stallThresholdMs` / `parallel.stallPollIntervalMs` config keys via the
existing `KNOWN_DEPRECATED_FIELDS` shim so 1.13 → 1.14 upgrades no longer fail
strict-schema validation.

### Fixed

- **Registry merge `health.blocked` no longer becomes a sticky bit.** Previously
  `mergeRegistries` OR'd `local.health.blocked || remote.health.blocked || ...`,
  which made the bit monotonically true and broke the documented "regenerate
  from entity files" recovery path. The new implementation only carries an input
  `blocked: true` forward when that side STILL has findings that justify it, so
  custom-threshold P2 findings remain blocked while stale poisoning clears.
- **Three-way merge driver no longer resurrects deleted entities on
  delete-vs-modify conflicts.** `mergeRegistriesThreeWay` now drops the
  modified side too when emitting a `delete_modify` conflict, so the merged
  registry honors the deletion semantically rather than silently reviving the
  entity in the registry payload while reporting a conflict in the sidechannel.
- **`mergeQueueSlots` no longer produces duplicate slot ids.** Cross-sprint slot
  id reuse on diverged branches (e.g. local `Q-001/S-1` + remote `Q-001/S-2`)
  used to collapse to two slots both with `id: Q-001`. The merge now detects
  the collision, surfaces a `queue_id_collision` MergeConflict, renames the
  loser deterministically, and `checkRegistryIntegrity` gained a new
  `queue_duplicate_slot_id` rule.
- **`epic.execution_strategy` precedence inverted to favour `sequential`.** The
  generic `resolveOptionalDivergent` lex-min tiebreak made `parallel` always win
  on conflict (`'p' < 's'`). It now uses an explicit conservative-by-default
  precedence map so `sequential` wins, mirroring `parallel_limit`'s pick-the-
  smaller behaviour.
- **`sameEntry` now uses `node:util.isDeepStrictEqual`** instead of raw
  `JSON.stringify`. Logically-equal entities with different key insertion
  orders no longer produce false `delete_modify` conflicts.
- **`pickProject` composite key uses `JSON.stringify({id, name})`** so the tie
  is injective for any string values; the prior NUL-separator scheme was still
  collidable for pathological inputs.
- **`resolveOptionalDivergent` requires an explicit `compare` callback** so
  callers cannot accidentally fall back to lex-min for a domain-specific enum.
- **`sprintExtras` lock key is now SHA-256 of the canonicalised path.** The
  previous `/`→`_` sanitiser produced demonstrable collisions on conventional
  monorepo paths (`/a/b/c.md` vs `/a-b-c.md`); the canonicalisation also
  serialises symlinked-cwd vs absolute-path callers under the same lock.
- **`mutateSprintExtras` collapses the prior double-read.** `mutateSprintFrontmatter`
  now accepts a transformer function so the extras helper does a single
  read-parse-write under the lock instead of reading the file twice.
- **`runTrackerLinkCommand` validates the `--url` separately from
  `makeInitialMetadata`.** The previous code conflated URL-validation failures
  with any other schema rejection, leading to misleading "invalid issue URL"
  errors when the underlying problem was something else. Invalid provider and
  invalid issueId now both return `EXIT_USAGE` (previously `EXIT_FINDINGS` for
  invalid provider — asymmetric and surprising for wrapper scripts).
- **gh CLI error scrubbing now strips multi-line `Command failed:` prefixes**
  in both `integrations/github/client.ts` and `trackers/gh.ts`. The prior
  regex used `.*?` which does not match `\n` in JS, so multi-line PR/comment
  bodies leaked from line 2 onward into surfaced reasons.
- **`parseGhRef` regex now allows `_`-leading repository names** like
  `_dotfiles` / `_site` (GitHub permits these).
- **`gh transition` accepted-states are now data-driven** via a `Record` map
  instead of an inline if/else chain.

### Added

- `gh` env allowlist gained `LOCALAPPDATA`, `HOMEDRIVE`, `HOMEPATH`, `LANG`,
  `LC_ALL`, `TMPDIR` / `TMP` / `TEMP`, `NODE_EXTRA_CA_CERTS`, `CURL_CA_BUNDLE`,
  `REQUESTS_CA_BUNDLE`, `ALL_PROXY`, `GH_NO_UPDATE_NOTIFIER`, `GH_PAGER`. Closes
  the silent-auth-failure on Windows-LOCALAPPDATA configurations and the
  unicode-mojibake on non-ASCII issue titles.
- `parallel.stallThresholdMs` and `parallel.stallPollIntervalMs` are now
  declared in `KNOWN_DEPRECATED_FIELDS` so existing 1.13 configs load with a
  P3 deprecation finding instead of failing strict-schema validation.
- New `MergeConflictKind`: `queue_id_collision`. New
  `RegistryIntegrityIssue` kind: `queue_duplicate_slot_id`.
- New tests covering: blocked-bit clearing path, sequential-wins precedence,
  delete-vs-modify registry-state assertions, cross-sprint queue id borrow,
  invalid URL scheme rejection, exit-code symmetry on invalid input.

### Changed

- `registers/v2.ts` split into `registers/{team,tracker,pr,registryMergeDriver}.ts`
  by feature axis, matching the existing `registers/{create,lifecycle}.ts`
  convention. The "v2" filename was a chronological dumping ground; nothing
  about it cohered semantically.

## [1.14.0] - 2026-05-05

### Added

- Team-mode v2 surface: `rk team status`, registry merge driver, tracker write bridge, PR bridge, and advanced parallel dispatch primitives.

### Changed

- README repositioned around local-first multi-agent coordination and merge-safe state.

## [1.13.3] - 2026-05-01

### Fixed

- Resolved four open DomicileVault rk-issues across validation, next, review, and close flows.

## [1.13.2] - 2026-05-01

### Fixed

- Fixed strict-null TypeScript regressions in extended fix and recover tests after the crash-recovery coverage pass.

### Documentation

- Added the crash-recovery journal architecture document and linked it to issue #38.

## [1.13.1] - 2026-04-30

### Added

- `rk queue remove` and `rk reopen` support for cancelled sprints returning to planned work.

## [1.13.0] - 2026-04-30

Tracker-friendly quick wins. Three independent additions designed to make
RepoKernel usable on repos that already have an external tracker
(JIRA / Linear / GitHub Issues) without forcing team-wide adoption: a
read-only tracker bridge, a custom branch-naming pattern, and an official
GitHub Action that runs `rk validate` as a CI gate. No SaaS, no daemon,
no Jira-clone. Solo founder ICP holds; this is TAM expansion, not pivot.

### Added

- **`rk create epic --from-tracker <source>:<ref>`** — pulls title,
  description, labels, assignee, and URL from JIRA Cloud / Linear /
  GitHub Issues into the new epic's frontmatter. Forms:
  `gh:owner/repo#NNN`, `jira:KEY-NN`, `linear:ABC-NN`. Linkage stored
  under existing `extras` field (no schema change) at
  `extras.external_id`, `extras.tracker_source`, `extras.tracker_url`,
  `extras.tracker_labels`, `extras.tracker_assignee`. Auth via env vars
  (`JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN`,
  `LINEAR_API_KEY`) or `gh` CLI. Read-only ingest: offline / 401 / 404
  / 5s timeout / missing creds emit a stderr warning and fail closed
  before any disk write; `--allow-tracker-fallback` opts into creating
  a plain epic from the user-provided fallback title. Tracker bodies are
  normalized, capped, and written as fenced external context, not as
  agent-facing instructions.
  Network call runs before ID counter advance, so failure does not
  skip an `E-NNN` slot. Adapter pattern at
  `packages/cli/src/trackers/` mirrors the agent registry shape;
  single dispatch via `getTrackerAdapter`.
- **Custom worktree branch patterns** — `worktrees.epicBranchPattern`
  and `worktrees.sprintBranchPattern` explicitly override the default
  `${branchPrefix}epic/${epicId}` and
  `${branchPrefix}sprint/${epicId}/${sprintId}` naming.
  `worktrees.branchPattern` remains as shorthand: without `{sprintId}`
  it applies to epic branches; with `{sprintId}` it applies to sprint
  branches. Tokens (v1.13): `{branchPrefix}`, `{epicId}`,
  `{sprintId}`. Reserved for v1.14 (rejected at render with a clear
  error): `{ticket}`, `{slug}`. Config load validates both patterns and
  representative rendered Git refs, including `branchPrefix`, dot
  components, `.lock` components, and epic/sprint ref-path collisions.
  When custom patterns are unset, current default behavior is
  byte-identical.
- **`xantorres/repokernel/.github/actions/rk-validate@v1.13.0`** —
  composite GitHub Action that runs `rk validate --json` as a PR
  gate. Inputs: `fail-on` (default `P0,P1`), `working-directory`,
  `version` (default `latest`, recommended pin), `json-artifact`,
  `comment-on-pr`. Outputs: `exit-code`, `findings-json`. Posts a
  sticky PR comment with severity counts and the first 25 findings;
  emits inline `::error file=...,line=...::message` annotations;
  uploads JSON findings as a workflow artifact (14-day retention).
  Skips gracefully (neutral exit `0`) when
  `repokernel.config.yaml` is absent so the action can be added to
  org-wide reusable workflows without blocking unadopted repos.
  Treats `EXIT_RUNTIME` (`2`) as a failed action with stderr surfaced,
  while still uploading/commenting on findings breaches before the
  final failing step. Workflow annotations escape GitHub command
  metacharacters, PR comments read `rk-findings.json` through a
  workspace-confined env path, and the smoke workflow installs the
  locally packed CLI instead of `repokernel@latest`.
- **`JIRA_ALLOW_PRIVATE_HOSTS=1` env opt-in** for self-hosted JIRA
  Server / Data Center on RFC1918 private networks. Loopback hosts
  (`127.0.0.1`, `localhost`, `::1`) stay blocked unconditionally to
  preserve SSRF defense.
- **`treat-runtime-as` Action input** (`failure` default, or
  `neutral`). Lets teams with flaky CI infra opt to convert
  `EXIT_RUNTIME` (`2`) into a neutral exit `0` so transient
  `repokernel` install hiccups or runtime crashes do not block
  unrelated PRs.
- **`CONFIG_INVALID` `RepoKernelErrorKind`** for render-time
  configuration errors (branch pattern violations, malformed tracker
  refs, reserved-token usage). Distinct from `CONFIG_FILE_UNREADABLE`
  / `CONFIG_FILE_NOT_FOUND` so error reporting can route correctly.
- **Skill bumped to 0.5.0.** `packages/cli/plugin/skills/repokernel/`
  and `packages/cli/plugin/commands/rk-plan.md` teach agents about
  the three quick wins. `examples/skills/repokernel-operator/` mirrors
  for in-repo browsing.
- **New docs:** [docs/usage/trackers.md](docs/usage/trackers.md) (full
  bridge contract, auth, failure semantics, security notes),
  [docs/usage/ci.md](docs/usage/ci.md) (action inputs, behavior
  matrix, pinning, fork instructions),
  [docs/recipes/tracker-driven-flow.md](docs/recipes/tracker-driven-flow.md)
  (end-to-end recipe wiring all three).

## [1.12.1] - 2026-04-30

### Documentation

- Updated the bundled operator skill metadata and changelog for the 1.12.0 hardening release.

## [1.12.0] - 2026-04-30

Closes the 17-finding master-blueprint hardening pass. Ten PRs landed
against `main` followed by a single consolidated commit applying the
blocker + high review fixes surfaced by parallel sonnet code reviews.

### Added

- **`rk recover --preview | --apply`** — audits operational state under `<git-common-dir>/repokernel/` for corruption (`worktrees.json` parse failures, `RUN-NNN.json` schema failures, stale lane claims with dead PIDs or terminal owner runs) and, on `--apply`, quarantines corrupt files as `<path>.corrupt.<isoUtc>.<rand>` before rebuilding `worktrees.json` from `git worktree list --porcelain`. Branch-shape regex anchored on `worktrees.branchPrefix` so foreign branches (`feature/E-001`, `topic/E-1/S-2`) are not adopted. Apply path runs under `withLockRetrying('recover', opRoot)` so concurrent invocations serialize. `rk doctor` surfaces operational corruption and points at this command.
- **`rk create sprint --enqueue`** — synthesizes the queue slot and sets `status: queued` in one step. Errors loudly when the lane has no queue file (pre-flight check before any disk mutation, no orphan state).
- **`--json` envelope on every `rk create <kind>`** — stable `{ kind, id, file, updated, next_actions }` shape so agents can chain without parsing prose.
- **`safeRepoPath(cwd, rel)` + `LaneNameSchema` + `escapeRegexLiteral`** exported from `@repokernel/core`. Lane names are now strict single-segment identifiers (rejects `.`, `..`, `.git`, `/`, `\`, NUL, Windows reserved device names) and apply across `LaneFrontmatterSchema`, `SprintFrontmatterSchema`, `QueueFrontmatterSchema`, `RunSchema`, and `policies.defaultLane`.
- **`atomicWriteText` + `atomicCreateText` + `StickyRedactor`** in `packages/cli/src/lifecycle/`. `atomicCreateText` falls back from `link()` to rename-with-precheck on `ENOTSUP`/`EPERM`/`EXDEV` for non-hardlink filesystems. The sticky redactor scrubs multi-line PEM-style private-key bodies end-to-end (per-log-file state in `runLogs.appendLog`).
- **`automation.checksTimeoutSeconds` (default 1800s)** with SIGTERM/SIGKILL escalation and process-group cleanup; `agents.<name>.envPassthrough` for explicit env opt-in. Default agent env allowlist now covers Windows essentials (USERPROFILE, APPDATA, LOCALAPPDATA, SYSTEMROOT, SYSTEMDRIVE, WINDIR, COMSPEC, PATHEXT, PROCESSOR_ARCHITECTURE/IDENTIFIER, NUMBER_OF_PROCESSORS) plus locale (LANG, LC_ALL, LC_CTYPE) and color env.
- **`effectiveReviewRequirement` + `effectiveReviewRequired`** helpers in `@repokernel/core/validator`. Returns a discriminated reason (`'project-opt-out' | 'sprint-flag' | 'threshold' | 'none'`) so `reviewIntegrityRule` can scope live emission to the threshold-bypass path only (legacy per-sprint-flag stays audit-only).
- **Architecture split: `registers/create.ts` + `registers/lifecycle.ts` + `util/program.ts`** — index.ts shed ~140 lines. Help-snapshot test pins the externally-observable command surface so future refactors can't silently change the verb table.

### Changed

- **`rk run --mode <value>` and `rk runs --status <value>`** validate against `RunModeSchema` / `RunStatusSchema`. Bad input exits `EXIT_USAGE` (64) instead of silently coercing to `assisted` / returning empty results.
- **`isWorktreeCheckout`** uses realpath-canonicalized paths for the comparison and short-circuits identical raw strings (preserves the `.git` literal guard).
- **`commonGitDir`** routes through `normalizeGitPath` so `operationalRoot` (and every state path built on it) compares canonical filesystems.
- **All RK state writes go through `atomicWriteText` / `atomicCreateText`**: `mutate.ts`, `registry.ts`, `runState.ts`, `laneState.ts`, `counters.ts`, `worktree.ts`, `fastpath/taskAlias.ts`, `fastpath/synthesize.ts`, `commands/queue.ts` (locked `appendSlotToQueue`), `commands/registry.ts`. Atomicity from temp+rename; durability across kernel-level crash is owned by `rk recover`.
- **Concurrency boundaries tightened**: `releaseLane` re-reads ownership inside `withLock(\`lane-${lane}\`)`; `appendSprintToEpic` runs under `withLockRetrying(\`epic-sprints-${epicId}\`)`; fastpath `synthesizeTaskState` wraps the entire id-allocation + write sequence in a single `fastpath-create` lock with bounded EEXIST retry loops (max 50 per artifact). Alias is published with fully-formed content (no placeholder leak on crash).
- **Exit-code table**: documented all six exit codes (0/1/2/3/4/64) with constant names in `docs/internals/cli-reference.md`. Doc-truth test pins it.
- **Operator skill verdict** corrected from `approved` → `accepted` to match the actual review-verdict enum.

### Fixed

- **Configured writes inside `.git`** — `paths.*` values containing `.git` segments are rejected at config load.
- **Lane traversal** — `--lane ../../x` rejected at CLI boundary AND at every schema consuming `lane`.
- **Regex injection at the CLI boundary** — `findEntityFile`, `deterministicReviewId`, `findReviewFile`, and the fastpath sprint-status regex all route ids through `escapeRegexLiteral`. CLI surfaces validate `--epic` (`EpicIdSchema`) and `--after` (`SprintIdSchema`) before the regex stage.
- **`rk validate` review-policy bypass** — the threshold path (`requireReviewForShippedFromSprintId`) is now caught at live scope; the legacy per-sprint-flag path stays audit-only so existing projects don't go noisy on upgrade.
- **`runConfiguredChecks` timeout never reached close paths** — `lifecycle.ts` (sprint close) and `epic.ts` (`epic close --run-checks`) now route through `runConfiguredChecksFromConfig` so `automation.checksTimeoutSeconds` actually applies.
- **External agent env leak** — custom agents (`agents.<name>` config blocks) no longer inherit the parent's `OPENAI_API_KEY`, AWS creds, etc. unless explicitly opted in.
- **Log secret leakage** — `appendAgentLog` / `appendLifecycleLog` route every line through `redactSecrets` + the sticky PEM redactor before writing.
- **Ollama symlink read/write** — context-gather skips tracked symlinks via `lstat`; the new `assertWriteSafe` helper realpath-resolves the closest existing ancestor and rejects writes through tracked-symlink-to-outside.
- **Quarantine timestamp collisions** — `rk recover --apply` quarantine names include 6 bytes of entropy.

### Internal

- Coverage gate enforced on the root `ci` script (`pnpm -r test:coverage` after tests). Thresholds: core 88/84/91/88, cli 60/75/80/60. The cli stmts/lines floor lifts past 80% once the deferred run.ts split lands.
- Test count: 327 core + 900 cli + 1 skipped pass (was 290 + 808 pre-blueprint).
- 17 of 17 blueprint findings closed. 30 of 30 sonnet code-review findings (8 blocker, 13 high, 9 nit) addressed in the consolidated follow-up commit.

## [1.11.0] - 2026-04-29

### Added

- **`rk fix --apply` mechanically resolves two new finding categories.** `SHIPPED_SPRINT_IN_QUEUE` and `CANCELLED_SPRINT_IN_QUEUE` now auto-route to a `remove-sprint-from-queue` safe-fix that drops the dead slot from the lane queue (the live close path already cleans the queue; this addresses pre-fix backlog and recovery scenarios). `SPRINT_WORKTREE_LEAKED` findings split by safety class: ghost records (path no longer on disk) become a `prune-leaked-worktree-record` safe-fix that scrubs the entry from `worktrees.json` under the existing lock; entries whose path still exists stay as a manual suggestion with the exact `git worktree remove "<path>"` command pre-populated, since `--force` removal is destructive.
- **`rk inspect <id> --json` gains a `derived` block (additive, schemaVersion=1).** Sprint inspect emits `derived.depends_on_resolved` (each dep's current status), `derived.review_resolved` (linked review's verdict, with a `verdict: 'missing'` sentinel when the file is gone), and `derived.epic_resolved`. Epic inspect emits `derived.sprints_progress` (`total` / `shipped` / `cancelled` / `in_flight` / `remaining_ids`). Review inspect emits `derived.sprint_resolved` (always present — `status: 'missing'` sentinel when the linked sprint is absent). All resolution uses the existing graph; no extra fs reads. Replaces multi-call jq patterns over `rk ls`.
- **`rk ls sprints --last N`.** Returns the N most recent sprints by activity timestamp (`closed_at ?? started_at` desc; tied timestamps tiebreak by id desc, deterministic). Combinable with the existing `--epic` / `--status` / `--lane` filters.
- **`rk next --json` enriched (additive).** Three new top-level fields — `active_epic_progress` (the lex-first `status: active` epic's progress, partitioned identically to `rk inspect`'s `sprints_progress`; `null` when no epic is active), `last_closed` (most recent `closed_at` across the project, any lane / epic), and `queue_depth` (`{ lane, slots, queued, active }` for the resolved lane). All three appear regardless of `result` so consumers don't branch on lifecycle state.

### Changed (additive — no schema break)

- **`rk ls epics --json` shape: dense `sprintCounts` plus `total`, `progressPercent`, `sprints`.** `sprintCounts` is now zero-filled across all 8 `SprintStatus` keys (planned, pending, queued, active, review, shipped, reopened, cancelled) — consumers no longer need `?? 0` guards. New top-level fields: `total`, `progressPercent` (round((shipped/total)*100)), and `sprints` (ordered id array). Terminal table view unchanged.
- **CLI `--last` guard hardened.** `rk ls sprints --last 0` and `--last -N` now produce a clear stderr message and exit 2 at the CLI layer (previously only the command layer rejected them, which made library callers see a different error path).

### Documentation

- **`repokernel-operator` SKILL.md hardens id-allocation + cwd rules.** §1 Authority adds two explicit bans: (a) never derive next ids by listing `.repokernel/plan/**` — `rk create <kind>` allocates under a lock; (b) confirm `rk status --json .configPath` matches user intent before any mutating call. §2 ban on `grep`/`ls` substitution extends to entity-id derivation. §3a (new) shows the canonical scaffolding flow with `--after S-PREV` for sequential chains. §9 anti-patterns adds the two new entries. §10a (new) documents machine-readable shapes for `rk inspect`, `rk ls`, and `rk next` — one source of truth instead of agents reverse-engineering rendered text. The bundled `/rk-plan` slash command body mirrors these rules; planning is where the id-derivation trap most often fires.

### Internal

- New CLI surface tests: `packages/cli/test/fix.test.ts` (queue + worktree safe-fixes), `packages/cli/test/inspect.test.ts` (derived block + missing sentinels). Existing `ls.test.ts` and `next.test.ts` extended for the new fields. Total: 794 → 808 tests.

## [1.10.1] - 2026-04-29

### Added

- **`rk review-aggregate --findings <json>` — third aggregation mode for finding-driven panels.** Accepts a `ReviewFinding[]` JSON array (the same schema written by `rk review-create` and panel agents), maps each finding's severity to a panel contribution (`CRITICAL`/`HIGH` → RED, `MEDIUM` → YELLOW, `LOW` → GREEN), and returns the RED-dominant aggregate. Mutually exclusive with `--verdicts` and positional sprint-id; exits `EXIT_USAGE` if combined. `--json` emits `{aggregate, source:'findings', findings_count}`. Intended for downstream pipelines (e.g. DomicileVault `review-sprint.md`) that write findings directly to `R-NNN.md` without going through a multi-reviewer panel: `rk review-aggregate --findings "$(jq -c '.findings' reviews/R-NNN.md)"`.
- **`rk review-create --sprint <id>` — hand-author a review stub with the full v2 scaffold.** Allocates a fresh `R-NNN` ID (or returns the existing pending stub — idempotent), then writes a richer body: YAML frontmatter with `id`, `sprint_id`, `verdict: pending`, `findings: []`, `created_at`, `changed_files`, `paths_checked`; and body sections `## Summary`, `## Findings`, `## Verdict` with authoring instructions. Intended for agents or humans that write findings inline rather than via a multi-reviewer panel. `--json` emits `{reviewId, sprintId, file, reused}`. Idempotency: a second call for the same sprint returns the existing stub with `reused: true` without overwriting the file.
- **`rk next --json` now includes per-slot `reason[]`.** Each entry in the `queue` array gains a `reason: string[]` field explaining why a sprint is not runnable (`[]` for runnable sprints). Agents previously had to infer the blocking cause from human-readable output; this surfaces the same logic as a machine-readable array to avoid wasted turns.

### Changed (BREAKING)

- **Validator rules now carry a `scope` tag — `live` (default) or `audit` (opt-in).** Long-lived projects accumulate "historical hygiene" findings on frozen shipped state — e.g. shipped sprints missing `base_sha` / `closed_at` / `end_sha` / accepted review because the close pipeline did not capture them at the time. These findings are not actionable post-ship (the data cannot be cheaply backfilled, the audit need rarely actualizes) and yet re-fired on every `rk validate` / `rk report` / `rk status` run, producing dozens or hundreds of noise lines per dogfooded project (115+ `SHIPPED_SPRINT_MISSING_BASE_SHA` in DomicileVault alone). The fix encodes the **frozen-state principle** as a first-class validator concept: rule registrations declare `scope: 'live' | 'audit'` and `runValidators({ ..., scope })` filters by scope (default `live`, pass `'all'` for both). The `shippedFieldsRule` (which emits all four `SHIPPED_SPRINT_MISSING_*` codes) is tagged `audit`; every other rule stays `live`. `rk validate` grows a new `--audit` flag to opt into the full surface; `rk report`, `rk status`, lifecycle gates (`rk run`, `rk start`, `rk close`, etc.) and registry generation all default to `live` and are now noise-free on historical data. `rk fix` always runs both scopes — its job is to repair fixable gaps regardless of whether they surface to validate by default. New core exports: `ValidatorScope` type, `ScopedRule` interface; `ValidationContext` and `ValidateProjectInput` both gain optional `scope` field. Migration: any CI relying on `rk validate` failing on `SHIPPED_SPRINT_MISSING_*` codes must now pass `--audit` (and ideally `--fail-on` explicitly); downstream code that imports the `rules` array from `@repokernel/core` must change `for (const rule of rules) rule(input)` to `for (const r of rules) r.run(input)` (and may filter on `r.scope`).
- **`rk report` is now a pure-console command with a lean default view.** It no longer writes a local HTML file or opens a browser; the report renders ANSI-colored text directly to stdout (respects `NO_COLOR`). The `--out <path>` flag is removed. The default view is signal-dense: a one-line headline (`<projectId> · N epic(s) · N sprint(s) · <health>`), an `EPICS` dashboard ranked by activity (active sprints listed under each epic; archived epics summarised as `+N archived (use --all)`), and a `NEXT` line that explains why no runnable sprint exists when blocked. Findings are aggregated by code (e.g. `SHIPPED_SPRINT_IN_QUEUE  ×2`) rather than dumped per-entity; `--all` expands the dashboard to every epic, every sprint per epic, and the per-entity findings list. `--json` now emits the **full** structured report (`project`, `generatedAt`, `counts`, `maxSeverity`, `next`, `epics[]`, `sprints[]`, `findings[]`) instead of `{ report: { path } }`. Migration: replace any `rk report --out X.html` automation with `rk report --json > X.json` (or just `rk report` for terminal viewing).

## [1.10.0] - 2026-04-29

### Added

- **`rk review-aggregate` — compute the panel verdict (GREEN/YELLOW/RED) outside `rk review-sprint`.** Wraps the existing `aggregateVerdict()` helper as a top-level CLI command so downstream protocol authors building their own multi-agent panels can ask RepoKernel for the canonical RED-dominant aggregate without re-implementing the rule. Two modes: `rk review-aggregate <SPRINT_ID>` reads the latest panel run from the sprint's review and returns its aggregate; `rk review-aggregate --verdicts GREEN,YELLOW,RED` aggregates an inline list with no project context required. Flags: `--json` emits a structured envelope (`aggregate`, `source`, `sprint_id`, `review_id`, `round`, `reviewers[]`); `--fail-on <GREEN|YELLOW|RED>` returns `EXIT_FINDINGS` when the aggregate is at least this severe, for shell-pipeline gating.
- **`rk brief` — render a markdown action-handoff brief from sprint or epic state.** Closes the pause-gate brief gap noted in downstream protocol audits. Sprint mode auto-detects the gate from current state — `review-fail` (verdict is `changes_requested` or `rejected`), `ready-to-close` (`accepted`), `pause` (`pending`), `blocked` (unshipped `depends_on`), or `status` (default) — and renders a templated markdown brief including the latest panel-run breakdown, findings, and a fenced "Suggested next action" with the exact `rk` command to unstick the gate. Epic mode renders the sprint table with per-row status, progress fraction, the next runnable sprint, and the suggested next action (`rk start`, `rk next`, or `rk epic close` depending on completion state). Flags: `--gate <type>` forces a specific template; `--json` emits a structured envelope including the markdown.
- **`rk scaffold command <name>` — generate the canonical `.claude/commands/<name>.md` + optional `.agents/protocol/<name>.md` skeleton pair.** Removes the boilerplate every downstream consumer otherwise writes by hand. Output is intentionally vendor-agnostic — the command file records the caller's abstract tier (e.g. `orchestrate`, `fast`, `synthesis`) as a comment, not a `model:` field; consumers add `model:` per their harness's tier-to-model mapping after scaffolding. The `vendorAgnostic` CI guard in `@repokernel/core` ensures no vendor model identifier (haiku/sonnet/opus/gpt-N/claude-N) leaks into the runtime source. Flags: `--description`, `--arg-hint`, `--tier`, `--with-protocol`, `--commands-dir`, `--protocol-dir`, `--force`, `--json`. Naming is enforced kebab-case for filesystem and slash-command-surface portability. Files refuse to overwrite by default; `--force` opts in.
- **`docs/recipes/protocol-layer.md` — cookbook for project-owned orchestration on top of `rk`.** Reference walkthrough for downstream consumers building their `.agents/protocol/*.md` + `.claude/commands/*.md` layer. Covers why `rk` intentionally does not ship project-specific orchestration (multi-agent panels, founder-action briefs, chained-epic loops), the two-layer commands+protocols pattern with the canonical 1-line command body, anatomy of both file types, worked examples using the new `rk review-aggregate` and `rk brief` helpers, the chained-epic sub-agent spawn pattern with halt conditions, anti-patterns, and how the recipe relates to the operator skill. Plus `docs/recipes/README.md` as the recipe index.

### Changed

- **Lifecycle verbs reordered (plan first) in README and the bundled plugin skill.** Both surfaces previously listed the six verbs in implementation order (`status, next, run, review, doctor, plan`), placing `plan` last despite being the first verb a new user should reach for. Reordered to lifecycle order — `plan` first (scope work before anything else), `doctor` last (diagnostic, not lifecycle): `plan → status → next → run → review → doctor`.

## [1.9.1] - 2026-04-29

### Added

- IDE adapter installs for Cursor, Windsurf, Copilot, Gemini CLI, and opencode through `rk install-skill`.
- `rk path-policy` and dynamic state-protection hook support for custom RepoKernel state directories.

### Changed

- Renamed `rk init --plan-dir` to `rk init --dir` and relocated generated state consistently under the configured base directory.
- Refreshed onboarding, reporting, README positioning, and browser-opening report UX.

## [1.9.0] - 2026-04-29

### Added

- Agent-operated plugin surface with `rk install-skill`, slash commands, hooks, and hardening for fresh-repo operation.

### Fixed

- Aligned plugin command contracts, slash names, and install behavior after the initial agent-operated workflow rollout.

## [1.8.2] - 2026-04-29

### Fixed

- Batch CLI hardening: flush-aware error pipeline, enum parsing, nested cwd discovery, mutation guards, `--unshipped`, and epic auto-close fixes.

## [1.8.1] - 2026-04-29

### Added

- End-to-end Claude Code and Codex walkthrough docs plus an asciinema fastpath demo asset.

### Fixed

- Resolved rk binary symlink detection before entrypoint checks.

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

## [1.7.1] - 2026-04-29

### Added

- `rk context` v1 deterministic context packet compiler and related worktree-head diff support.

### Fixed

- Hardened context overflow handling, path-label parsing, and budget-exceeded exit behavior.

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

## [1.5.4] - 2026-04-28

### Added

- `rk cancel`, idempotent review allocation, and specific review parse finding codes.

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

## [1.0.0-rc.2] — 2026-04-27

### Fixed

- Tightened RC1 edges around agent defaults, cwd hints, targeted staging, SHA capture, and stable publish gating.

## [1.0.0-rc.1] — 2026-04-27

### Added

- RC1 readiness pass for sprint metadata hardening, vendor-agnostic agent runners, NEXT.md slot system, and review-panel foundations.

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
