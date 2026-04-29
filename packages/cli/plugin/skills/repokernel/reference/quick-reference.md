# RepoKernel Quick Reference

Loaded on demand from the router skill. Covers: command surface by intent, tier→model examples per harness, the full anti-pattern list, and stop conditions.

## Command surface by intent

### Query / state
| Need | Command |
|---|---|
| What's safe to do? | `rk validate --fail-on P0,P1` |
| What runs next? | `rk next` |
| Active epics, summary | `rk ls epics` (`--unshipped` to filter) |
| Sprints in an epic | `rk sprint ls --epic <E-NNN>` |
| Reviews pending | `rk ls reviews --status pending` |
| Lanes / locks | `rk lane ls` |
| Active gates | `rk gate ls` |
| Inspect anything | `rk inspect <ID>` |
| Why is state broken? | `rk doctor`, `rk explain <CODE>` |
| Cost-aware routing hint | `rk route <ID> --profile implement\|review\|wave` |
| Compile context packet | `rk context <ID> --profile implement\|review\|wave` |
| Kanban view | `rk board` |

### Execution
| Need | Command |
|---|---|
| Run epic (auto-waves) | `rk run <E-NNN>` |
| Run single sprint | `rk start <S-NNN>` → edit → `rk review` → `rk close` |
| Fastpath (one-shot) | `rk run -m "<intent>"` (creates T-NNN) |
| Hotfix | `rk hotfix -m "<description>"` |
| Wave preview | `rk chain preview --epic <E-NNN>` |
| Run logs | `rk run logs <RUN_ID>` |
| Inspect a run | `rk run inspect <RUN_ID>` |
| Resume a paused run | `rk run --resume <RUN_ID>` |
| Abort a run | `rk run abort <RUN_ID>` |
| Discard fastpath | `rk discard <T-NNN>` |

### Lifecycle
| Need | Command |
|---|---|
| Start sprint | `rk start <S-NNN>` |
| Move to review | `rk review <S-NNN>` |
| Record verdict | `rk review-verdict <R-NNN> accepted\|changes_requested\|rejected` |
| Ship sprint | `rk close <S-NNN>` |
| Ship epic (after last sprint) | `rk epic close <E-NNN>` |
| Reopen | `rk reopen <S-NNN>` |
| Cancel | `rk cancel <S-NNN>` |

### Review automation
| Need | Command |
|---|---|
| Run panel | `rk review-panel run --sprint <S-NNN>` |
| Panel status | `rk review-panel status <S-NNN>` |
| Merged findings | `rk review-panel findings --sprint <S-NNN>` |
| Allocate reviewers | `rk review-allocate` |
| Reconcile drift | `rk review-reconcile` |
| End-to-end review | `rk review-sprint <S-NNN>` |
| Resolve a gate | `rk gate resolve <gate-name>` |

### Lane & worktree
| Need | Command |
|---|---|
| List lanes | `rk lane ls` |
| Acquire (rare; `rk run` does this) | `rk lane acquire <E-NNN>` |
| Release | `rk lane release <E-NNN>` |
| Enqueue sprint | `rk queue add <S-NNN> --lane <name>` |

### Registry & repair
| Need | Command |
|---|---|
| Diagnose | `rk doctor` |
| Auto-repair (safe) | `rk doctor --fix` |
| Preview mechanical fixes | `rk fix --preview` |
| Apply mechanical fixes | `rk fix --apply` |
| Registry drift check | `rk registry --check` |
| Regenerate registry | `rk registry --write` |
| Explain a code | `rk explain <CODE>` |

### Planning
| Need | Command |
|---|---|
| Init repo | `rk init [--example]` |
| Create epic | `rk create epic "<title>"` |
| Create sprint | `rk create sprint --epic <E-NNN> ...` |
| Create review | `rk create review --sprint <S-NNN>` |
| Create queue | `rk create queue --lane <name>` |

## Tier → model mapping (harness-specific)

`rk` is vendor-neutral. The mapping below is your harness's responsibility. Edit this section for your local install.

### Generic shape

```
light    → your cheapest reasoning-capable model
standard → your default coding model
heavy    → your strongest reasoning model
```

### Example: Anthropic Claude harness

```
light    → claude-haiku-<latest>      # e.g., claude-haiku-4-5
standard → claude-sonnet-<latest>     # e.g., claude-sonnet-4-6
heavy    → claude-opus-<latest>       # e.g., claude-opus-4-7
```

### Example: OpenAI / GPT harness

```
light    → gpt-mini
standard → gpt-flagship-coding
heavy    → reasoning-model
```

### Example: open-weight / local models

```
light    → llama-3.1-8b-instruct
standard → llama-3.3-70b-instruct
heavy    → deepseek-r1
```

Pick concrete IDs that exist in your harness today. Update when models rotate.

### Fanout dispatch

When `rk route <ID>` returns `routing_hint.fanout`, the fanout entries **are** the execution plan:

1. Spawn one agent per fanout entry, **in parallel** — single message, multiple tool calls.
2. Map each entry's `tier` through the table above.
3. Ignore the top-level `tier` (it's a summary for fanout-unaware consumers).

If `routing_hint.reason: "pinned"`, the sprint hard-pinned the tier — **do not override**.

## Full anti-pattern list

Things to never do inside an RK repo:

- Edit `.repokernel/registry.json` by hand → use `rk registry --write` or `rk fix --apply`.
- Mark a sprint shipped by changing `status:` in frontmatter → use `rk close <ID>`.
- Set `status: done` in epic frontmatter directly → use `rk epic close <ID>`.
- Infer "next sprint" from a markdown table, README, or prose → use `rk next`.
- Create lanes ad-hoc → use `rk lane acquire <E-NNN>`.
- Skip `rk review` / `rk close` and "just commit and move on".
- Run `rk validate` bare or `rk status` at session start → use `rk validate --fail-on P0,P1`.
- Use `--fail-on P2` or `--only P3` to suppress P0/P1 blockers.
- `git add .` or `git add -A` inside an RK worktree → stage explicit paths only.
- Run two sprints concurrently in the same worktree — `rk run` manages worktrees per sprint.
- Invent IDs (`R-999`, `S-X`) — if `rk ls` doesn't show it, it doesn't exist.
- Override `routing_hint.reason: "pinned"` without explicit user instruction.
- Edit sprint frontmatter to change routing mid-session — set `extras.routing.*` at planning time only.
- Auto-record review verdicts without user confirmation.

## Stop conditions

Halt and surface to the user when any of these fire:

- `rk validate --fail-on P0,P1` exits non-zero → route to `/rk-doctor`.
- `rk next` returns `blocked` → surface the reason; never auto-resolve.
- `rk doctor` reports unhealthy state that `rk fix --apply` cannot fix → escalate.
- A path-safety violation surfaces → abort the sprint, do not work around.
- A run reaches `merge_conflict`, `agent_failed`, or `path_violation` → run `rk run inspect`, surface, ask the user.

## When to call which surface

- **`rk route <ID>`** — fast (<50ms), routing hint only. Use to pick a tier before dispatch.
- **`rk context <ID> --with-routing`** — full context packet plus the routing hint. Use when feeding an agent.
- **`rk inspect <ID>`** — human-readable detail; not for automation. Use when surfacing to the user.
- **`rk validate --fail-on P0,P1`** — pre-code check, scoped to blockers.
- **`rk doctor`** — health summary; safe to run anytime.
