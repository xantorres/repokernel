---
name: rk-review
description: Run a review panel for a sprint. If the epic configures rk review-panel (external commands), ask before invoking the mutating panel runner. Otherwise spawn parallel rk-reviewer subagents (security, performance, style, correctness), merge findings in-skill, surface verdict recommendation. Records via rk review-verdict on user approval. Use for "review", "verdict", "panel" intent.
---

# /repokernel:rk-review

Run a review panel for a sprint in `awaiting_reviews` state. Two dispatch modes — configured external panel, or Claude-side parallel panel — picked automatically based on the epic's quality rules.

## Procedure

### 1. Resolve target

If user gave a sprint ID (`S-NNN`), use it. Otherwise:

```bash
rk ls reviews --verdict pending --json
```

If multiple pending: list and ask user to pick. If exactly one: confirm and proceed.

Then capture the matching sprint and review IDs:

```bash
rk inspect <SPRINT_ID> --json
```

Read `entity.epic_id` and `entity.review_id` from the response. Save both. If those fields are absent, stop and surface the malformed state; do not guess IDs from filenames.

### 2. Detect panel mode

Read the epic's quality rules:

```bash
rk inspect <EPIC_ID> --json
```

Read `entity.quality_rules` and look for an entry with `type: "panel_review"`. If present → **Mode A** (configured external panel). If absent → **Mode B** (Claude-side panel).

### Mode A — defer to configured external panel

The epic's `panel_review` rule lists reviewers as external commands (`id`, `command`, `args`, `failure_verdict`). `rk review-panel run` invokes each one, aggregates GREEN/YELLOW/RED, and records the resulting review verdict in RepoKernel state.

1. Surface the mutation and ask for approval before running:
   ```
   This sprint uses a configured RepoKernel review panel. Running it will write panel_runs, panel_aggregate, and verdict on the review.
   Run rk review-panel now?
   ```
   Stop until the user explicitly approves.

2. Run the panel:
   ```bash
   rk review-panel run <SPRINT_ID> --json
   ```
   This invokes every configured reviewer command sequentially or in parallel (per `rk` internals — not your concern). Capture exit code and stdout JSON. Non-zero can represent a configured failure verdict; continue to status readout unless the command failed before producing review state.

3. Read panel status for the audit trail:
   ```bash
   rk review-panel status <SPRINT_ID> --json
   ```
   The response shape:
   ```json
   {
     "sprint_id": "S-NNN",
     "review_id": "R-NNN",
     "panel_aggregate": "GREEN" | "YELLOW" | "RED" | null,
     "verdict": "accepted" | "changes_requested" | "rejected" | "pending",
     "rounds": [
       {
         "round": 1,
         "aggregate": "GREEN" | "YELLOW" | "RED",
         "completed_at": "...",
         "reviewers": [
           { "reviewer_id": "...", "verdict": "GREEN" | "YELLOW" | "RED", "findings": [...] }
         ]
       }
     ]
   }
   ```

4. Skip to step 5 (surface) with this aggregate and the verdict already recorded by RepoKernel. Do not run `rk review-verdict` unless the user explicitly asks to override the recorded verdict.

### Mode B — Claude-side parallel panel

No external panel configured. Run the four-role default panel.

1. **Compile context once**:
   ```bash
   rk context <SPRINT_ID> --profile review --format json --with-routing
   ```
   Save the full payload. Do not recompile per role.

2. **Find the active run** (for diff retrieval if not in the context packet):
   ```bash
   rk runs --json
   ```
   Filter for `sprint_ids` containing `<SPRINT_ID>` and `status` in `running | paused | awaiting_reviews | completed`. Save the latest matching `run_id`.

3. **Dispatch four panelists in parallel** — **one message, four Task calls**, each invoking the `rk-reviewer` agent:
   - role `security`
   - role `performance`
   - role `style`
   - role `correctness`

   Each agent receives `SPRINT_ID`, `ROLE`, `CONTEXT_PACKET`, optional `RUN_ID`. Wait for all four to return before proceeding.

4. **Merge in-skill** — collect each agent's JSON output (shape defined in `agents/rk-reviewer.md`). Compute the panel aggregate:
   - **RED** if any panelist returned `RED`.
   - **YELLOW** if no `RED` and at least one panelist returned `YELLOW`.
   - **GREEN** if all four returned `GREEN`.

   Group findings by role. Count P0/P1/P2/P3 across all roles. Save the merged structure for steps 5-6.

### 5. Surface verdict recommendation

Render this shape to the user (filling in real values):

```
Review of <SPRINT_ID> — panel_aggregate: <GREEN | YELLOW | RED>
  security:    <count> findings (<P0/P1/P2/P3 breakdown>) — verdict <GREEN | YELLOW | RED>
  performance: ...
  style:       ...
  correctness: ...

P0/P1 across roles: <count>
Recommendation: <accepted | changes_requested | rejected>
Reason: <one-line summary derived from highest-severity findings>

Mode A has already recorded the verdict after user-approved `rk review-panel run`.
Mode B: reply "accept" / "changes" / "reject" to record verdict, or "explain <CODE>" for a finding.
```

Mapping panel aggregate → `rk review-verdict` value:
- GREEN → `accepted`
- YELLOW → `changes_requested`
- RED → `rejected`

### 6. Record verdict

Mode A: skip this step unless the user explicitly asks to override the recorded verdict.

Mode B: on user reply:

```bash
rk review-verdict <REVIEW_ID> <verdict> --summary "<one-line reason>"
```

Use the exact spelling: `accepted`, `changes_requested`, `rejected`. Aliases like `approved` will fail — `rk` validates strictly.

### 7. Resume run

If a run is paused at `awaiting_reviews` for this sprint:

```bash
rk run --resume <RUN_ID>
```

Surface the resumed run state. Route back to `/repokernel:rk-run` for the post-resume flow.

## Refusals

- Never auto-record `accepted` without user confirmation. Even on a clean GREEN, ask. In Mode A, user approval to run `rk review-panel run` is approval for RepoKernel to record the configured panel verdict.
- Never bypass the dispatch-mode detection. If `rk inspect <EPIC_ID> --json` shows `entity.quality_rules` with a configured `panel_review`, use Mode A. Skipping rk's panel orphans audit trail entries.
- Never use `rk review-verdict` with non-canonical values. The CLI rejects typos; the cost is wasted.
- Never spawn more than four panelists in Mode B without a configured panel — adding roles ad-hoc creates inconsistent reviews across sprints.
- Never read files outside the sprint's `allowed_paths` to enrich the merge. If the panelists need more context, surface that as a finding and stop.

## Notes

- Parallel dispatch in Mode B is the value of this command. Single-message multi-Task calls; do not iterate serially.
- On `changes_requested`, the sprint stays open. The user typically follows up with another `/repokernel:rk-run` cycle after fixes; the next `/repokernel:rk-review` round increments `rounds[].round` automatically (Mode A) or re-runs the same panel (Mode B).
- Mode A's `rk review-panel run` is mutating. Treat a non-zero exit with recorded status as the panel's configured verdict, not as permission to re-run or overwrite it silently.
- The `rk-reviewer` agent file lives at `agents/rk-reviewer.md` and uses GREEN/YELLOW/RED scoring for compatibility with the Mode A aggregate.
