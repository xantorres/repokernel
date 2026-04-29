---
name: rk-doctor
description: Diagnose RepoKernel drift safely. Invokes the rk-doctor subagent. Runs rk doctor / validate / fix --preview, surfaces a fix plan, awaits user approval. Never auto-applies fixes. Use for "what's broken", "fix the errors", "doctor" intent.
---

# /rk-doctor

Drift triage. Read-mostly. Always surfaces a plan and awaits user approval before any mutation.

## Procedure

1. **Invoke the rk-doctor subagent** — delegate to the agent at `agents/rk-doctor.md`. Pass the user's stated symptom (or "general check" if unspecified).

2. **Receive the fix plan** — the agent returns a structured plan:
   - Health summary (`rk doctor` output).
   - Validation findings grouped by severity (P0/P1/P2/P3) and code.
   - Mechanical fixes available (`rk fix --preview` output).
   - Registry drift (if any) from `rk registry --check`.

3. **Surface to user** — render the plan in this shape:
   ```
   RepoKernel doctor:
     Health: <healthy | <issues>>
     P0: <count>  P1: <count>  P2: <count>  P3: <count>
     Mechanical fixes available: <count>
     Registry drift: <none | <description>>

   Proposed actions:
     1. <action with exact rk command>
     2. <action with exact rk command>
     ...

   Reply "apply" to run these, "explain N" to expand step N, or "skip" to bail.
   ```

4. **Wait for user approval**. Do not run any mutation in this step.

5. **On "apply"** — execute the proposed commands one by one. Surface output of each. Stop on any non-zero exit and surface the failure.

6. **On "explain N"** — for each finding code, run:
   ```bash
   rk explain <CODE> --json
   ```
   Display the explanation. Loop back to step 4.

7. **Re-validate** — after applying any fixes:
   ```bash
   rk validate --fail-on P0,P1 --json
   ```
   Surface result. If still red, recurse: re-invoke this command. If clean, suggest `/rk-next` to resume work.

## Refusals

- Never run `rk fix --apply` without explicit user approval per session. Each `apply` reply approves only the current plan.
- Never edit `.repokernel/registry.json` directly — always use `rk registry --write` or `rk fix --apply`.
- Never silence findings by editing entity files.
- Never recommend `--fail-on P2` to hide P0/P1 blockers.

## Notes

- The `rk-doctor` subagent is read-mostly by design. It can run `rk fix --preview` (read) but never `rk fix --apply` (write). The dispatching command is responsible for the apply step, gated by user confirmation.
- For systemic drift (registry corruption, lane lock leaks): suggest `rk doctor --fix` only if the user agrees and the symptoms match safe-auto-repair scope. When in doubt, prefer manual surgical commands.
