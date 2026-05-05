# PR bridge

`rk pr` is the bridge between a sprint and the pull request that ships it. Generate a PR body from sprint state, link the URL, sync status from GitHub, post comments — all idempotent, all rerunnable.

## Quick start

```bash
# 1. Agent finishes a sprint and opens a PR (manually or via gh).
gh pr create --title "$(rk inspect S-042 --json | jq -r .title)" --body "$(rk pr body S-042)"

# 2. Tell rk which PR belongs to the sprint.
rk pr link S-042 https://github.com/owner/repo/pull/456

# 3. Refresh the description from the latest sprint state.
rk pr body S-042 --write

# 4. Sync PR status (open / draft / merged / closed) into sprint metadata.
rk pr sync S-042

# 5. Post agent feedback.
rk pr comment S-042 "Tests green. Lint clean. Ready for review."
```

## Commands

### `rk pr body <sprint-id>`

Render a PR body from the sprint frontmatter and body. Pure: same sprint, same output. Send to stdout for piping into your favourite git tool.

```bash
rk pr body S-042                   # print body to stdout
rk pr body S-042 --json            # emit { body } envelope
rk pr body S-042 --summary "Tests pass; coverage 92%"
rk pr body S-042 --write           # post to the linked PR (gh CLI required)
```

The body template:

```markdown
## Description

{sprint.title}

{sprint.body}

---

**Sprint:** S-042
**Lane:** core
**Allowed paths:** packages/auth/**, tests/auth/**
**Review required:** yes
**Status:** active

## Agent Summary

{--summary text}

## Checklist

- [ ] Tests passing
- [ ] No new warnings
- [ ] Documentation updated
- [ ] Ready for review
```

### `rk pr link <sprint-id> <pr-url>`

Persist the PR URL under sprint frontmatter `extras.pr`. Provider is inferred from the URL hostname:

| URL pattern | Provider |
|---|---|
| `github.com` / `*.github.com` | `github` |
| `gitlab.com` / `*.gitlab.com` | `gitlab` |
| `bitbucket.org` / `*.bitbucket.org` | `bitbucket` |
| anything else | rejected with `unsupported PR host '<hostname>'` |

Self-hosted GitHub Enterprise / GitLab CE URLs are intentionally rejected so RepoKernel doesn't silently mis-categorise them as github. (A future `--provider <name>` override is on the roadmap.)

The metadata shape:

```yaml
extras:
  pr:
    provider: github
    url: https://github.com/owner/repo/pull/456
    number: 456                       # extracted from /pull/N
    status: open                      # populated by `rk pr sync`
    last_sync_at: 2026-05-04T13:30:00.000Z
```

URLs are validated by `HttpUrlSchema` — `javascript:`, `data:`, `vbscript:`, `file:`, `ftp:` are rejected at the schema layer.

### `rk pr status <sprint-id>`

Inspect the persisted metadata. Use `--json` to pipe into anything.

```bash
$ rk pr status S-042
S-042
  url:    https://github.com/owner/repo/pull/456
  status: open
  number: 456
  synced: 2026-05-04T13:30:00.000Z
```

### `rk pr sync <sprint-id>`

Refresh `status` from GitHub via `gh pr view --json state,url,title,isDraft,mergedAt`. Maps:

| GitHub | RepoKernel `status` |
|---|---|
| `isDraft: true` | `draft` |
| `mergedAt` set | `merged` |
| `state: CLOSED` | `closed` |
| anything else | `open` |

GitHub-only today. GitLab and Bitbucket return `sync only supported for GitHub`.

### `rk pr comment <sprint-id> <message>`

Post a comment via `gh pr comment <url> --body <message>`. Requires `gh` installed and authenticated. Errors map to:

| Reason | Cause |
|---|---|
| `gh_not_installed` | `gh` binary not on PATH |
| `not_authenticated` | `gh auth status` would fail |
| `not_found` | PR no longer exists |
| (anything else) | first 160 chars of stderr; `Command failed: ...` prefix is stripped so `--body` content cannot leak |

## Concurrency

`writePrMetadata` wraps a per-sprint-file `withLock`, so two concurrent `rk pr {link, sync, status}` invocations cannot lose each other's writes via a stale `extras` snapshot. The lock key is sanitised to a single path segment.

## Why isn't there a `--provider` override?

Self-hosted GitHub Enterprise needs explicit support for two reasons:

1. The `gh` CLI must be configured against the enterprise host (`gh auth login --hostname code.example.com`). RepoKernel inheriting that auth is fine, but it can't auto-detect the host from the URL.
2. Bitbucket Server (self-hosted) and GitLab CE (self-hosted) don't have first-class `gh`-equivalent CLIs everyone has installed.

Adding `--provider github` will arrive when the GH Enterprise integration is wired end-to-end. Until then, `rk pr link` errors loudly on unrecognised hosts rather than half-supporting them.

## Roadmap

Coming next on this surface:

- **Auto-link from `rk run`.** When the agent reports the PR URL in its summary, link it without a follow-up command.
- **Auto-body on close.** `rk close` can post the rendered body if a PR is linked.
- **Watch CI.** Surface `gh pr checks` status alongside `rk team status`.

## See also

- [Team status](team-status.md)
- [Merge safety](merge-safety.md)
- [Tracker bridge](trackers.md) — the symmetric write surface for issues
- [GitHub Action](ci.md) — `rk validate` on every PR
