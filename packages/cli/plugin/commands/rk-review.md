---
name: rk-review
description: Review a sprint. Picks the cheapest review path (one-shot, configured panel, or parallel Claude panel) and records the verdict on user approval.
---

# /rk-review

1. Resolve sprint: user gave `<S-NNN>` → use it; otherwise `rk ls reviews --verdict pending --json` and pick the one match (or ask if multiple). Read `entity.epic_id` and `entity.review_id` from `rk inspect <S> --json`.

2. Pick the review path:
   - **Configured panel** — if `rk inspect <EPIC_ID> --json` shows `entity.quality_rules` containing `type: "panel_review"`. Ask user before running (it mutates state), then `rk review-panel run <S> --json` and trust the recorded verdict. Skip to step 6.
   - **Small diff one-shot** — if no panel and the diff is small (`changed_files` ≤ 5 OR scope summary indicates a trivial change), use `rk review-sprint <S>` (single reviewer, faster, cheaper). Skip to step 6.
   - **Default Claude panel** — otherwise, run the 4-role parallel panel below.

3. Compile context once: `rk context <S> --profile review --format json --with-routing`.

4. Spawn 4 `rk-reviewer` subagents **in parallel** (single message, multiple Task calls), one per role: `security`, `performance`, `style`, `correctness`. Pass `SPRINT_ID`, `ROLE`, `CONTEXT_PACKET`. Wait for all four.

5. Aggregate: RED if any panelist RED; YELLOW if any YELLOW; else GREEN. Map: GREEN → `accepted`, YELLOW → `changes_requested`, RED → `rejected`.

6. Surface findings + recommendation. Ask user to confirm.

7. On approval: `rk review-verdict <R> <verdict> --summary "<reason>"`. Use exact spelling.

8. If a run is paused at `awaiting_reviews`: `rk run --resume <RUN_ID>`.
