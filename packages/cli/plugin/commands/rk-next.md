---
name: rk-next
description: Resolve the next runnable sprint. Use for "what's next".
---

# /rk-next

1. `rk team status --json` — if operational warnings are present, surface them before dispatch.
2. `rk validate --fail-on P0,P1 --json` — if non-zero, route to `/rk-doctor` and stop.
3. `rk next --json` — branch:
   - `runnable` → continue.
   - `blocked` → surface reason, stop.
   - `none` → tell the user there's nothing queued; suggest `/rk-plan` or `/rk-run -m "..."`.
4. `rk route <SPRINT_ID> --json` — read `routing_hint.tier` and pick the model.
5. Surface: sprint ID, title, tier, model. Ask "run it?" Do not auto-start.
