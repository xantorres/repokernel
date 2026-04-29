---
name: rk-plan
description: Scaffold an epic from intent. 1-3 sprints by default. Authors routing intent (complexity, pin_tier, fanout) when the user signals it. Use for "plan an epic", "scaffold sprints".
---

# /repokernel:rk-plan

1. Confirm scope and acceptance with the user in one short turn. Don't synthesize the brief from prior context — get the user to state it.

2. Propose a sprint split (1-3 by default; only go higher if scope clearly justifies it). Each sprint: title, scope summary, `allowed_paths`, `depends_on`.

3. Author routing intent when the user signals it. Set `extras.routing.*` in the sprint frontmatter at planning time:
   - User says "this needs deep reasoning" / "tricky" → `extras.routing.complexity: deep`.
   - User says "use Opus" / "force the heavy tier" → `extras.routing.pin_tier: heavy` (hard pin; routing scorer won't override).
   - User says "fan out to 2 reviewers" / "split into a fast and a deep pass" → `extras.routing.fanout: [{id: fast, tier: light}, {id: deep, tier: standard}]`.
   - Otherwise omit `extras.routing` and let the project policy decide at run time.

4. Show the draft (sprint list + any routing intent) as plain markdown. Ask "approve?"

5. On approval:
   - `rk create epic "<title>"` → capture `<E-NNN>`.
   - For each sprint: `rk create sprint --epic <E-NNN> --title "<title>" --allowed-paths "<glob>" [--depends-on <S>,...]`.
   - For sprints with routing intent: edit the new sprint file's frontmatter to add `extras.routing` block (this is the one frontmatter edit the skill performs — `rk` has no CLI yet for authoring routing).
   - `rk chain preview --epic <E-NNN>` — show wave structure.
   - `rk validate --fail-on P0,P1 --json` — must be clean. If non-zero, surface and stop.

6. Print: epic ID, first runnable sprint, suggest `/repokernel:rk-next`. Do not auto-run.

For one-shot fixes, route to `/repokernel:rk-run` with `rk run -m "..."` instead.
