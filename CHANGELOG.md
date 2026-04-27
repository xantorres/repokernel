# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
