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
A sprint agent running in `/tmp/.repokernel-worktrees/myrepo/E-001` cannot read planning files
that exist only on the main checkout at `/Users/you/projects/myrepo/.repokernel/`.

This ADR defines the architecture for `planning.storage: local` before implementation.

---

## Decision

### Config surface

```yaml
# repokernel.config.yaml
planning:
  storage: tracked   # default — planning files are git-tracked, present in worktrees
                     # local   — planning files may be gitignored, read/written from
                     #           planningCwd only; never touched inside worktrees
```

### Two-CWD model

Every operation has two roots. Document them explicitly everywhere:

```
executionCwd  = git/code execution root (may be a worktree)
planningCwd   = planning/config root (always the main checkout)
```

`loadProject()` gains an optional second root:

```typescript
// packages/core/src/api.ts
export async function loadProject(opts: {
  cwd: string;           // executionCwd — git operations run here
  planningCwd?: string;  // defaults to cwd; planning files read from here
}): Promise<LoadProjectOutcome>
```

Path resolution rules:
- Config file loaded from `planningCwd`
- Planning paths (epics, sprints, reviews, queues, lanes, registry) resolved relative to `planningCwd`
- Worktree paths resolved relative to repo root (controlCwd)
- Git operations (`git commit`, `git add`, SHA capture, diff) run against `executionCwd`
- Operational state (`.git/repokernel/runs/`) lives under git-common-dir — always the main repo

When `planningCwd` is omitted or equals `cwd`: current behavior, unchanged.

### Planning write model

This is the central rule that makes the feature coherent:

**Tracked planning travels through Git worktrees.  
Local planning stays in `planningCwd` and is mutated only by the orchestrator.**

When `planning.storage: tracked`:
- Planning files are present in each worktree (git tracks them)
- Sprint worktrees may update their own sprint/review files directly
- Merge brings planning metadata back to the epic worktree
- Orchestrator then finalizes remaining mutations after merge

When `planning.storage: local`:
- Planning files are **read and written only from `planningCwd`**
- Sprint worktrees must **never** write planning files
- Parallel workers compute results and return them to the orchestrator
- The orchestrator serializes all sprint/review/queue mutations in `planningCwd` under a lock
- Merges affect code only; planning metadata is updated separately after merge

### `PlanningStore` abstraction

Do not scatter `planningCwd` through individual mutate functions.
Introduce a single abstraction that owns all planning I/O:

```typescript
// packages/cli/src/lifecycle/planningStore.ts
interface PlanningStore {
  readonly planningCwd: string;
  readonly executionCwd: string;
  readonly storage: 'tracked' | 'local';

  loadProject(): Promise<LoadProjectOutcome>;

  mutateSprint(id: SprintId, patch: Record<string, unknown>): Promise<void>;
  mutateReview(id: ReviewId, patch: Record<string, unknown>): Promise<void>;
  removeSprintFromQueue(id: SprintId, lane: string): Promise<void>;
  writeRegistry(): Promise<void>;
}
```

`rk run` and all lifecycle commands use `PlanningStore`, not raw paths or bare
`mutate*` function calls. This is the single source of truth for planning I/O routing.

### Concurrency and locking

For `storage: local`, every planning mutation must be serialized under a lock:

```
<planningCwd>/.repokernel/planning-write.lock
```

A single file lock is sufficient for v1. Granular per-sprint locks add complexity with
little benefit when the orchestrator already serializes writes.

In parallel mode under `storage: local`:
- Workers do **not** write planning files
- Each worker returns a result struct to the orchestrator
- The orchestrator applies all mutations under the lock, sequentially, after the wave completes

This is a hard constraint. Parallel local-planning runs are not supported until
`PlanningStore` with orchestrator-serialized writes exists.

For `storage: tracked`: existing behavior unchanged. Each worktree mutates its own
planning files; merge handles reconciliation.

### `refreshRegistry()` routing

```typescript
// packages/cli/src/lifecycle/registry.ts
refreshRegistry({
  executionCwd: string;
  planningCwd: string;
})
```

Registry reads planning state from `planningCwd`, writes registry to `planningCwd`,
reads git state (for SHA checks) from `executionCwd`.
For `storage: local`, registry is written to `planningCwd` and gitignored there.

### Call-site contract for `rk run`

```typescript
// packages/cli/src/commands/run.ts
const planningCwd = config.planning?.storage === 'local' ? controlCwd : executionCwd;
const store = createPlanningStore({ executionCwd, planningCwd, storage });
const outcome = await store.loadProject();
```

For all commands without worktrees (`validate`, `status`, `next`, `board`, `registry`,
`create`, `init`): `planningCwd` always equals `cwd`. No change in behavior.

### SHA fields are unchanged

`base_sha` and `end_sha` track git commits in the **code** repository, not planning
files. They are orthogonal to `planning.storage`.

Both remain required for active/shipped sprints regardless of `storage` value.

### Validation rules that change under `storage: local`

| Rule | `tracked` | `local` | Reason |
|---|---|---|---|
| `REGISTRY_DRIFT` | P2 | P3 | Local planning changes outside git commits; drift is expected |
| `ACTIVE_SPRINT_MISSING_BASE_SHA` | P1 | P1 | Tracks code SHA — unchanged |
| `REVIEW_BASE_SHA_MISMATCH` | P1 | P1 | Tracks code SHA — unchanged |
| worktree clean-tree check for planning files | enforced | skipped | Files aren't in worktree |

Note: `REGISTRY_DRIFT` is a cache-freshness issue, not a git-tracking issue. Under
`storage: local` the registry is expected to be stale between operations since it's
never committed. Downgrade to P3 with a clear message explaining this.

### `rk init --local` behavior

```
rk init --local
→ writes repokernel.config.yaml with planning.storage: local
→ appends to .gitignore (precise paths, not blanket .repokernel/):
    # RepoKernel planning state (local-only)
    .repokernel/registry.json
    .repokernel/generated/
    .repokernel/plan/        ← only if default paths are under .repokernel/
```

If paths are configured outside `.repokernel/`, add those exact paths instead.

Never ignore:
- `repokernel.config.yaml` — shared team config
- `.repokernel/authority.md` — orientation, not planning state

`rk doctor` should warn if an existing `.gitignore` blanket-ignores `.repokernel/`
while `authority.md` or `repokernel.config.yaml` are unintentionally caught.

### Registry and run state

Both stay local regardless of `storage` setting:
- `.repokernel/registry.json` — always local (gitignored or not, regenerable)
- `.git/repokernel/runs/` — lives in `.git/` (never committed, already local by nature)

No change needed.

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
the canonical source (`planningCwd`) at all times.

### C — Single-cwd, read planning from always-absolute path

Store planning paths as absolute in config (`/Users/you/...`).

**Rejected:** Breaks portability. Config can't be shared across machines or team members.

---

## Implementation order

Do not start by changing validators. Fix the read/write architecture first.

1. Add `planning.storage` to config schema (`packages/core/src/config/schema.ts`)
2. Add `loadProject({ cwd, planningCwd? })` overload
3. Implement `PlanningStore` abstraction (`packages/cli/src/lifecycle/planningStore.ts`)
4. Route `refreshRegistry()` through `PlanningStore`
5. Route all lifecycle mutations through `PlanningStore`
6. Add `rk init --local` (config write + `.gitignore` generation)
7. Support `validate` / `status` / `next` with local planning (read-only path, trivial)
8. Support sequential `rk run` with local planning
9. Add `planning-write.lock` for mutation serialization
10. Support parallel `rk run` with local planning — only after step 9 is proven

---

## Consequences

### What changes

- `loadProject()` accepts optional `planningCwd` — additive, backward-compatible
- `parseProject()` receives resolved absolute paths already — no change needed there
- `rk run` creates a `PlanningStore` and passes it through the lifecycle
- `refreshRegistry()` takes `{ executionCwd, planningCwd }`
- `rk init --local` writes `.gitignore` entries
- `REGISTRY_DRIFT` reads `storage` from config to choose severity + message

### What stays the same

- All SHA-based validation rules
- All entity schema validation
- All worktree lifecycle (creation, merge, cleanup)
- All run state persistence (`.git/repokernel/`)
- All non-run commands — they don't use worktrees, no two-CWD split needed

---

## Open questions before implementation

1. Does `parseProject()` already accept absolute paths, or does it join `cwd + configPath`?
   → Check `packages/core/src/parser/parseProject.ts` — if it joins, the `planningCwd`
   split needs to propagate down into the parser as well.

2. Does `rk run --no-worktree` with `storage: local` need any special handling?
   → No: `controlCwd === executionCwd`, so `planningCwd = cwd` — behavior is identical
   to `tracked`. Confirm this is a no-op path.

3. Should `PlanningStore.mutateSprint()` take a full patch object or typed fields?
   → Typed fields preferred (e.g., `{ status, started_at, base_sha }`) so the store
   can validate before write. Avoids stringly-typed footguns.

4. Is a single `planning-write.lock` sufficient for parallel runs, or do we need
   per-lane locks to allow concurrent review writes for different lanes?
   → Start with one lock. Revisit if it becomes a throughput bottleneck.
