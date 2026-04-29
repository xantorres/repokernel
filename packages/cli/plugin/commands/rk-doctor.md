---
name: rk-doctor
description: Diagnose RepoKernel drift. Read-only triage, gated apply. Handles validation findings and human gates. Use for "doctor", "what's broken", "unblock".
---

# /rk-doctor

1. Check for human gates first: `rk gate ls --json`. If any gate is open and the user said "unblock" / "release the gate" / "the X gate is approved":
   - Surface the gate name, owner, and reason from the response.
   - Ask the user to confirm release.
   - Run `rk gate resolve <gate-name>` (use `--dry-run` first to preview, then real run on confirm).
   - Re-check `rk next` and stop. Skip the rest unless the user asks for full triage.

2. Invoke the `rk-doctor` agent. Pass the user's symptom (or "general check" if unspecified). Receive a structured plan with `proposed_actions[]`.

3. Surface the plan: counts (P0/P1/P2/P3), proposed actions in order, each with the exact command and a `destructive` flag.

4. Ask user to approve each action. On per-action approval:
   - Run the command. Surface stdout/stderr. Stop on non-zero exit.
   - For `requires_user_input` (e.g., `SHIPPED_SPRINT_MISSING_BASE_SHA` needs `--base-sha <SHA>`): ask the user for the value, then run.
   - For `destructive: true`: confirm one more time naming the exact command.

5. After applying, re-run `rk validate --fail-on P0,P1 --json`. If clean, suggest `/rk-next`. If still red, ask the user whether to do another pass.
