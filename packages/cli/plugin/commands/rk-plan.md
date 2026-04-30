---
name: rk-plan
description: Scaffold an epic from intent. 1-3 sprints by default. Authors routing intent (complexity, pin_tier, fanout) when the user signals it. Use for "plan an epic", "scaffold sprints".
---

# /rk-plan

1. Confirm scope and acceptance with the user in one short turn. Don't synthesize the brief from prior context — get the user to state it.

2. Propose a sprint split (1-3 by default; only go higher if scope clearly justifies it). Each sprint: title, scope summary, `allowed_paths`, `depends_on`.

3. Author routing intent when the user signals it. Set `extras.routing.*` in the sprint frontmatter at planning time:
   - User says "this needs deep reasoning" / "tricky" → `extras.routing.complexity: deep`.
   - User says "use Opus" / "force the heavy tier" → `extras.routing.pin_tier: heavy` (hard pin; routing scorer won't override).
   - User says "fan out to 2 reviewers" / "split into a fast and a deep pass" → `extras.routing.fanout: [{id: fast, tier: light}, {id: deep, tier: standard}]`.
   - Otherwise omit `extras.routing` and let the project policy decide at run time.

4. Show the draft (sprint list + any routing intent) as plain markdown. Ask "approve?"

5. **Confirm cwd before any mutating call.** Run `rk status --json` and verify `.configPath` matches the project the user named. If it points to a sibling repo, stop and ask — never `cd` cross-repo silently.

6. On approval:
   - `rk create epic "<title>"` → capture `<E-NNN>` from stdout. **Do not** derive the id by listing `.repokernel/plan/epics/`; `rk` allocates under a lock.
   - **Tracker linkage (v1.13+).** When the user references a JIRA / Linear / GitHub Issues ticket as the source of truth, pass `--from-tracker <source>:<ref>` to seed title and body from the ticket: `rk create epic "<fallback title>" --from-tracker gh:owner/repo#NNN` (or `jira:KEY-NN`, `linear:ABC-NN`). The bridge is read-only and never blocks creation — on offline / 401 / 404 it warns to stderr and falls through to a plain create with the user-provided title. If the warning fires, surface it verbatim and ask whether to proceed with the intent-only fallback or abort.
   - For each sprint: `rk create sprint "<title>" --epic <E-NNN> --allowed-path "<glob>" [--after <S-PREV>]`. `<title>` is positional; `--allowed-path` and `--after` are repeatable (also accept comma-separated values).
     - Prefer `--after S-PREV` over hand-authored `depends_on`: it sets `depends_on: [S-PREV]` for you and keeps sequential chains correct. Repeat `--after` for multiple predecessors.
   - For sprints with routing intent: edit the new sprint file's frontmatter to add `extras.routing` block (this is the one frontmatter edit the skill performs — `rk` has no CLI yet for authoring routing).
   - `rk chain preview --epic <E-NNN>` — show wave structure.
   - `rk validate --fail-on P0,P1 --json` — must be clean. If non-zero, surface and stop.

7. Print: epic ID, first runnable sprint, suggest `/rk-next`. Do not auto-run.

For one-shot fixes, route to `/rk-run` with `rk run -m "..."` instead.

### Verbs you can lean on (v1.10.2+)

- `rk inspect <E-NNN> --json` → returns `derived.sprints_progress` so you can
  show the user the post-creation sprint plan in one call.
- `rk ls sprints --epic <E-NNN> --json` → list the freshly created sprints.
- `rk next --json` → reads `active_epic_progress`, `last_closed`, and
  `queue_depth` so you can frame the "next" message without extra round
  trips.

When the epic includes only mechanical fixes (queue cleanup, worktree
ghosts, base_sha backfills), prefer `rk fix --preview --json` first —
many of those are now safe-fixes and don't need a sprint at all.
