# `rk-validate` GitHub Action

Run `rk validate` on a [RepoKernel](https://github.com/xantorres/repokernel)-governed repo as a CI gate. Posts a sticky PR comment, uploads the JSON findings as an artifact, and emits inline GitHub annotations for any finding above the configured threshold.

## Quick start

```yaml
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
      - uses: xantorres/repokernel/.github/actions/rk-validate@v1.13.0
        with:
          fail-on: P0,P1
```

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `fail-on` | `P0,P1` | Severity threshold for failure. `rk validate` exits non-zero when any finding meets or exceeds this. Comma list collapses to least-severe. |
| `working-directory` | `.` | Directory containing `repokernel.config.yaml`. Set when RK governs a sub-tree of the repo. |
| `json-artifact` | `true` | Upload `rk-findings.json` as a workflow artifact (14-day retention). |
| `version` | `latest` | npm version of `repokernel` to install. Pin to `1.13.0` (or any released minor) for reproducible CI. |
| `comment-on-pr` | `true` | Post a sticky comment with severity counts and the first 25 findings. Requires `pull-requests: write` on the workflow. |

## Outputs

| Output | Description |
|---|---|
| `exit-code` | Exit code from `rk validate` (`0` ok / `1` findings breach / `0` neutral when skipped or runtime error). |
| `findings-json` | Path to the JSON findings file (empty when skipped). |

## Behavior matrix

| Repo state | `rk validate` exit | Action result |
|---|---|---|
| `repokernel.config.yaml` absent | not run | neutral exit `0`, summary message, no comment, no artifact |
| Validate runs cleanly, no findings ≥ threshold | `0` | exit `0`, summary "OK", PR comment "OK" |
| Validate finds breaches | `1` | exit `1`, GitHub annotations + summary table + PR comment |
| Validate fails to run (`EXIT_RUNTIME`) | `2` | neutral exit `0`, stderr surfaced in summary, no artifact |

The neutral-skip on missing config is intentional: it lets you add the action to an org-wide reusable workflow without blocking repos that haven't adopted RepoKernel yet.

## Pinning

For reproducible CI, pin to a specific RepoKernel minor version both in the action ref and in the `version` input:

```yaml
- uses: xantorres/repokernel/.github/actions/rk-validate@v1.13.0
  with:
    fail-on: P0,P1
    version: 1.13.0
```

## Related

- [RepoKernel CLI reference](../../../docs/internals/cli-reference.md)
- [CI usage guide](../../../docs/usage/ci.md)
- [Validation rules](../../../docs/internals/specs/validation.md)
