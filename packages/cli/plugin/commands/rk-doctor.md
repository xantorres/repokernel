---
name: rk-doctor
description: Diagnose RepoKernel drift safely. Invokes the rk-doctor subagent for read-only triage, then walks the user through approving each fix step-by-step. Mechanical safe fixes can be batch-approved; destructive actions require per-step confirmation. Never auto-applies. Use for "what's broken", "fix the errors", "doctor" intent.
---

# /rk-doctor

Drift triage. Read-mostly diagnosis followed by gated apply. The agent does the read sweep; this command gates every mutation.

## Procedure

### 1. Invoke the rk-doctor subagent

Delegate to the agent at `agents/rk-doctor.md`. Pass:
- `SYMPTOM` — the user's free-text description (or "general check" if unspecified).

Wait for the agent's structured plan (shape defined in `agents/rk-doctor.md`).

### 2. Inspect the plan

The agent returns:
- `health` (one line).
- `severity_counts` (P0/P1/P2/P3).
- `mechanical_fixes_available` count.
- `registry_drift` description.
- `lane_issues` array.
- `findings_by_code` map.
- `proposed_actions` array — each with `intent`, `command`, `rationale`, `destructive`, `requires_user_input`, `addresses_codes`.
- `stop_now` flag.

If `stop_now === true`: surface the reason, recommend the user fix the underlying state by hand, do not propose any actions. Stop.

### 3. Surface the plan

Render this shape (fill in real values):

```
RepoKernel doctor — health: <summary>

  P0: <n>  P1: <n>  P2: <n>  P3: <n>
  Mechanical fixes available: <count>
  Registry drift: <none | <description>>
  Lane issues: <count>

Findings:
  <CODE>     × <count>   (<severity>)
  <CODE>     × <count>   (<severity>)
  ...

Proposed actions (safest → riskiest):
  1. <intent>
       $ <command>
       <safe | destructive | requires user input>
  2. <intent>
       $ <command>
       ...

Reply with one of:
  "apply 1,2"          run only those steps
  "apply safe"         run all non-destructive steps in order
  "apply all"          run every step (destructive ones still confirm individually)
  "explain <CODE>"     show the rk explain output for a finding code
  "skip"               do nothing
```

Highlight destructive steps clearly. The default offer is `apply safe` — do not lead with `apply all`.

### 4. Wait for user input

Do not run any mutation. Loop on `explain <CODE>` requests by running `rk explain <CODE> --json` and re-rendering the plan.

### 5. On approval — execute the approved subset

For each approved action in order:

- If `destructive: false`: run the command. Surface stdout/stderr. Stop on any non-zero exit and surface the failure with the exact failing command.
- If `destructive: true`: pause and confirm one more time, naming the exact command. Only proceed on explicit "yes" / "confirm". Never on a generic "apply all".
- If `requires_user_input: true` (e.g., `SHIPPED_SPRINT_MISSING_BASE_SHA` needs `--base-sha <SHA>`): pause and ask for the input value, validate format (40-char hex for a SHA, or the user's git-resolved short SHA), then run the command. Never guess.

### 6. Re-validate

After any apply step ran:

```bash
rk validate --fail-on P0,P1 --json
```

If exit zero: surface "RepoKernel validation clean." and suggest `/rk-next`.

If exit non-zero and the finding count went down: surface remaining count and ask if the user wants another doctor pass.

If exit non-zero and the finding count is unchanged or grew: stop, surface the regression, route the user to manual investigation. Do not recurse blindly.

## Refusals

- Never run `rk fix --apply`, `rk doctor --fix`, `rk registry --write`, `rk next sync`, `rk epic close`, `rk lane release`, or `rk discard` without explicit user approval for the specific step. "Apply safe" approves only the non-destructive batch; destructive steps still require per-step confirmation.
- Never edit `.repokernel/registry.json` directly — always go through `rk registry --write` or `rk fix --apply`.
- Never silence findings by editing entity files.
- Never recommend `--fail-on P2` or `--only P3` to hide P0/P1 blockers.
- Never re-run the entire doctor sweep more than twice in a single session — if two passes don't clean it up, escalate to the user.
- Never invoke `rk doctor --fix` as a generic catch-all. Use only when the agent's plan explicitly proposed it for a specific missing-directory finding.

## Notes

- The `rk-doctor` agent is read-mostly. It can run `rk fix --preview` (read) but never `rk fix --apply`. The apply step is this command's responsibility, gated on user input.
- "Apply safe" batch typically covers `rk fix --apply` for `DEPRECATED_FIELD` / `SHIPPED_SPRINT_IN_QUEUE` / `CANCELLED_SPRINT_IN_QUEUE` / `DUPLICATE_REVIEW_ID` plus `rk registry --write` for `REGISTRY_DRIFT`. These are reversible from git and idempotent.
- Per-step confirmation for destructive actions exists because `rk epic close` and `rk lane release` change observable state outside the registry; they are not always reversible.
- The agent caches `rk explain <CODE>` responses across the plan. Re-asking for the same code on `explain <CODE>` should be cheap.
- If the user replies with a typo (e.g., "applay 1"), ask for clarification — do not fuzzy-match into "apply 1".
