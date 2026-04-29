---
name: rk-run
description: Execute a sprint, epic, fastpath task, or hotfix. Use for "run", "ship it", "fix bug X", "hotfix".
---

# /rk-run

1. Resolve target:
   - User said "hotfix" / "patch this fast" / "urgent" → `rk hotfix -m "<text>"` (creates a hotfix sprint with priority handling).
   - User gave free text (e.g., "fix login bug") → `rk run -m "<text>"` (fastpath, creates T-NNN).
   - User gave `<E-NNN>` / `<S-NNN>` / `<T-NNN>` → `rk run <ID>`.

2. Pre-dispatch checks (epics and sprints, skip for fastpath):
   - `rk run <ID> --dry-run` — preview wave structure. Surface to user if multi-wave.
   - `rk context <ID> --profile implement --check` — verify the context fits the budget. If it returns budget-exceeded, surface and stop; the user must scope down before running.

3. Run: `rk run <ID>` (or `rk run -m "..."` / `rk hotfix -m "..."` from step 1). Stream logs via `rk run logs <RUN_ID>` until terminal state.

4. Branch on outcome:
   - `awaiting_reviews` → suggest `/rk-review`. Don't auto-pivot.
   - `completed` → ask "close it?" → `rk close <ID>`. For epics, after the last sprint: ask "close epic?" → `rk epic close <E-NNN>`.
   - `merge_conflict` / `agent_failed` / `path_violation` → `rk run inspect <RUN_ID>`, surface diagnostic, offer `--resume` or `rk discard`.

5. After close, suggest `/rk-next`.
