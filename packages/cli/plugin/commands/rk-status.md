---
name: rk-status
description: Show a read-only RepoKernel dashboard — active epics, next runnable sprint, P0/P1 validation count, lane status. Cold-start summary for "where are we?" intent. Calls rk validate / ls epics / next / lane ls with --json. No mutations.
---

# /repokernel:rk-status

Read-only RepoKernel dashboard. Use when the user asks "where are we", "status", or wants the cold-start picture.

## Procedure

1. **Validate** — run:
   ```bash
   rk validate --fail-on P0,P1 --json
   ```
   Capture exit code and finding count. **Do not run `rk validate` bare** — that dumps P2 noise.

2. **List epics** — run:
   ```bash
   rk ls epics --json
   ```
   Parse to count: total, in-progress, blocked.

3. **Next** — run:
   ```bash
   rk next --json
   ```
   Capture: status (`runnable` | `blocked` | `none`), and if runnable, the sprint ID.

4. **Lanes** — run:
   ```bash
   rk lane ls --json
   ```
   Count free vs locked.

5. **Render dashboard** — output exactly this shape (5-6 lines max), filling in real values:

   ```
   RK | <ACTIVE_EPIC_ID> active · <NEXT_SPRINT_ID or "none"> next · P0/P1 <clean | N findings> · lanes <free>/<total> free
   <if blocked or P0/P1 dirty: one-line explanation>
   Tip: say "next" to start work, "doctor" if there are blockers
   ```

6. **Stop**. Do not invoke any other verb. Do not run `rk start`, `rk run`, or `rk fix`.

## Refusals

- If asked to also "fix it" inline: refuse and route to `/repokernel:rk-doctor`.
- If asked to "just close the sprint": refuse and route to `/repokernel:rk-run` (close requires confirmation flow).

## Notes

- `rk validate --fail-on P0,P1` is the correct default threshold — it suppresses P2 base_sha noise.
- Cache the dashboard output for 60 seconds within the same session if the user asks again. Bust the cache when any mutation runs (`rk run`, `rk close`, `rk review-verdict`, `rk fix --apply --yes`).
- This command is read-only. Safe to run at any time, including at session start.
