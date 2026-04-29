---
name: rk-next
description: Resolve the next runnable sprint and surface its tier-routed cost band. Use for "what's next" intent. Calls rk validate / next / inspect with --json and rk route as JSON-only output. Pauses for user confirmation; never auto-starts work.
---

# /repokernel:rk-next

Resolve the next runnable sprint with its routing hint, then pause. Use when the user asks "what's next" or "what should I work on".

## Procedure

1. **Pre-check** — verify clean state:
   ```bash
   rk validate --fail-on P0,P1 --json
   ```
   If exit non-zero: stop, surface the blockers, route to `/repokernel:rk-doctor`. Do not proceed.

2. **Resolve next** — run:
   ```bash
   rk next --json
   ```
   Branch on the `status` field:
   - `runnable` → continue to step 3.
   - `blocked` → surface the reason from the JSON. Stop. Suggest `/repokernel:rk-doctor` if drift, otherwise show what's blocking.
   - `none` → no work pending. Stop. Suggest `/repokernel:rk-plan` if user wants to scaffold new work.

3. **Inspect the sprint** — run:
   ```bash
   rk inspect <SPRINT_ID> --json
   ```
   Capture: title, scope summary, `allowed_paths` count, `depends_on` state, acceptance criteria count, gate (if any).

4. **Route the sprint** — run:
   ```bash
   rk route <SPRINT_ID> --profile implement
   ```
   Read `routing_hint.tier` and `routing_hint.reason`. Map tier → harness model via the table in `reference/quick-reference.md`. If `routing_hint.fanout` is present, note it but **do not dispatch yet** — fanout dispatch belongs to `/repokernel:rk-run`.

5. **Surface to user** — render this shape:
   ```
   Next: <SPRINT_ID> — "<title>"
   Tier: <tier> (<reason>) → <model_name>
   Scope: <ac_count> AC, <allowed_paths_count> allowed paths
   Run it? Reply "yes" to start, "skip" to dismiss, or ask for more detail.
   ```

6. **Pause**. Do not run `rk start`, `rk run`, or any mutation. Wait for user confirmation.

## Refusals

- Never auto-start. The user must explicitly say "yes" / "ship it" / "run it".
- Never override `routing_hint.reason: "pinned"` without explicit user instruction.

## Notes

- `rk route` is fast (<50ms). Always call it before exposing the sprint to the user — the tier informs the cost band they're approving.
- Cache validate + next results for 60s within session; bust on any mutation.
