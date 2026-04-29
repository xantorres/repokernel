---
name: rk-run
description: Execute an epic or fastpath task (T-NNN) via rk run, or guide a manual single-sprint lifecycle. Streams logs. Pauses on awaiting_review and on completion — never auto-pivots, never auto-closes. Use for "ship it", "run this", "do the next sprint" intent.
---

# /repokernel:rk-run

Run an epic or fastpath task, or guide a manual single-sprint lifecycle. Stream logs. Pause for confirmation at every state transition.

## Procedure

1. **Resolve target** — the user provides one of:
   - An epic ID (`E-NNN`) → epic execution mode.
   - A sprint ID (`S-NNN`) → manual sprint mode (`rk start` → implementation → `rk review` → gated close). Do **not** call `rk run <S-NNN>`; sprint IDs are not valid `rk run` targets.
   - A task alias (`T-NNN`) → fastpath single-sprint mode.
   - No ID + free text after `-m` → ad-hoc fastpath via `rk run -m "<intent>"`.

   If ambiguous, run `rk ls epics --json` and `rk task list --json`, ask user to pick.

2. **Pre-check** — clean state required:
   ```bash
   rk validate --fail-on P0,P1 --json
   ```
   If non-zero: stop, route to `/repokernel:rk-doctor`.

3. **Confirm tier and cost** — for sprints/epics:
   ```bash
   rk route <ID> --profile implement
   ```
   Surface tier + estimated cost band. If user has not already approved (e.g., from a prior `/repokernel:rk-next`), pause and confirm.

4. **Execute** — branch by target:

   For epic/task/ad-hoc fastpath:
   ```bash
   rk run <ID>
   ```
   For epic with parallel `execution_strategy`: `rk run` reads the epic file and dispatches waves automatically. Do not pass `--parallel` / `--sequential` — those are CI assertions, not toggles.

   For a sprint ID:
   ```bash
   rk start <S-NNN>
   ```
   Then implement only the sprint scope, commit the implementation in the sprint worktree, and run:
   ```bash
   rk review <S-NNN>
   ```
   After review verdict approval, close with `rk close <S-NNN>`. Never substitute `rk run <S-NNN>`.

   If `routing_hint.fanout` is present from step 3 and you are in manual sprint mode, spawn one subagent per fanout entry **in a single message with multiple Task calls**. Map each entry's tier through the harness table. Do not iterate serially. For `rk run` epic/task mode, do not spawn extra fanout agents; the CLI owns wave execution.

5. **Stream logs** — follow the run via `rk run logs <RUN_ID>` until the run reaches a terminal or pause state.

6. **Branch on outcome**:
   - `awaiting_reviews` → **suggest** `/repokernel:rk-review`. Ask user: "Run review now?" Do not auto-pivot.
   - `completed` → **ask** the user: "Sprint S-NNN finished. Close it now?" Do not auto-close. On approval, run `rk close <ID>`. For epic-mode, after the last sprint closes, ask "Close epic E-NNN?" → `rk epic close <ID>`.
   - `merge_conflict` / `agent_failed` / `path_violation` → run `rk run inspect <RUN_ID>` and surface the diagnostic. Offer: `--resume` (retry from last good state), `rk discard <ID>` (release worktree, no merge), or manual investigation.
   - `aborted` → user-initiated. Stop.

7. **Post-close** — if `rk close` succeeded, suggest `/repokernel:rk-next` to surface what's unblocked.

## Refusals

- Never run `git add .` or `git add -A` inside an RK worktree. Stage explicit paths only.
- Never auto-close. Always ask before `rk close` / `rk epic close`.
- Never bypass `rk validate --fail-on P0,P1` failure with `--force` or by editing files.
- Never substitute manual `git merge` for `rk close`.
- Never invent run IDs. Always use the `RUN-NNN` returned by `rk run`.

## Notes

- For ad-hoc fastpath: `rk run -m "<description>"` creates and runs a T-NNN in one shot. Prefer this for <30-min hotfixes; prefer `rk start` → manual loop for anything that needs review.
- `rk run inspect` is cheap. Always run it on failure before suggesting recovery.
- Two sprints in the same worktree → forbidden. `rk run` manages worktrees per sprint; never override.
