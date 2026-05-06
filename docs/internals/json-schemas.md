# JSON schema versioning

All RepoKernel `--json` outputs declare an explicit `schemaVersion`
integer. Consumers branch on the version; future shape changes bump it
with a documented migration. This page is the registry of versioned
surfaces.

## Why versioned envelopes

`--json` is a public contract — dashboards, CI scripts, internal
tooling, and the rk-validate GitHub Action all depend on stable shapes.
Without a version field, additive changes are observably indistinguishable
from breaks: a consumer that strict-parses sees a new key and either
ignores it (good) or fails (bad). With a version field, intent is
declarative: "I know about v2 and earlier; if I see v3 I'll upgrade or
fail loud."

This is the same play `kubectl`, `gh`, and `terraform show -json` make.
Plain output is human prose; JSON output is API.

## Surfaces

### `rk team status --json`

| Field            | Schema location                                                   |
|------------------|-------------------------------------------------------------------|
| `schemaVersion`  | `packages/core/src/schemas/run.ts → TeamStatusSchema`             |
| Current value    | `2`                                                               |
| Compat behavior  | `operational` and `schemaVersion` are defaulted on the Zod schema |

| Version | Released  | Shape change                                                                |
|---------|-----------|------------------------------------------------------------------------------|
| `1`     | < 1.14.0  | No `operational` block. Implicit (no `schemaVersion` field).                |
| `2`     | 1.15.0    | Adds `operational: { live_claims, corrupt_run_files, leaked_worktrees, active_worktree_count, collection_errors }`. Both `schemaVersion` and `operational` are defaulted, so v1 captures still parse. |

**Migration v1 → v2.** No action required for consumers that ignore
unknown fields. Strict consumers should branch on `schemaVersion === 2`
to read `operational`.

### `rk preflight --json`

| Field            | Schema location                              |
|------------------|----------------------------------------------|
| `schemaVersion`  | `packages/cli/src/commands/preflight.ts`     |
| Current value    | `1`                                          |

| Version | Released | Shape                                                                  |
|---------|----------|-------------------------------------------------------------------------|
| `1`     | 1.15.0   | `{ schemaVersion, captured_at, cache_age_seconds, cache_hit, warnings_count, status: TeamStatus }` |

The cache file `<opRoot>/preflight.json` carries its own
`schemaVersion: 1` and is rejected on mismatch (re-scan triggered).

### `rk validate --json` and `.repokernel/registry.json`

| Field            | Schema location                                                       |
|------------------|-----------------------------------------------------------------------|
| `schemaVersion`  | `packages/core/src/schemas/registry.ts → REGISTRY_SCHEMA_VERSION`     |
| Current value    | `1`                                                                   |

The registry has used a versioned schema since RC1. Findings carry
optional `line` since 1.14 (additive — no version bump needed).

## Promotion policy

When a `schemaVersion` is bumped:

1. The new version becomes default for fresh outputs.
2. The old version's parser remains for one minor release cycle.
3. The CHANGELOG entry includes a `### Schema` section listing the
   bump, the shape change, and the consumer migration.
4. After the deprecation cycle, the parser drops the old version. New
   consumers must upgrade.

Example: TeamStatus v2 lands in 1.15.0 with `.default(...)` so v1
captures parse. In 1.16.0 the default is removed, making `operational`
required. In 1.17.0 the v2 → v1 fallback could be dropped if we ever
need a v3.

## What is NOT versioned

- Plain text output (`rk team status` without `--json`). Renderable
  human prose has no contract.
- Internal data files (lock files, claims, run state). Those are
  RepoKernel-internal and not consumed externally. They use their own
  schema discipline but are not on this list.
- Error messages on stderr. We aim to keep them stable but they're
  human-readable diagnostics, not API.
