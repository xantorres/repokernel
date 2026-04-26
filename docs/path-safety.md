# Path safety

RepoKernel enforces file-level boundaries on agent work. Sprints declare which paths they are allowed to modify, and the run loop validates that the agent stayed within those boundaries before a sprint can close.

## `allowed_paths`

`allowed_paths` is a list of repo-relative glob patterns on the sprint frontmatter. When non-empty, every file the agent committed must match at least one pattern. Files outside the declared paths block the sprint from transitioning to `review`.

```yaml
# sprints/S-001-jwt.md
---
id: S-001
allowed_paths:
  - src/auth/**
  - tests/auth/**
---
```

Pattern syntax follows standard glob: `*` matches within a path segment, `**` matches across segments.

When `allowed_paths` is empty, no file restriction is applied (for sequential sprints). For parallel sprints, empty `allowed_paths` is a hard error — the validator blocks the sprint from running in a wave.

## `denied_paths`

`denied_paths` is a blocklist. If any committed file matches a denied pattern, the sprint cannot close regardless of `allowed_paths`.

```yaml
denied_paths:
  - config/production/**
  - .env*
  - secrets/**
```

`denied_paths` takes precedence over `allowed_paths`. A file that matches both is denied.

## Validation timing

Path policy is checked at two points:

1. **When the agent returns its result** — the run loop checks `changed_files` from the sentinel JSON against the path policy before creating the review stub.
2. **At `rk review` / `rk close`** — the lifecycle commands re-check by diffing `base_sha..HEAD` and applying the path policy to the actual git diff.

This double-check means path policy is enforced even when using `rk review` and `rk close` manually, outside of `rk run`.

## Parallel-specific enforcement

In parallel mode, the validator also checks for path conflicts between sprints in the same wave before execution begins. If two sprints declare overlapping `allowed_paths`, the wave is blocked.

```
P1 PARALLEL_SPRINT_PATH_CONFLICT
S-002 and S-003 in the same wave both allow src/shared/**
```

The dry-run command shows this before you start:

```bash
rk run E-001 --parallel --dry-run
```

To see the full wave plan including path conflict detection, always dry-run first.

## Allowing overlap explicitly

If you need two parallel sprints to share a path (accepting the risk of merge conflicts), first enable the override in config:

```yaml
parallel:
  allowOverlapFlag: true
```

Then pass the flag at runtime:

```bash
rk run E-001 --parallel --allow-overlap
```

This suppresses the conflict block. You accept responsibility for resolving any merge conflicts that result.

## Protected paths (reserved)

`git.protectedPaths` in config is reserved for a future feature that will block any sprint from modifying critical files. It has no effect in the current version.

## Tips for writing path policies

- Be specific: `src/auth/jwt/**` is better than `src/**`
- Include test directories: agents that write code should write tests; make sure the path policy covers them
- Include generated files if the agent is expected to produce them (e.g., `dist/**`, `*.generated.ts`)
- Exclude shared config files from individual sprint policies to catch accidental modifications early

## Checking a sprint's path policy

```bash
rk inspect S-001
```

The inspect output includes the sprint's `allowed_paths` and `denied_paths`, and whether the current diff is within policy.

## Related

- [Parallel waves](parallel-waves.md) — path conflicts in wave planning
- [Concepts](concepts.md) — sprint frontmatter schema
- [specs/validation.md](specs/validation.md) — full list of path-related finding codes
