---
name: rk-review
description: Run a parallel review panel for a sprint. Spawns N rk-reviewer subagents (one per role), merges findings, surfaces verdict recommendation. User picks accepted / changes_requested / rejected. Records via rk review-verdict. Use for "review", "verdict", "panel" intent.
---

# /rk-review

Run a multi-role review panel for a sprint in `awaiting_reviews` state. Use parallel subagents.

## Procedure

1. **Resolve target** — if user provided a sprint ID (`S-NNN`), use it. Otherwise run:
   ```bash
   rk ls reviews --status pending --json
   ```
   If multiple pending: list and ask user to pick. If exactly one: confirm and proceed.

2. **Read panel config** — run:
   ```bash
   rk review-panel run --sprint <SPRINT_ID> --dry-run --json
   ```
   This returns the panelist roles configured for the sprint (e.g., `security`, `performance`, `style`, `correctness`). If no panel is configured, fall back to the default 4 roles.

3. **Compile context once** — run:
   ```bash
   rk context <SPRINT_ID> --profile review --json
   ```
   This packet is shared across all panelists; do not recompile per role.

4. **Dispatch panelists in parallel** — **single message, multiple Task calls**, one `rk-reviewer` agent per role. Each agent receives:
   - The sprint ID.
   - Its role label (`security` / `performance` / `style` / `correctness`).
   - The shared context packet from step 3.

   Do not dispatch serially. Do not stream output to the user during the parallel phase — wait for all agents to return.

5. **Merge findings** — once all panelists return, run:
   ```bash
   rk review-panel findings --sprint <SPRINT_ID> --json
   ```
   This is the canonical merge surface. Do not synthesize the merge yourself.

6. **Surface verdict recommendation** — render this shape:
   ```
   Review of <SPRINT_ID>:
     security:    <count> findings, severities <list>
     performance: <count> findings, severities <list>
     style:       <count> findings, severities <list>
     correctness: <count> findings, severities <list>
   Recommendation: <accepted | changes_requested | rejected>
   Reason: <one-line summary>
   Reply "accepted" / "changes" / "rejected" to record the verdict.
   ```

7. **Record verdict** — on user reply, run:
   ```bash
   rk review-verdict <REVIEW_ID> <verdict> --summary "<reason>"
   ```
   The `<verdict>` value is one of: `accepted`, `changes_requested`, `rejected`. Use the exact spelling.

8. **Resume run** — if the sprint belongs to an active run that paused at `awaiting_reviews`:
   ```bash
   rk run --resume <RUN_ID>
   ```
   Surface the resumed run to the user; route back to `/rk-run` for the post-resume flow.

## Refusals

- Never invent reviewer roles outside the configured panel.
- Never auto-record `accepted` without user confirmation.
- Never bypass `rk review-panel findings` and synthesize the verdict yourself — the merge logic lives in `rk` for auditability.
- Never use `rk review-verdict` with a typo (e.g., `approved` instead of `accepted`); the CLI will reject and the cost is wasted.

## Notes

- Parallel dispatch is the value of this command. If the harness can't run multiple subagents in one message, fall back to serial — but log a warning that parallel was unavailable.
- The `rk-reviewer` agent file lives at `agents/rk-reviewer.md`.
- On `changes_requested`, the sprint stays open. The user typically follows up with another `/rk-run` cycle after fixes.
