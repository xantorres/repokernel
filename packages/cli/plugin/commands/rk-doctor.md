---
name: rk-doctor
description: Diagnose RepoKernel drift. Read-only triage, gated apply. Use for "doctor", "what's broken".
---

# /repokernel:rk-doctor

1. Invoke the `rk-doctor` agent. Pass the user's symptom (or "general check" if unspecified). Receive a structured plan with `proposed_actions[]`.

2. Surface the plan: counts (P0/P1/P2/P3), proposed actions in order, each with the exact command and a `destructive` flag.

3. Ask user to approve each action. On per-action approval:
   - Run the command. Surface stdout/stderr. Stop on non-zero exit.
   - For `requires_user_input` (e.g., `SHIPPED_SPRINT_MISSING_BASE_SHA` needs `--base-sha <SHA>`): ask the user for the value, then run.
   - For `destructive: true`: confirm one more time naming the exact command.

4. After applying, re-run `rk validate --fail-on P0,P1 --json`. If clean, suggest `/repokernel:rk-next`. If still red, ask the user whether to do another pass.
