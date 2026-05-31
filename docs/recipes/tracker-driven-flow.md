# Recipe: tracker-driven flow

End-to-end demo wiring all three tracker-friendly features into a single workflow:

1. **Feature A** — pull a JIRA / Linear / GitHub Issues ticket into a new RepoKernel epic with `rk create epic --from-tracker`.
2. **Feature B** — name managed worktree branches with custom epic/sprint branch patterns.
3. **Feature D** — gate the resulting PR with the `rk-validate` GitHub Action.

The result: one ticket → one epic → one cleanly-named branch → one CI-validated PR, with no per-team lifecycle ceremony added on top of the tracker the team already uses.

## Scenario

You're a solo dev on a JIRA-driven product team. The team uses tickets `PROJ-NNN`. You want to use RepoKernel locally to keep your work disciplined without making your teammates adopt anything.

## 1. Configure the project

`repokernel.config.yaml`:

```yaml
schemaVersion: 1
projectId: web
projectName: Web App
paths:
  epics: .repokernel/plan/epics
  sprints: .repokernel/plan/sprints
  reviews: .repokernel/plan/reviews
  queues: .repokernel/plan/queues
  lanes: .repokernel/plan/lanes
  generated: .repokernel
  registry: .repokernel/registry.json
worktrees:
  branchPrefix: rk/
  epicBranchPattern: "{branchPrefix}epic/{epicId}"
  sprintBranchPattern: "{branchPrefix}sprint/{epicId}/{sprintId}"
```

These patterns produce branches like `rk/epic/E-001` and `rk/sprint/E-001/S-001`. Adjust to your team's convention, but keep epic and sprint refs in distinct namespaces. Git cannot store both `feature/E-001` and `feature/E-001/S-001`.

```bash
rk init --commit
```

## 2. Configure tracker auth (one-time)

```bash
# JIRA Cloud — token from id.atlassian.com/manage-profile/security/api-tokens
export JIRA_BASE_URL=https://acme.atlassian.net
export JIRA_EMAIL=you@acme.com
export JIRA_API_TOKEN=...

# Or Linear:
# export LINEAR_API_KEY=lin_api_...

# Or GitHub: just `gh auth login` once, no env needed.
```

Put these in a shell rc file or a `.envrc` (with `direnv`). Don't commit them.

## 3. Pick a ticket, create an epic from it

```bash
rk create epic "fallback if tracker unreachable" --from-tracker jira:PROJ-2293
# Allocated E-001 — Refactor checkout flow
# epics/E-001.md
```

The epic title is now the JIRA summary; the body is the JIRA description. Frontmatter includes `extras.external_id: PROJ-2293`, `extras.tracker_url: https://acme.atlassian.net/browse/PROJ-2293`, plus labels and assignee. RepoKernel can later answer "what ticket is this epic for?" without re-fetching.

If you're offline or your JIRA token has expired, `rk` warns to stderr and exits before writing an epic. To intentionally create a plain epic from the fallback title, rerun with `--allow-tracker-fallback`.

## 4. Plan and run sprints

```bash
rk create sprint "Audit current flow" --epic E-001 --allowed-path "src/checkout/**"
rk create sprint "Implement new flow" --epic E-001 --after S-001 --allowed-path "src/checkout/**"
rk run E-001
```

Each sprint runs in its own worktree, on a branch named per `sprintBranchPattern` (e.g. `rk/sprint/E-001/S-001` and `rk/sprint/E-001/S-002`). Your `main` is untouched.

## 5. Review and ship

```bash
rk review-aggregate <REVIEW_ID> --findings findings.json
rk review-evidence S-001 --label focused-tests --command "pnpm test -- checkout"
rk review-verdict R-001 accepted
rk ship S-001
# (repeat for S-002)
rk epic ship E-001
```

When you're ready to open a PR against your team's `main`:

```bash
git push -u origin rk/sprint/E-001/S-002
gh pr create --title "PROJ-2293: Refactor checkout flow" --body "..."
```

## 6. Gate the PR with `rk validate`

Add this to the team's repo (one-time):

`.github/workflows/repokernel.yml`:

```yaml
name: RepoKernel
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: xantorres/repokernel/.github/actions/rk-validate@v1
        with:
          fail-on: P0,P1
          version: 1.30.0
```

Behavior on PRs:

- If your branch contains `repokernel.config.yaml` (because you committed it), the action runs `rk validate --fail-on P0,P1`. Any blocker breach fails the PR with inline annotations and a sticky summary comment.
- If a teammate opens a PR from a branch that does *not* have `repokernel.config.yaml`, the action neutral-skips with a one-line summary message — they're never blocked.

This is the asymmetry that makes RepoKernel team-friendly without being team-coercive: only adopters pay the ceremony cost; non-adopters see a benign no-op.

## What this recipe deliberately does not do

- **Limited write-back.** GitHub Issues supports comments, PR links, and transitions through `rk tracker`. Linear and Jira currently fail unsupported write operations cleanly until their adapters are wired.
- **No team-wide adoption.** Other devs don't need to install `rk` or run any of these commands. Their flow is unchanged.
- **Merge safety depends on the merge environment.** `.repokernel/registry.json` merges deterministically when the RepoKernel merge driver is installed in the clone performing the merge. Fresh clones and hosted web merges need `rk doctor` / CI validation rather than blind trust.
- **No `{ticket}` token in the branch pattern.** Branch patterns currently support `{branchPrefix}`, `{epicId}`, `{sprintId}` only. `{ticket}` (resolved from `extras.external_id`) is on the product backlog.

See also:

- [Tracker integration guide](../usage/trackers.md) — full reference, auth, failure modes.
- [CI usage guide](../usage/ci.md) — `rk-validate` action inputs, outputs, behavior matrix.
- [Branch pattern config](../internals/config-reference.md#branchpattern) — token list, validation rules, examples.
