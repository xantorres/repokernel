# CLI

The `repokernel` CLI is a thin wrapper around the core. All four commands accept a global `--cwd <path>` (default: `process.cwd()`).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean: no findings at or above threshold. |
| `1` | Findings at or above threshold (or drift detected). |
| `2` | Config / runtime / tool error. |

## `repokernel validate`

Loads the project, parses entities, builds the graph, runs validators, prints findings.

```
repokernel validate [--cwd <path>] [--json] [--fail-on P0|P1|P2|P3]
```

Default `--fail-on` is `P1`. Findings are sorted by `(severity, code, entityId, file)`.

JSON output:

```json
{
  "configPath": "...",
  "cwd": "...",
  "findings": [...],
  "threshold": "P1"
}
```

## `repokernel status`

Summarizes project health, sprint counts, max severity, and the next runnable sprint for the default lane.

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

## `repokernel registry`

Generate, write, or check the registry.

```
repokernel registry [--cwd <path>] [--json] [--write] [--check]
```

Without flags, prints the registry as canonical JSON to stdout.

`--write` writes to `config.paths.registry` (creates parent dir if missing). Returns exit `0` on success.

`--check` compares regenerated state against the file on disk. Exit `0` if no drift, `1` with `REGISTRY_DRIFT` if content differs. Volatile metadata (`generatedAt`, `generatedBy`) is excluded from comparison.

The registry shape is documented in [`packages/core/src/schemas/registry.ts`](../../packages/core/src/schemas/registry.ts).
