# Merge safety

Two agents on two branches both finish work, both commit `.repokernel/registry.json`, and one of them tries to merge. Without help, git stops with a conflict marker in JSON — useless for review, painful to resolve.

RepoKernel ships a custom git merge driver that resolves these conflicts deterministically when the clone performing the merge has the driver installed: union by id, more-progressed status wins, real divergence surfaced as a structured conflict. Same input order or reversed, the merged registry is byte-identical.

## How it's installed

`rk init` writes the wiring automatically:

```
.gitattributes
  .repokernel/registry.json merge=repokernel-registry

git config (per-repo)
  merge.repokernel-registry.name      RepoKernel registry merge driver
  merge.repokernel-registry.driver    rk registry-merge-driver --current %A --other %B --base %O
  merge.repokernel-registry.recursive binary
```

When a merge touches `registry.json`, git invokes `rk registry-merge-driver` with the standard `%A %B %O` substitutions. Exit 0 means resolved (the driver wrote the merged content to `%A`). Anything else leaves git's standard conflict markers in place for human resolution.

The `.gitattributes` entry can be committed with the repo; the `git config` keys are local to the clone that performs the merge. A fresh clone must run `rk init` again, or at least `rk doctor`, before relying on registry merge safety.

Hosted merge environments are different. GitHub web merges and other hosted PR merge buttons may not execute your local custom merge driver, even when `.gitattributes` is present. Prefer local merges with `rk doctor` clean, or require CI validation after hosted merges so stale registry state is caught quickly.

The install is idempotent. Re-running `rk init` (or calling `installRegistryMergeDriver` directly) does not duplicate the `.gitattributes` line and does not error when the git config keys already exist.

## What the driver does

The git driver calls `mergeRegistriesThreeWay(base, current, other)` when `%O` is available. That preserves real deletions: delete-vs-unchanged removes the entity, while delete-vs-modify becomes a structured conflict. Plain `mergeRegistries(a, b)` remains the deterministic two-way primitive for callers without a base snapshot.

`mergeRegistries(a, b)` returns `{ registry, conflicts }`:

- **Idempotent.** `mergeRegistries(r, r).registry === r` (modulo regenerated timestamps).
- **Commutative.** `mergeRegistries(a, b).registry` is structurally equal to `mergeRegistries(b, a).registry`. Every nullable scalar uses a symmetric tie-breaker (lexicographic min on conflict).
- **Total.** Never throws on schema-valid inputs.

### Resolution rules

| Field type | Strategy |
|---|---|
| Sprint / epic / review id arrays (e.g. `depends_on`, `epic.sprints`) | Union, sort, dedupe. |
| Sprint status | Pick the more-progressed side via `pickFurthestStatus`: `shipped > review > active > queued > reopened > pending > planned`. `cancelled` loses to any non-cancelled side, and shipped beats cancelled (committed work outranks an in-flight cancel). |
| Sprint nullable timestamps (`started_at`, `closed_at`) | Pick the later ISO timestamp. |
| Sprint nullable scalars (`gate`, `review_id`, `base_sha`, `end_sha`) | If exactly one is null, take the non-null. If both non-null and equal, use that. If both non-null and divergent: surface a `sprint_diverged` conflict and pick lexicographic min. |
| Sprint immutable (`title`, `epic_id`, `lane`, `file`) | If equal, use that. If different: surface a `sprint_immutable` conflict and pick lexicographic min. |
| Epic status | Picks `done > cancelled > active > on_hold > planned` symmetrically when divergent; `epic_diverged` conflict recorded. |
| Review verdict | `rejected > changes_requested > accepted > pending` (more conservative wins). |
| Lane claims | Two non-null divergent claims → `lane_claim` conflict; lexicographic-min winner. |
| Queue slots | Per-lane union by `sprint_id`; on collision for the same sprint pick the lower `order`. Cross-sprint slot id reuse (e.g. local `Q-001/S-1` + remote `Q-001/S-2`) surfaces a `queue_id_collision` conflict and the loser is renamed deterministically so post-merge slot ids stay unique. |
| `findings` | Union, dedupe by `(code, severity, entityId, file, message)`. |
| `health` | Recomputed from the merged findings against the default P1 threshold. The `blocked` bit only carries forward when the source side still has findings that justify it — a stale `blocked: true` paired with empty findings does not poison future merges. Custom-threshold projects that need to stay blocked despite empty merged findings must regenerate via `rk registry --write` after the merge. |

### Post-merge integrity

After the merge, `checkRegistryIntegrity` runs five orphan-class checks:

| Issue kind | Meaning |
|---|---|
| `sprint_missing_epic` | Sprint references an epic that no longer exists |
| `sprint_missing_dep` | Sprint depends on a non-existent sprint |
| `sprint_missing_review` | Sprint's `review_id` points at a missing review |
| `review_missing_sprint` | Review's `sprint_id` points at a missing sprint |
| `queue_missing_sprint` | Queue slot points at a missing sprint |
| `epic_missing_sprint` | Epic's `sprints[]` lists a sprint that doesn't exist (post-merge case where one branch added the epic entry, the other forgot to add the sprint) |
| `epic_sprints_mismatch` | A sprint claims membership in an epic, but the epic's `sprints[]` doesn't list it |

If any check fires, the driver exits non-zero and leaves the conflict markers in place for human triage.

## Conflicts the driver does NOT resolve

The driver chooses safety over silence. Anything below is surfaced as a `MergeConflict` and treated as unresolvable:

- Two non-null divergent values for `gate`, `review_id`, `base_sha`, or `end_sha`. Two agents legitimately changed the same gate condition or attached different review IDs to the same sprint — the human should decide which wins.
- Diverged `title` / `epic_id` / `lane` / `file` for the same id. Logically the entity has been renamed on one side; pick a winner explicitly.
- Divergent epic status that crosses terminal boundaries (e.g. `done` on one side, `cancelled` on the other).
- Two non-null lane claims pointing at different runs (someone forgot to release a lane).
- Delete-vs-modify on the same sprint, epic, review, lane, or queue slot when the merge base shows the entity existed.

The driver's output in those cases is intentionally imperfect: it produces a deterministic byte-identical result regardless of merge direction (so `git rerere` records once), AND it lists the conflicts on stderr so the human can decide whether to keep the merged version or override.

## Manual invocation

The driver is also a public CLI command:

```bash
rk registry-merge-driver --current path/to/A.json --other path/to/B.json --base path/to/O.json
rk registry-merge-driver --current A.json --other B.json --json
```

`--json` emits the structured outcome:

```json
{
  "ok": false,
  "conflicts": [
    {
      "kind": "sprint_immutable",
      "id": "S-1",
      "field": "title",
      "local": "Original",
      "remote": "Renamed"
    }
  ],
  "integrityIssues": [],
  "errors": []
}
```

## Sprint claims (related)

Merge safety on `registry.json` is one half of the multi-agent story. The other half is sprint claims — the dispatch primitive that prevents two parallel runs from picking up the same sprint.

Claims live OUT-OF-TREE under `<opRoot>/claims/<sprintId>.json`. The operational root is inside `.git/repokernel/`, which is implicitly gitignored. This is intentional:

- Claims are per-machine, never crossing branches. Two workstations on different branches can each carry an active claim — that's the same coordination boundary git's branching model already accepts.
- Within a single machine, `claimSprint` uses `withLockRetrying` to serialise concurrent attempts. Sixteen `Promise.all`-style parallel claims will resolve to exactly one `ok: true`.
- Storing claims in the sprint frontmatter would defeat merge safety: every claim attempt would race the very `.md` file the merge driver is trying to keep clean.

```ts
import { claimSprint, releaseSprint } from 'repokernel/lifecycle/sprintClaim.js';

const result = await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-042' });
if (!result.ok) {
  // result.reason === 'already_claimed'; result.heldBy is the winning run
}
// ... do work ...
await releaseSprint({ opRoot, sprintId: 'S-042', runId: 'RUN-001' });
```

`releaseSprint` is no-op-on-mismatched-runId — a different run holding the claim cannot be silently stolen.

## See also

- [Team status](team-status.md)
- [Tracker bridge](trackers.md)
- [PR bridge](pr-bridge.md)
- [Concepts](../internals/concepts.md) — the canonical model
- ADR: [planning storage](../internals/adr-planning-storage.md)
