# ADR: `planning.storage` — tracked vs local planning files

**Status:** proposed  
**Date:** 2026-04-26

---

## Context

RepoKernel currently assumes planning files (epics, sprints, reviews, queues, lanes)
are git-tracked alongside source code. Every sprint worktree therefore inherits a full
copy of the planning state, because tracked files are present in every `git worktree add`
checkout.

Some users want planning files to be local-only (gitignored). Primary use cases:

1. **Solo founders** who don't want planning state in git history or visible to others
2. **Monorepos** where planning and code live in the same repo but planning is private
3. **DomicileVault-style setups** where `.agents/` is intentionally gitignored

The challenge: git worktrees don't include untracked files from the parent checkout.
A sprint agent running in `/tmp/rk-worktrees/myrepo/E-001` cannot read planning files
that exist only on the main checkout at `/Users/xan/projects/myrepo/.repokernel/`.

This ADR defines the architecture for `planning.storage: local` before implementation.

---

## Decision

### Config surface

```yaml
# repokernel.config.yaml
planning:
  storage: tracked   # default — planning files are git-tracked, present in worktrees
                     # local   — planning files may be gitignored, read from control_cwd only
```

No other fields under `planning:` for now.

### Two-CWD model

`loadProject()` gains an optional `planningCwd` parameter:

```typescript
// packages/core/src/api.ts
export async function loadProject(opts: {
  cwd: string;          // where git operations run (may be a worktree)
  planningCwd?: string; // where planning files are read from (defaults to cwd)
}): Promise<LoadProjectOutcome>
```

- When `planningCwd` is omitted or equal to `cwd`: current behavior, unchanged.
- When `planningCwd !== cwd`: config is loaded from `planningCwd`, planning files
  are resolved relative to `planningCwd`, git operations (worktree, SHA capture,
  diff) target `cwd`.

The CLI already tracks `controlCwd` (where the user invokes `rk`) vs the execution
worktree. `controlCwd` becomes `planningCwd` when `storage: local`.

### Call-site contract for `rk run`

```typescript
// packages/cli/src/commands/run.ts
const planningCwd = config.planning?.storage === 'local' ? controlCwd : executionCwd;
const outcome = await loadProject({ cwd: executionCwd, planningCwd });
```

Where `controlCwd` = the directory where the user invoked `rk` (before any worktree
creation), and `executionCwd` = the worktree path (or `controlCwd` itself when
`--no-worktree` is used).

For all commands that don't use worktrees (`validate`, `status`, `next`, `board`,
`registry`, `create`, `init`): `planningCwd` is always omitted — they already run
from the main checkout.

### SHA fields are unchanged

`base_sha` and `end_sha` track git commits in the code repository. They are orthogonal
to whether planning files are gitignored. Both remain required for active/shipped
sprints regardless of `storage` value.

Only validation rules that detect planning-file drift relax under `storage: local`:

| Rule | `tracked` | `local` |
|---|---|---|
| `REGISTRY_DRIFT` | P2 (error) | P3 (warn) — expected; registry is local-only |
| `ACTIVE_SPRINT_MISSING_BASE_SHA` | P1 | P1 — unchanged |
| `REVIEW_BASE_SHA_MISMATCH` | P1 | P1 — unchanged |
| worktree clean-tree check for planning files | enforced | skipped |

### `rk init --local` behavior

```
rk init --local
→ writes repokernel.config.yaml with planning.storage: local
→ appends to .gitignore (precise, not blanket):
    # RepoKernel planning state (local-only)
    .repokernel/registry.json
    .repokernel/generated/
    .repokernel/plan/        ← only if default paths are under .repokernel/
```

If paths are configured outside `.repokernel/`, add those exact paths instead.

Never ignore:
- `repokernel.config.yaml` — shared team config
- `.repokernel/authority.md` — orientation, not planning state

### Registry and run state

Both stay local regardless of `storage` setting:
- `.repokernel/registry.json` — always local (gitignored or not, it's regenerable)
- `.git/repokernel/runs/` — always in `.git/` directory (never committed, already local)

No change needed here.

---

## Alternatives considered

### A — Symlink planning dir into worktree

At worktree creation time, symlink `.repokernel/plan` into the new worktree.

**Rejected:** Symlinks in git worktrees are fragile across platforms. Broken symlinks
produce confusing errors. The two-CWD model is cleaner.

### B — Copy planning files into worktree at run start

At sprint start, copy current planning state into the worktree.

**Rejected:** Creates stale planning snapshots if multiple sprints run concurrently.
Race conditions on writes back to the planning files. The two-CWD model reads from
the canonical source (control_cwd) at all times.

### C — Single-cwd, read planning from always-absolute path

Store planning paths as absolute in config (`/Users/xan/...`).

**Rejected:** Breaks portability. Config can't be shared across machines or team members.

---

## Consequences

### What changes

- `loadProject()` accepts optional `planningCwd` — additive, backward-compatible
- `parseProject()` receives resolved absolute paths already, so no change there
- `rk run` passes `planningCwd = controlCwd` when `storage: local`
- `rk init --local` writes `.gitignore` entries
- `REGISTRY_DRIFT` validator reads `storage` from config to choose severity

### What stays the same

- All SHA-based rules
- All entity schema validation
- All worktree lifecycle (creation, merge, cleanup)
- All run state persistence (`.git/repokernel/`)
- All non-run commands (they don't use worktrees, so no two-CWD split)

### Risk: planning writes in concurrent runs

When `storage: local` and two parallel sprints run simultaneously, both read from
`controlCwd`. Writes to sprint frontmatter (setting `started_at`, `base_sha`, etc.)
happen from separate processes targeting the same files on disk.

The existing `mutate.ts` functions do read-parse-write in one async operation.
Under parallel execution, two workers could read the same file, both modify it,
and one write clobbers the other.

**Mitigation for Sprint 4 implementation:** the parallel runner already sequences
frontmatter writes through the orchestrator (not the worker processes). Verify
this holds when `planningCwd` points to the shared control checkout rather than
each isolated worktree.

---

## Open questions before Sprint 4

1. Does `parseProject()` already accept absolute paths, or does it join `cwd + configPath`?
   → Check `packages/core/src/parser/parseProject.ts` line ~40.

2. Does `mutate.ts` need to know `planningCwd` separately from `executionCwd`?
   → Likely yes: `mutateSprintFrontmatter` should resolve sprint files relative to
   `planningCwd`, not the worktree CWD.

3. Does `refreshRegistry()` in `packages/cli/src/lifecycle/registry.ts` take a `cwd`
   that it passes to `loadProject()`? If so, it needs `planningCwd` too.
   → Trace callsites before implementing.

4. For `storage: local` with no worktrees (`--no-worktree`): `controlCwd === executionCwd`,
   so `planningCwd` = `cwd` and behavior is identical to `tracked`. Confirm this is a
   no-op change for the common case.
