---
name: rk-review
description: Review a sprint. Spawns parallel rk-reviewer subagents, records verdict on user approval.
---

# /repokernel:rk-review

1. Resolve sprint: user gave `<S-NNN>` → use it; otherwise `rk ls reviews --verdict pending --json` and pick the one match (or ask if multiple). Read `entity.epic_id` and `entity.review_id` from `rk inspect <S> --json`.

2. If the epic has a configured panel: `rk inspect <EPIC_ID> --json` shows `entity.quality_rules` containing `type: "panel_review"`. Ask user before running it (it mutates state), then run `rk review-panel run <S> --json` and trust the recorded verdict. Skip to step 5.

3. Compile context once: `rk context <S> --profile review --format json --with-routing`.

4. Spawn 4 `rk-reviewer` subagents **in parallel** (single message, multiple Task calls), one per role: `security`, `performance`, `style`, `correctness`. Pass `SPRINT_ID`, `ROLE`, `CONTEXT_PACKET`. Wait for all four.

5. Aggregate (skip if Mode-A recorded the verdict): RED if any panelist RED; YELLOW if any YELLOW; else GREEN. Map: GREEN → `accepted`, YELLOW → `changes_requested`, RED → `rejected`.

6. Surface findings + recommendation. Ask user to confirm.

7. On approval: `rk review-verdict <R> <verdict> --summary "<reason>"`. Use exact spelling.

8. If a run is paused at `awaiting_reviews`: `rk run --resume <RUN_ID>`.
