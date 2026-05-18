---
name: rk-run
description: Execute a sprint, epic, fastpath task, or hotfix. Use for "run", "ship it", "fix bug X", "hotfix".
---

# /rk-run

1. Resolve target:
   - User said "hotfix" / "patch this fast" / "urgent" → `rk hotfix -m "<text>"` (creates a hotfix sprint with priority handling).
   - User gave free text (e.g., "fix login bug") → `rk run -m "<text>"` (fastpath, creates T-NNN).
   - User gave `<E-NNN>` / `<S-NNN>` / `<T-NNN>` → `rk run <ID>`.

2. Pre-dispatch checks:
   - Fastpath from a ticket: `rk run --from-tracker <source>:<ref> --agent <agent>` (the `--agent` flag is required when `--from-tracker` is set; pass `--agent manual` for import-without-dispatch). Add `-m "<fallback>"` only when the user provided fallback text.
   - Epics and sprints only: `rk run <ID> --dry-run` — preview wave structure. Surface to user if multi-wave.
   - Epics and sprints only: `rk context <ID> --profile implement --check` — verify the context fits the budget. If it returns budget-exceeded, surface and stop; the user must scope down before running.

The session-level operational preflight (`rk preflight` / `rk team status --json`) is described in SKILL.md and is run once per session, not per command.

3. Run: `rk run <ID>` (or `rk run -m "..."` / `rk hotfix -m "..."` from step 1). Stream logs via `rk run logs <RUN_ID>` until terminal state.

4. Branch on outcome:
   - `awaiting_reviews` → suggest `/rk-review`. Don't auto-pivot.
   - `completed` → ask "ship it?" → `rk ship <S-NNN>` for sprints. For epics, after the last sprint: ask "ship epic?" → `rk epic ship <E-NNN>`.
   - `merge_conflict` / `agent_failed` / `path_violation` → `rk run inspect <RUN_ID>`, surface diagnostic, offer `--resume` or `rk discard`.

5. After ship, suggest `/rk-next`.
