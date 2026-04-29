---
name: rk-run
description: Execute a sprint, epic, or fastpath task. Use for "run", "ship it", "fix bug X".
---

# /repokernel:rk-run

1. Resolve target:
   - User gave free text (e.g., "fix login bug") → `rk run -m "<text>"` (fastpath, creates T-NNN).
   - User gave `<E-NNN>` / `<S-NNN>` / `<T-NNN>` → `rk run <ID>`.
2. Stream logs via `rk run logs <RUN_ID>` until terminal state.
3. Branch on outcome:
   - `awaiting_reviews` → suggest `/repokernel:rk-review`. Don't auto-pivot.
   - `completed` → ask "close it?" → `rk close <ID>`. For epics, after the last sprint: ask "close epic?" → `rk epic close <E-NNN>`.
   - `merge_conflict` / `agent_failed` / `path_violation` → `rk run inspect <RUN_ID>`, surface diagnostic, offer `--resume` or `rk discard`.
4. After close, suggest `/repokernel:rk-next`.
