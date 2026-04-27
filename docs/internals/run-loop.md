# Run loop

`rk run` is the primary command. It orchestrates one or more sprints end to end: validating state, preparing the agent's context, invoking the agent, handling review, and advancing to the next sprint.

## Invocation

```bash
rk run <epic-id> [options]
```

Example:

```bash
rk run E-001 --agent fake --limit 3
```

## What happens on each iteration

For each sprint the loop processes:

### 1. Validate

`rk run` calls the full validator suite before starting each sprint. If any P0 or P1 findings exist, the run halts immediately with exit code `1`. Fix the findings and re-run.

### 2. Resolve next sprint

The resolver walks the queue for the target epic and lane. It returns the first sprint that:

- Has status `queued` (or `active`, which takes priority)
- Has all `depends_on` sprints in `shipped` status
- Passes path-policy checks (parallel only)

If nothing is runnable, the loop exits with halt reason `no_runnable_sprints`.

### 3. Prepare worktree

If `worktrees.autoAcquire` is `true` (the default), the loop creates or reuses a managed git worktree for the epic:

```
<worktrees.root>/<repo-directory-name>/<epic-id>/
```

The worktree is on branch `rk/epic/<epic-id>`. All agent work happens inside this directory — the main checkout is never modified during a run.

### 4. Transition sprint to active

The loop runs `rk start <sprint-id>`, which:

- Transitions the sprint to `active`
- Records `started_at` and `base_sha` (the current HEAD in the worktree)

This is the reference point for the diff. `base_sha..HEAD` is the only correct way to inspect what the agent changed.

### 5. Build the context packet

The loop generates a structured context packet for the agent. The packet contains:

- Sprint frontmatter (id, title, goals, allowed paths)
- Epic context
- Current git state
- Project registry path
- Run metadata

The packet is written to a temp file and its path is passed to the agent.

### 6. Invoke the agent

The configured agent receives the packet path. The agent does its work inside the worktree and writes a sentinel JSON result between the required markers:

```
REPOKERNEL_RESULT_START
{"status":"completed","summary":"...","changed_files":["src/auth/jwt.ts"],"needs_human":false}
REPOKERNEL_RESULT_END
```

See [Agent adapters](agent-adapters.md) for how each agent is invoked and what it must return.

### 7. Validate result

After the agent returns, the loop checks:

- The sentinel result is present and parseable
- `status` is `completed` (not `failed` or `blocked`)
- Changed files are within `allowed_paths` if declared
- No changed files match `denied_paths`

A failed validation here halts the run with halt reason `agent_failed:<sprint-id>`.

### 8. Transition to review

The loop runs `rk review <sprint-id>`, which:

- Creates a review stub (`R-NNN.md`) with `verdict: pending`
- Transitions the sprint to `review`

In assisted mode, the run pauses here. In autonomous mode (requires `automation.allowAutonomousClose: true`), the loop continues without pausing.

### 9. Pause for human review (assisted mode)

The run writes a pause record and prints:

```
Sprint S-002 complete. Run paused.
Resume with: rk run --resume RUN-001
```

You review the diff, set the verdict:

```bash
rk review-verdict R-002 accepted --summary "LGTM"
```

Then resume:

```bash
rk run --resume RUN-001
```

### 10. Close and advance

On resume, the loop runs `rk close <sprint-id>`, which:

- Verifies the review is accepted
- Records `end_sha` and `closed_at`
- Transitions the sprint to `shipped`

The loop then returns to step 1 for the next sprint.

## Halt reasons

The loop pauses or stops for the following reasons. See [Resume and recovery](resume-recovery.md) for the full table.

| Halt reason | When |
|---|---|
| `awaiting_review` | Sprint is in review, human verdict required (assisted mode) |
| `limit_reached` | Hit the `--limit` cap |
| `agent_failed:<sprint-id>` | Agent returned non-completed status |
| `merge_conflict:<sprint-id>` | Parallel wave merge failed |
| `epic_completed` | All sprints shipped |
| `no_runnable_sprints` | Nothing queued or all blocked by dependencies |

## Run state persistence

Run state is stored in `.git/repokernel/runs/RUN-NNN.json`. This file is local only — not committed. If you delete it, the run cannot be resumed. To inspect or recover run state:

```bash
rk run inspect RUN-001
rk run logs RUN-001
rk runs --status paused
```

## Flags

| Flag | Description |
|---|---|
| `--agent <name>` | Agent to use: `fake`, `manual`, `claude`, `codex`, `ollama`, or a config-defined name |
| `--mode assisted\|autonomous` | Assisted pauses for human review; autonomous requires `allowAutonomousClose: true` |
| `--limit N` | Stop after N sprints |
| `--resume RUN-NNN` | Resume a paused run |
| `--dry-run` | Preview worktree, branch, and wave plan; exit without making changes |
| `--parallel` | Assert parallel execution (epic must declare `execution_strategy: parallel`) |
| `--concurrency N` | Max sprints per wave (parallel mode) |
| `--lane <name>` | Override the default lane |
| `--allow-overlap` | Allow overlapping `allowed_paths` in a wave (requires `parallel.allowOverlapFlag: true` in config) |
| `--worktree` | Force worktree isolation even for sequential runs |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean completion or normal assisted pause |
| `1` | Blocked state: findings, agent failed, no runnable sprints |
| `2` | Runtime error: config invalid, worktree creation failed, unexpected exception |
