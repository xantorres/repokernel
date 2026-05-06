# RepoKernel Cheatsheet

CLI commands by intent. Load on demand.

## State

| Need | Command |
|---|---|
| Status (cheap) | `rk status --brief --json` |
| Epic progress (5-line) | `rk epic status <E>` |
| Next runnable | `rk next --json` |
| Validate (blockers only) | `rk validate --fail-on P0,P1 --json` |
| Inspect entity | `rk inspect <ID> --json` |
| List fastpath tasks | `rk task list --json` / `rk task status <T-NNN>` |
| Routing hint | `rk route <ID> --json` |
| Context packet | `rk context <ID> --profile implement --format json --with-routing` |
| Context budget check | `rk context <ID> --profile implement --check` |
| Explain code | `rk explain <CODE>` |

## Run

| Need | Command |
|---|---|
| Fastpath one-shot | `rk run -m "<intent>"` |
| Hotfix (priority sprint) | `rk hotfix -m "<intent>"` |
| Run sprint or epic | `rk run <ID>` |
| Preview wave structure | `rk run <E-NNN> --dry-run` |
| Stream logs | `rk run logs <RUN_ID>` |
| Inspect run | `rk run inspect <RUN_ID>` |
| Resume | `rk run --resume <RUN_ID>` |
| Discard fastpath | `rk discard <T-NNN>` |
| Local HTML report | `rk report` |

## Lifecycle

| Need | Command |
|---|---|
| Manual sprint | `rk start <S>` → edit → `rk review <S>` → `rk close <S>` |
| One-shot review (cheap) | `rk review-sprint <S>` |
| Configured panel | `rk review-panel run <S>` |
| Verdict | `rk review-verdict <R> accepted\|changes_requested\|rejected` |
| Close epic | `rk epic close <E>` |
| Reopen / cancel | `rk reopen <S>` / `rk cancel <S>` |

## Gates

| Need | Command |
|---|---|
| List open gates | `rk gate ls --json` |
| Resolve a gate | `rk gate resolve <gate-name>` (preview with `--dry-run`) |

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
| Init | `rk init --commit` / `rk init --example --commit` |
| Create epic | `rk create epic "<title>"` |
| Create epic from tracker | `rk create epic "<fallback>" --from-tracker gh:owner/repo#NNN` |
| Create epic from JIRA | `rk create epic "<fallback>" --from-tracker jira:KEY-NNN` |
| Create epic from Linear | `rk create epic "<fallback>" --from-tracker linear:ABC-NNN` |
| Create sprint | `rk create sprint --epic <E> ...` |
| Set sprint routing | `rk sprint routing set <S> --complexity deep --pin-tier heavy --fanout fast:light,deep:standard` |
| Clear sprint routing | `rk sprint routing clear <S>` |
| Wave preview | `rk chain preview --epic <E>` |

## Config

| Need | Field |
|---|---|
| Custom branch naming | `worktrees.epicBranchPattern: "feature/epic/{epicId}"` + `worktrees.sprintBranchPattern: "feature/sprint/{epicId}/{sprintId}"` |
| Tracker auth (jira) | env: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| Self-hosted JIRA on private network | env: `JIRA_ALLOW_PRIVATE_HOSTS=1` (loopback stays blocked) |
| Tracker auth (linear) | env: `LINEAR_API_KEY` |
| Tracker auth (gh) | uses `gh` CLI auth |
| Tracker fail mode | fail-closed by default; `--allow-tracker-fallback` opts into plain create on fetch failure |

## CI

| Need | Snippet |
|---|---|
| Validate gate (PR) | `uses: xantorres/repokernel/.github/actions/rk-validate@v1` |
| Inputs | `fail-on`, `working-directory`, `version`, `json-artifact`, `comment-on-pr`, `treat-runtime-as` |
| Flaky-CI tolerance | `treat-runtime-as: neutral` converts `EXIT_RUNTIME` (2) to neutral exit 0 |
