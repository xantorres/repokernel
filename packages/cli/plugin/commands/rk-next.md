---
name: rk-next
description: Resolve the next runnable sprint. Use for "what's next".
---

# /rk-next

1. `rk validate --fail-on P0,P1 --json` — if non-zero, route to `/rk-doctor` and stop.
2. `rk next --include-planned --json` — branch:
   - `runnable` → continue.
   - `planned` → surface the unblocked planned sprint and ask whether to enqueue or run `/rk-plan`; do not mutate.
   - `blocked` → surface reason, stop.
   - `none` → tell the user there's nothing queued; suggest `/rk-plan` or `/rk-run -m "..."`.
3. `rk route <SPRINT_ID> --json` — read `routing_hint.tier` and pick the model.
4. Surface: sprint ID, title, tier, model. Ask "run it?" Do not auto-start.

The session-level operational preflight (`rk preflight` / `rk team status --json`) is described in SKILL.md and is run once per session, not per command.
