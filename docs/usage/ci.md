# Using RepoKernel in CI

The recommended way to gate PRs on `rk validate` is the official composite GitHub Action. It posts a sticky PR comment, emits inline annotations on every finding, uploads the JSON findings as a workflow artifact, and skips gracefully on repos that haven't adopted RepoKernel yet.

## Quick start

```yaml
# .github/workflows/repokernel.yml
name: RepoKernel
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: xantorres/repokernel/.github/actions/rk-validate@v1
        with:
          fail-on: P0,P1
          version: 1.33.0
```

That's the entire workflow. No matrix, no toolchain setup — the action installs Node 20 and `repokernel@<version>` itself.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `fail-on` | `P0,P1` | Severity threshold for failure. Comma list collapses to least-severe. Use `P0` for warn-only, `P0,P1,P2` for strict. |
| `working-directory` | `.` | Directory containing `repokernel.config.yaml`. Set when RK governs a sub-tree. Must resolve under `GITHUB_WORKSPACE`. |
| `version` | `latest` | npm version of `repokernel`. Pin to a specific release (e.g. `1.33.0`) for reproducible CI. |
| `json-artifact` | `true` | Upload `rk-findings.json` as a workflow artifact (14-day retention). |
| `comment-on-pr` | `true` | Post a sticky comment with severity counts and the first 25 findings. Requires `pull-requests: write`. |
| `treat-runtime-as` | `failure` | How to treat `EXIT_RUNTIME` (`2`) — tool / env crash, not a project-state breach. `failure` blocks the PR; `neutral` exits `0` with stderr surfaced. Use `neutral` when CI infra is flaky (npm install hiccups, transient runtime crashes) and you don't want unrelated PRs blocked. |

## Outputs

| Output | Description |
|---|---|
| `exit-code` | `0` on success or skip; `1` on findings breach; `2` on runtime error. |
| `findings-json` | Path to `rk-findings.json` (empty string when skipped). |

## Behavior matrix

| Repo state | `rk validate` exit | Action result |
|---|---|---|
| `repokernel.config.yaml` absent | not run | neutral exit `0`, skip-message in summary, no comment, no artifact |
| Validate runs cleanly | `0` | exit `0`, "OK" summary + comment |
| Validate finds breaches | `1` | exit `1`, GitHub annotations + summary table + PR comment |
| Validate fails to run | `2` | exit `2`, stderr in summary. Set `treat-runtime-as: neutral` to convert to neutral exit `0` for flaky-infra tolerance. |

The neutral-skip on missing config is intentional: it lets you add the action to an org-wide reusable workflow without blocking repos that haven't adopted RepoKernel.

## Pinning

Pin both the action ref and the npm version for reproducible CI. The action ref controls the workflow shape (action.yml inputs / steps); the `version` input controls which `rk` binary actually runs.

```yaml
- uses: xantorres/repokernel/.github/actions/rk-validate@v1.33.0
  with:
    fail-on: P0,P1
    version: 1.33.0   # do not float
```

When you upgrade to a new release, bump both refs together.

## Self-hosting / forking

If you need to run a fork or a feature branch, point the `uses:` ref at it directly:

```yaml
- uses: my-org/repokernel/.github/actions/rk-validate@my-feature-branch
```

The action is intentionally a single composite YAML — no marketplace-listed dependency, nothing to publish, nothing to compile. Forks are first-class.

## Required permissions

| Permission | Why |
|---|---|
| `contents: read` | Read the PR's tree. |
| `pull-requests: write` | Post / update the sticky comment (only if `comment-on-pr: true`). |

If you set `comment-on-pr: false`, `pull-requests: write` can be dropped.

## Using exit-code in downstream steps

```yaml
- id: rk
  uses: xantorres/repokernel/.github/actions/rk-validate@v1
- name: Block on findings
  if: steps.rk.outputs.exit-code != '0'
  run: |
    echo "RepoKernel findings present — see PR comment" >&2
    exit 1
```

The action already exits non-zero on `EXIT_FINDINGS`, so most users won't need this. It's useful for chaining additional reporting (e.g. uploading findings to a SARIF dashboard).

## Limitations

- **No per-rule overrides yet.** A single `fail-on` threshold applies to the whole report. Per-rule severity overrides are on the product backlog.
- **Best-effort line annotations.** JSON findings include `file` and a stable `line` fallback when the source file is available. Some project-level findings still point at the nearest owning file rather than an exact field.
- **Public npm install per run.** The action installs `repokernel` from npm on every run (no Docker image). For air-gapped CI, fork the action and replace the install step with a private mirror.

## Alternatives

If you cannot use the GitHub Action — e.g. running on GitLab CI, Jenkins, CircleCI — the equivalent invocation is:

```bash
npm install -g repokernel@1.33.0
rk validate --json --fail-on P0,P1 > rk-findings.json
echo $?  # 0 ok / 1 findings / 2 runtime
```

Wrap your platform's neutral-skip and annotation conventions around the JSON output. See [the action source](../../.github/actions/rk-validate/action.yml) for a working reference.
