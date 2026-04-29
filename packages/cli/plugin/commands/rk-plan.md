---
name: rk-plan
description: Scaffold a new epic with 3-6 sprints from user intent. Asks discovery questions, drafts sprint frontmatter (allowed_paths, depends_on, gate), confirms with user, runs rk create, validates. Never auto-executes. Use for "plan an epic", "scaffold sprints", "split this into sprints" intent.
---

# /repokernel:rk-plan

Author a new epic with 3-6 sprints. Conservative by design — no execution, hard cap on sprint count.

## Procedure

1. **Discovery (3 short questions)** — ask the user, in one message:
   - **Scope** — what are we building? One paragraph.
   - **Acceptance** — what does done look like? 2-4 bullets.
   - **Paths** — which directories will sprints touch? Globs or paths.

   Wait for answers. Do not skip discovery; do not infer answers from prior context unless the user explicitly cites a prior conversation.

2. **Draft sprint split** — propose 3-6 sprints (hard cap: 6). Each sprint needs:
   - Title (imperative, ≤60 chars).
   - Scope summary (2-3 lines).
   - `allowed_paths` (globs, narrowest fit).
   - `depends_on` (sprint IDs from this epic, or empty).
   - Acceptance criteria (1-3 bullets).
   - Optional human checkpoint note if a gate applies.
   - Optional `extras.routing.complexity` hint (`trivial`/`standard`/`deep`).

   **Refuse to draft 7+ sprints in one shot.** If the user wants more, ship 6 now and add follow-ups in a second `/repokernel:rk-plan` round.

3. **Show the draft** — render the full proposed split as plain markdown. Do not call `rk` yet. Ask the user: "Approve this split, or adjust which sprint?"

4. **On approval** — execute scaffolding:
   ```bash
   rk create epic "<title>"
   ```
   Capture the new `E-NNN` ID. Then for each sprint in order:
   ```bash
   rk create sprint "<title>" --epic <E-NNN> --allowed-path "<glob>" [--after <S-NNN>] [--body-file <body.md>]
   ```
   Repeat `--allowed-path` and `--after` as needed. Put acceptance criteria, scope, and any gate note in the body file. Do not invent unsupported flags.

5. **Wave preview** — run:
   ```bash
   rk chain preview --epic <E-NNN>
   ```
   Surface the wave structure to the user.

6. **Validate** — run:
   ```bash
   rk validate --fail-on P0,P1 --json
   ```
   Must exit clean. If non-zero: surface findings, ask user to fix or roll back the epic.

7. **Hand back** — print:
   ```
   Epic <E-NNN> created with <N> sprints.
   First runnable: <S-NNN> (<tier>).
   Reply "next" to start, or "queue" to add to a lane.
   ```

   **Do not run `rk start` or `rk run`.** Planning ends with a clean epic, not with execution.

## Refusals

- Never author 7+ sprints in one round. Hard cap.
- Never skip the discovery interview, even if the user provides a long brief — at minimum, confirm scope and acceptance back before drafting.
- Never auto-execute (`rk start`, `rk run`) after creation. The user must invoke `/repokernel:rk-next` or `/repokernel:rk-run` separately.
- Never invent `allowed_paths` from imagination — always tie back to the user's stated paths in step 1.
- Never set `extras.routing.pin_tier` unless the user explicitly asks. Soft hints (`prefer_tier`) are fine; hard pins require intent.

## Notes

- For genuinely large work (10+ sprints): plan the first 6 here, then return for follow-up rounds. This forces the user to validate the split before doubling down.
- For one-shot fixes: do not use `/repokernel:rk-plan`. Route to `/repokernel:rk-run` with `rk run -m "..."` (fastpath T-NNN) or `rk hotfix`.
- The cost-tier defaults from project config will apply automatically. Only set `extras.routing.complexity` when the default would be wrong (e.g., a small file change with deep reasoning required).
