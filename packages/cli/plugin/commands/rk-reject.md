---
name: rk-reject
description: Record a persisted out-of-scope decision (rejection ADR) and optionally close the linked tracker issue. Use for "won't fix", "out of scope", "we already said no to X", "reject this issue".
---

# /rk-reject

Records a rejection ADR under `.repokernel/rejections.json`. Each ADR captures a regex `pattern`, a `reason` (>=20 chars), a `scope` (feature / bug / enhancement), and a `created_at`/`created_by` audit trail. Future intake operations match new tickets against these ADRs and propose rejection — but only `/rk-reject` ever closes an issue.

1. Confirm the user intent. If they only want to skip a single ticket without persisting a rule, suggest closing the tracker issue directly instead — rejection ADRs are for repeated patterns, not one-offs.

2. Gather the four required inputs. Ask the user for any not provided:
   - `pattern`: a JavaScript regex matched (case-insensitive, single-line) against `title + "\n" + body`. Examples: `docker.*compose`, `^add support for windows`, `kubernetes.*operator`.
   - `reason`: human-written rationale, at least 20 characters. This is what reporters will see when their issue is closed.
   - `scope`: one of `feature`, `bug`, `enhancement`. Use `enhancement` when in doubt.
   - `ref` (optional): a tracker ref in `<source>:<ref>` form. Examples: `gh:owner/repo#42`, `jira:KEY-123`.

3. Run the command:

```
rk reject \
  --pattern "<regex>" \
  --reason "<rationale>" \
  --scope <feature|bug|enhancement> \
  [--ref <source>:<ref>] \
  [--close] \
  --json
```

4. Surface the resulting JSON envelope:
   - `action: "created"` — new REJ-<ULID> recorded.
   - `action: "duplicate"` — same `(pattern, scope)` already exists; `id` references the existing entry.
   - `tracker.attempted: true, tracker.ok: false` — close attempt failed (e.g. `not_implemented` for Jira/Linear, `not_authenticated` for an unauthorized fork). Surface the `reason` to the user.

5. If `--close` was set on a `gh:` ref and the close succeeded, leave a comment on the issue summarizing the rationale. Use the same comment that would be sent automatically by future intake — keeps reporter messaging consistent.

6. After recording, suggest `/rk-doctor` if the user wants to verify the file is well-formed. Doctor's check sweep validates schema and pattern compilation per entry.

## Idempotency

Re-running `/rk-reject` with the same `(pattern, scope)` is safe — the second call returns the existing entry with `action: "duplicate"`. Never deletes or rewrites prior rejections; the file is append-only.
