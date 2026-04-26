# Worktrees

RepoKernel uses git worktrees to isolate agent execution from the main checkout. Each epic gets its own worktree directory and branch. Parallel sprints within an epic each get their own sprint-level worktree.

## Why worktrees

Without isolation, an agent working in the main checkout can corrupt in-progress state, create uncommitted debris, or interfere with other agents. Worktrees give each unit of work a clean, independent working directory backed by the same git object store.

Your main checkout remains clean throughout a run. You can continue using it normally.

## Directory layout

```
<worktrees.root>/
  <projectId>/
    <epic-id>/                    ← epic worktree (sequential or parallel baseline)
      <sprint-id>/                ← sprint worktrees (parallel mode only)
```

Default `worktrees.root` is `../.repokernel-worktrees` (a sibling of your repo). You can change it in config:

```yaml
worktrees:
  root: /tmp/rk-worktrees   # absolute path
```

Relative paths are resolved from the main checkout root.

## Epic worktree

Every run creates (or reuses) one worktree per epic:

- **Path**: `<worktrees.root>/<projectId>/<epic-id>/`
- **Branch**: `rk/<epic-id>`
- **Based on**: `worktrees.baseBranch` (default: `main`)

All sequential agent work happens inside this directory. The branch accumulates commits sprint by sprint.

## Sprint worktrees (parallel mode)

In parallel mode, each sprint in a wave gets its own worktree:

- **Path**: `<worktrees.root>/<projectId>/<epic-id>/<sprint-id>/`
- **Branch**: `rk/<epic-id>/<sprint-id>`
- **Based on**: the epic worktree branch at the time the wave starts

Sprint worktrees are created at wave start and removed after the wave's sprint branches are merged into the epic worktree.

## Lifecycle

### Automatic (default)

`worktrees.autoAcquire: true` (the default) means `rk run` creates and manages worktrees automatically. You do not need to do anything.

If a worktree already exists (e.g., from a previous run), it is reused. The branch is not reset — the run picks up from the current state.

`worktrees.autoRelease` is `false` by default, so worktrees persist after runs complete. This lets you inspect agent output or continue a run manually.

### Manual

For direct control without going through `rk run`:

```bash
rk lane acquire E-001    # create worktree + claim lane lock
# do manual work in the worktree
rk lane release E-001    # delete worktree + release lane lock
```

`rk lane release` refuses to delete a worktree with uncommitted changes unless `--force` is passed.

## Branch naming

| Entity | Branch |
|---|---|
| Epic | `rk/<epic-id>` |
| Sprint (parallel) | `rk/<epic-id>/<sprint-id>` |

The prefix is configurable:

```yaml
worktrees:
  branchPrefix: rk/
```

## Run invocation guard

`rk run` must be invoked from the main checkout, not from inside a worktree. If you run it from a managed worktree path, the command exits with code `2` and a descriptive error.

## Inspecting worktrees

List all lanes (and their worktree/lock state):

```bash
rk lane ls
```

Output:

```
LANE   HEALTH  CLAIMED_BY   DEPTH  ACTIVE    NEXT
main   ●       RUN-001      3      S-002     S-003
feat   ○       —            1      —         S-010
```

Inspect a specific epic's worktree:

```bash
rk inspect E-001
```

## Config reference

```yaml
worktrees:
  root: ../.repokernel-worktrees   # root directory for managed worktrees
  branchPrefix: rk/                # prefix for managed branches
  baseBranch: main                 # base branch for new epic worktrees
  autoAcquire: true                # rk run creates worktrees automatically
  autoRelease: false               # keep worktrees after run completes
```

See [Config reference](config-reference.md#worktrees) for full details.
