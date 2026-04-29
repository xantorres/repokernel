---
name: rk-plan
description: Scaffold an epic from intent. 1-3 sprints by default. Use for "plan an epic", "scaffold sprints".
---

# /repokernel:rk-plan

1. Confirm scope and acceptance with the user in one short turn. Don't synthesize the brief from prior context — get the user to state it.

2. Propose a sprint split (1-3 by default; only go higher if scope clearly justifies it). Each sprint: title, scope summary, `allowed_paths`, `depends_on`. Show the draft as plain markdown. Ask "approve?"

3. On approval:
   - `rk create epic "<title>"` → capture `<E-NNN>`.
   - For each sprint: `rk create sprint --epic <E-NNN> --title "<title>" --allowed-paths "<glob>" [--depends-on <S>,...]`.
   - `rk chain preview --epic <E-NNN>` to show wave structure.
   - `rk validate --fail-on P0,P1 --json`. If non-zero, surface and stop.

4. Print: epic ID, first runnable sprint, suggest `/repokernel:rk-next`. Do not auto-run.

For one-shot fixes, route to `/repokernel:rk-run` with `rk run -m "..."` instead.
