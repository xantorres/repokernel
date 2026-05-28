# RepoKernel Cheatsheet

CLI commands by intent. Load on demand.

## State

| Need | Command |
|---|---|
| Status (cheap) | `rk status --brief --json` |
| Epic progress (5-line) | `rk epic status <E>` |
| Next runnable | `rk next --json` |
| Next unblocked planned work | `rk next --include-planned --json` |
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
| Hotfix (scoped, free lane) | `rk hotfix "<desc>" --allow '<glob>' --lane auto` |
| Fork hotfix off an active sprint | `rk fork-hotfix-from <S> "<reason>"` |
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
| Safe sprint ship | `rk ship <S>` |
| Full sprint gates (target-scoped) | `rk gates <S>` |
| Full sprint gates (global validator) | `rk gates <S> --target-scope global` |
| One-shot review (cheap) | `rk review-sprint <S>` |
| Configured panel | `rk review-panel run <S>` |
| Verdict | `rk review-verdict <R> accepted\|changes_requested\|rejected` |
| Review command evidence | `rk review-evidence <S\|R> --label full-gates --command "<cmd>"` |
| Close epic | `rk epic ship <E>` / `rk epic close <E>` |
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
| Registry drift reason | `rk registry --check --explain` |
| Rebuild registry | `rk registry --write` |
| Move queued sprint off a busy lane | `rk queue move <S> --from <a> --to <b>` |
| Realign sprint base after a hotfix landed | `rk rebase-sprint <S> --to HEAD` |

## Plan

| Need | Command |
|---|---|
| Init | `rk init --commit` / `rk init --example --commit` |
| Create epic | `rk create epic "<title>"` |
| Create epic from tracker | `rk create epic "<fallback>" --from-tracker gh:owner/repo#NNN` |
| Create epic from JIRA | `rk create epic "<fallback>" --from-tracker jira:KEY-NNN` |
| Create epic from Linear | `rk create epic "<fallback>" --from-tracker linear:ABC-NNN` |
| Plan sprint from epic body | `rk plan <E> --create-sprint --enqueue` |
| Create sprint | `rk create sprint --epic <E> ...` |
| Set sprint routing | `rk sprint routing set <S> --complexity deep --pin-tier heavy --fanout fast:light,deep:standard` |
| Clear sprint routing | `rk sprint routing clear <S>` |
| Wave preview | `rk wave <E-NNN[..E-NNN]>` / `rk chain preview --epic <E>` |
| Wave apply | `rk wave <selector> --apply --enqueue` |
| Parallel-wave plan (disjoint allowed_paths) | `rk wave plan [SELECTOR] --json` |
| Sprint range selectors (wave plan) | `rk wave plan S-001..S-010` |
| Mixed selectors | `rk wave plan E-001,S-040..S-045,E-007` |
| Queue remove (refuses if dependents exist) | `rk queue remove <S> --lane <name>` |
| Queue remove with cascade | `rk queue remove <S> --lane <name> --cascade-dependents` |

## Config

| Need | Field |
|---|---|
| Custom branch naming | `worktrees.epicBranchPattern: "feature/epic/{epicId}"` + `worktrees.sprintBranchPattern: "feature/sprint/{epicId}/{sprintId}"` |
| Default review owner (legacy) | `automation.defaultReviewer: codex` |
| Review owner override (1.23.0+, takes precedence) | `automation.reviewer: codex` |
| Gate command (single) | `automation.checksCmd: pnpm check && pnpm test` |
| Gate command (phased, 1.23.0+) | `automation.checksPhases: { check: pnpm check, build: pnpm -r build, test: pnpm -r test }` |
| Expected rk binary (1.23.0+, `rk doctor` self-check) | `automation.binary: /Users/me/.local/bin/rk` |
| Tracker auth (jira) | env: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| Self-hosted JIRA on private network | env: `JIRA_ALLOW_PRIVATE_HOSTS=1` (loopback stays blocked) |
| Tracker auth (linear) | env: `LINEAR_API_KEY` |
| Tracker auth (gh) | uses `gh` CLI auth |
| Tracker fail mode | fail-closed by default; `--allow-tracker-fallback` opts into plain create on fetch failure |

## Trust (1.18.1+)

| Need | Command |
|---|---|
| Emit grant YAML for a repo | `rk trust audit /path/to/repo` |
| Apply audit to user-local file | `rk trust audit --apply /path/to/repo` |
| Check current cwd has grants | `rk trust check` / `rk trust check --json` |
| List active grants | `rk trust list` / `rk trust list --json` |
| Grant a scope | `rk trust grant checks_cmd` / `rk trust grant agent <name>` / `rk trust grant env_passthrough <NAME>` |
| Revoke a scope | `rk trust revoke <scope> [key]` |
| Pre-approved file in CI | env `REPOKERNEL_TRUST_FILE=/path/to/trust.yaml` |
| Full reference | `docs/trust.md` |

## CI

| Need | Snippet |
|---|---|
| Validate gate (PR) | `uses: xantorres/repokernel/.github/actions/rk-validate@v1` |
| Inputs | `fail-on`, `working-directory`, `version`, `json-artifact`, `comment-on-pr`, `treat-runtime-as` |
| Flaky-CI tolerance | `treat-runtime-as: neutral` converts `EXIT_RUNTIME` (2) to neutral exit 0 |
