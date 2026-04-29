---
name: rk-next
description: Resolve the next runnable sprint. Use for "what's next".
---

# /repokernel:rk-next

1. `rk validate --fail-on P0,P1 --json` — if non-zero, route to `/repokernel:rk-doctor` and stop.
2. `rk next --json` — branch:
   - `runnable` → continue.
   - `blocked` → surface reason, stop.
   - `none` → tell the user there's nothing queued; suggest `/repokernel:rk-plan` or `/repokernel:rk-run -m "..."`.
3. `rk route <SPRINT_ID> --json` — read `routing_hint.tier` and pick the model.
4. Surface: sprint ID, title, tier, model. Ask "run it?" Do not auto-start.
