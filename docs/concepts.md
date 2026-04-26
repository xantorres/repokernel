# Concepts

RepoKernel organizes work into a small set of entities that map directly onto files in your repository. Understanding these entities is enough to understand the whole system.

## Entity overview

All entities are Markdown files with YAML frontmatter. The frontmatter is the contract — RepoKernel reads and writes it. The Markdown body is free-form notes for humans and is ignored by the system.

See [specs/entities.md](specs/entities.md) for exact field schemas and validation rules.

## Epic

An **epic** is a named collection of sprints representing a feature, initiative, or area of work.

```yaml
# epics/E-001-auth.md
---
id: E-001
title: Authentication system
status: active
sprints:
  - S-001
  - S-002
  - S-003
---
```

Epic statuses: `planned`, `active`, `on_hold`, `done`, `cancelled`.

Epics do not have their own lifecycle commands — their status is updated manually. What the run loop operates on is the sprint queue within an epic.

An epic can optionally declare `execution_strategy: parallel` to enable wave-based parallel execution. See [Parallel waves](parallel-waves.md).

## Sprint

A **sprint** is the atomic unit of work. Each sprint has a single lifecycle and lives in one Markdown file.

```yaml
# sprints/S-001-setup-jwt.md
---
id: S-001
title: Set up JWT signing
epic_id: E-001
status: queued
lane: main
depends_on: []
review_required: true
allowed_paths:
  - src/auth/**
  - tests/auth/**
---
```

### Sprint lifecycle

```
planned → queued → active → review → shipped
                                   ↘ reopened → active
                         → cancelled
```

Each transition captures metadata:

- `queued → active`: records `base_sha` (the current HEAD) and `started_at`
- `active → review`: validates files against `allowed_paths` and `denied_paths`
- `review → shipped`: records `end_sha` and `closed_at`; requires an accepted review

The `base_sha` is the diff authority. Review diffs are always `base_sha..HEAD`, never date-based. See [specs/state-machine.md](specs/state-machine.md) for the full transition table and field invariants.

### Key sprint fields

| Field | Purpose |
|---|---|
| `lane` | Which execution track this sprint belongs to |
| `depends_on` | Sprint IDs that must be `shipped` before this sprint can run |
| `allowed_paths` | Glob patterns. Required for parallel sprints; validated at review. |
| `denied_paths` | Any matching file blocks the sprint from closing. |
| `review_required` | Set to `false` to skip the review check for shipped status. |

## Review

A **review** records the verdict for a sprint after agent execution. It is the paper trail that connects `base_sha` to `end_sha`.

```yaml
# reviews/R-001.md
---
id: R-001
sprint_id: S-001
verdict: pending
reviewer: agent
base_sha: abc1234
created_at: "2026-04-25T14:00:00Z"
findings: []
---
```

Verdict options: `pending`, `accepted`, `changes_requested`, `rejected`.

A sprint cannot close (`shipped`) if its review verdict is not `accepted`, unless `review_required: false` is set on the sprint.

You set the verdict with:

```bash
rk review-verdict R-001 accepted
```

## Queue

A **queue** defines the execution order for sprints within a lane. One queue file per lane.

```yaml
# queues/main.md
---
lane: main
slots:
  - id: Q-001
    sprint_id: S-001
    order: 0
  - id: Q-002
    sprint_id: S-002
    order: 1
---
```

The resolver walks queue slots in `order` sequence and returns the first sprint whose dependencies are all `shipped`. Sprints not in the queue cannot be run by the loop.

## Lane

A **lane** is a named execution track. Lanes let you run independent workstreams in the same repository without collision. Common examples: `main`, `release`, `hotfix`.

Each sprint declares its lane. Each queue file is scoped to a lane. The run loop and `rk next` default to the lane configured in `policies.defaultLane`.

Lane files are optional — if no lane file exists, lanes are inferred from sprint and queue frontmatter.

## Registry

The **registry** is a generated snapshot of all project state, written to `.repokernel/registry.json`. It is the source of truth for machine consumers (agents, CI) that need fast access to entity state without parsing every Markdown file.

```bash
rk registry --check    # verify registry matches current state
rk registry --write    # regenerate the registry file
```

`REGISTRY_DRIFT` (P2) is raised if the registry is out of sync. In CI, run `rk registry --check` after any entity change.

## Run record

When `rk run` executes, it creates a run record at `.git/repokernel/runs/RUN-NNN.json`. The record tracks the current run state, halt reason, sprints completed, and agent used.

```bash
rk runs                       # list all runs
rk run inspect RUN-001        # show run state and next steps
rk run logs RUN-001           # show logs for a run
rk run logs RUN-001 S-002     # logs for a specific sprint in a run
```

Run records live in `.git/` and are local only — they are not committed to the repository.

## Findings and severity

Validators produce **findings** with severity levels:

| Severity | Meaning |
|---|---|
| P0 | Critical: corrupt state, duplicate IDs, config invalid |
| P1 | Blocking: missing required fields, invalid dependencies, review mismatches |
| P2 | Warning: registry drift, missing optional fields |
| P3 | Informational: unknown frontmatter fields, filename mismatches |

By default (`policies.severityFailThreshold: P1`), P0 and P1 findings block the run loop and cause `rk validate` to exit with code `1`.

Use `rk explain <CODE>` to understand any specific finding code.
