# RepoKernel Cheatsheet

CLI commands by intent. Load on demand.

## State

| Need | Command |
|---|---|
| Status (cheap) | `rk status --brief --json` |
| Next runnable | `rk next --json` |
| Validate (blockers only) | `rk validate --fail-on P0,P1 --json` |
| Inspect entity | `rk inspect <ID> --json` |
| Routing hint | `rk route <ID> --json` |
| Context packet | `rk context <ID> --profile implement --format json --with-routing` |
| Explain code | `rk explain <CODE>` |

## Run

| Need | Command |
|---|---|
| Fastpath one-shot | `rk run -m "<intent>"` |
| Run sprint or epic | `rk run <ID>` |
| Stream logs | `rk run logs <RUN_ID>` |
| Inspect run | `rk run inspect <RUN_ID>` |
| Resume | `rk run --resume <RUN_ID>` |
| Discard fastpath | `rk discard <T-NNN>` |

## Lifecycle

| Need | Command |
|---|---|
| Manual sprint | `rk start <S>` → edit → `rk review <S>` → `rk close <S>` |
| Verdict | `rk review-verdict <R> accepted\|changes_requested\|rejected` |
| Close epic | `rk epic close <E>` |
| Reopen / cancel | `rk reopen <S>` / `rk cancel <S>` |

## Repair

| Need | Command |
|---|---|
| Diagnose | `rk doctor` |
| Preview fixes | `rk fix --preview --json` |
| Apply fixes | `rk fix --apply --yes` |
| Rebuild registry | `rk registry --write` |

## Plan

| Need | Command |
|---|---|
| Init | `rk init [--example]` |
| Create epic | `rk create epic "<title>"` |
| Create sprint | `rk create sprint --epic <E> ...` |
