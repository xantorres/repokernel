# End-to-end demo: GitHub issue → shipped PR

This walkthrough shows the full RepoKernel cycle — from a GitHub issue to a merged pull request — using the Claude agent. Every command is real; timings are approximate.

**Prerequisites:** `npm i -g repokernel`, a Git repo with `rk init` already run, and `ANTHROPIC_API_KEY` set in your environment.

---

## 1. Start from a GitHub issue

```bash
gh issue view 42
# Title: Add /health endpoint that returns build version
# Labels: backend, good-first-issue
```

Pull the issue into a RepoKernel epic:

```bash
rk create epic "Add /health endpoint" --from-tracker gh:your-org/your-repo#42 --json
# {
#   "kind": "epic",
#   "id": "E-007",
#   "file": "epics/E-007.md",
#   "updated": [],
#   "next_actions": ["rk create sprint --epic E-007"]
# }
```

The epic file is created at `epics/E-007.md` with title, description, and tracker metadata pulled from the issue. This ingest step does not write back to GitHub; write-side tracker commands are explicit (`rk tracker comment`, `rk tracker link-pr`, `rk tracker transition`).

## 2. Plan the work

Scaffold the epic into sprints:

```bash
rk create sprint "Implement GET /health endpoint" --epic E-007 --enqueue --json
# {
#   "kind": "sprint",
#   "id": "S-042",
#   "file": "sprints/S-042.md",
#   "updated": ["queues/core.md"],
#   "next_actions": ["rk run E-007 --agent claude"]
# }
```

`--enqueue` adds the sprint to the lane queue in one step. The sprint starts at `status: queued`. Check the project is clean before running:

```bash
rk validate --fail-on P0,P1
# ✓  0 P0  0 P1 findings
```

## 3. Run the agent

```bash
rk run E-007 --agent claude
# [rk] starting E-007 · 1 sprint · lane: core
# [rk] S-042 → active  (worktree: .git/repokernel/worktrees/S-042)
# [rk] invoking claude on S-042…
```

The agent works in an isolated worktree. Your `main` branch is untouched. When the agent finishes, it commits its changes inside the worktree and reports back.

```
# [rk] S-042 agent finished · status: completed
# [rk] changed files: src/server/health.ts, src/server/index.ts, test/health.test.ts
# [rk] validation: ✓  checks: ✓
# [rk] S-042 → review
```

If the agent fails (validation error, path violation, zero changes), `rk run` reports the reason and leaves the sprint in `active` so you can retry with `rk run S-042 --agent claude` or inspect with `rk inspect S-042`.

## 4. Open a pull request and link it

The agent's worktree is already on its own branch (`rk/sprint/E-007/S-042`). Push it and open a PR:

```bash
gh pr create \
  --head rk/sprint/E-007/S-042 \
  --title "feat: GET /health endpoint (S-042)" \
  --body "$(rk pr body S-042)"
# https://github.com/your-org/your-repo/pull/99
```

Link the PR to the sprint:

```bash
rk pr link S-042 https://github.com/your-org/your-repo/pull/99
# S-042: linked PR https://github.com/your-org/your-repo/pull/99
```

Post the sprint body directly to GitHub:

```bash
rk pr body S-042 --write
# PR body updated ✓
```

The body is generated from sprint frontmatter — same sprint, same body, no spurious diffs on re-run.

## 5. Watch team status while CI runs

```bash
rk team status --watch
```

```
team status — 2026-05-04T14:20:00Z  (refreshing every 15s)

Runs
RUN     EPIC   STATUS    ACTIVE  REVIEW  STARTED              ETA
RUN-011 E-007  running   0       1       2026-05-04 14:10:00  —

Sprints
SPRINT  STATUS  LANE  TITLE
S-042   review  core  Implement GET /health endpoint

Registry
  health=OK  ready_to_merge=true  conflicts=0

Bottlenecks
  (none)
```

Hit `Ctrl-C` to exit the watch loop.

## 6. Record the review

Create the review stub (idempotent — safe to re-run):

```bash
rk review-create --sprint S-042
# created R-011 (sprint: S-042)
```

Run your review checks and feed findings in:

```bash
rk review-aggregate R-011 --findings '[]'
# verdict: GREEN
```

Accept the review and close the sprint:

```bash
rk review-verdict R-011 accepted
rk close S-042
# S-042 → shipped
# merged rk/sprint/E-007/S-042 → main
# registry updated
```

## 7. Notify the tracker

Post a comment back to the GitHub issue:

```bash
rk tracker comment S-042 "Shipped in #99 — health endpoint live on main."
# comment posted ✓
```

Sync the PR status one last time:

```bash
rk pr sync S-042
# pr synced: status=merged
```

## 8. Close the epic

With all sprints shipped:

```bash
rk epic close E-007
# E-007 → done
```

---

## What just happened

| Step | Command | What it does |
|---|---|---|
| Import issue | `rk create epic --from-tracker` | Pulls title + description from GitHub, no write-back |
| Plan | `rk create sprint --enqueue` | Allocates sprint ID under lock, enqueues atomically |
| Execute | `rk run E-007 --agent claude` | Isolated worktree, validation gate, path policy |
| PR wiring | `rk pr link` + `rk pr body --write` | Links sprint ↔ PR, generates body from sprint metadata |
| Visibility | `rk team status --watch` | Live snapshot across runs, registry, bottlenecks |
| Review | `rk review-create` + `rk review-aggregate` + `rk review-verdict` | Structured verdict, machine-readable findings |
| Merge | `rk close S-042` | Merges worktree branch, marks sprint shipped, updates registry |
| Notify | `rk tracker comment` | Optional write-back to source tracker |

The whole cycle — issue to shipped PR — runs without leaving your terminal, without a hosted service, and without touching `main` until the review gate passes.

---

## Next steps

- Run multiple sprints in parallel: add `parallel.maxConcurrentSprints: 3` to `repokernel.config.yaml` and use `rk run E-007 --agent claude` — the wave dispatcher handles isolation.
- See how the merge driver keeps registry.json conflict-free: [merge safety](./merge-safety.md).
- Full team dashboard options: [team status](./team-status.md).
- Tracker import + write-back surface: [trackers](./trackers.md).
