# Tracker integration

`rk create epic --from-tracker <source>:<ref>` seeds a new epic's title and body from an existing ticket in JIRA, Linear, or GitHub Issues. Linkage is recorded in the epic frontmatter under `extras.tracker_*` so `rk` can later reference the source of truth without re-fetching.

The bridge is **read-only**: it never writes back to the tracker, never modifies issue state, and never blocks epic creation on a network failure.

## Quick start

```bash
# GitHub Issues — uses your gh CLI auth
rk create epic "fallback title" --from-tracker gh:xantorres/repokernel#42

# JIRA Cloud
export JIRA_BASE_URL=https://acme.atlassian.net
export JIRA_EMAIL=you@acme.com
export JIRA_API_TOKEN=...   # from https://id.atlassian.com/manage-profile/security/api-tokens
rk create epic "fallback" --from-tracker jira:GDXINSI-2293

# Linear
export LINEAR_API_KEY=lin_api_...   # from https://linear.app/settings/api
rk create epic "fallback" --from-tracker linear:ABC-12
```

The fallback title is used only when the bridge fails. On success, the epic title is replaced with the ticket's title.

## Reference forms

| Source | Form | Example |
|---|---|---|
| GitHub Issues | `gh:owner/repo#NNN` | `gh:Zoetis-GlobalDx/gdxi-web-pwa#1631` |
| JIRA | `jira:KEY-NN` | `jira:GDXINSI-2293` |
| Linear | `linear:ABC-NN` | `linear:DOMI-148` |

Refs are validated at the CLI boundary — malformed inputs exit with `EXIT_USAGE` (`64`) before any disk write.

## Authentication

| Source | Mechanism | Required env / setup |
|---|---|---|
| `gh` | Shells out to the `gh` CLI; reuses whatever auth gh has set up. | `gh auth login` (or `GH_TOKEN`). No raw token handling in `rk`. |
| `jira` | HTTP Basic with API token. | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` all required. |
| `linear` | API key in `Authorization` header. | `LINEAR_API_KEY` required. |

Tokens are never echoed to stdout, stderr, or `--json` output. They are read once into request headers and discarded. The adapters do not pass these env vars to spawned subprocesses (the existing `agents.<name>.envPassthrough` allowlist excludes them by default).

## Frontmatter linkage

On a successful fetch, the new epic's frontmatter gains an `extras` block:

```yaml
---
id: E-001
title: "Refactor checkout flow"
status: planned
adr_links: []
sprints: []
extras:
  external_id: ABC-12
  tracker_source: linear
  tracker_url: https://linear.app/acme/issue/ABC-12
  tracker_labels:
    - p1
    - frontend
  tracker_assignee: Alex
---

# E-001: Refactor checkout flow

<ticket description follows...>
```

`extras` is RepoKernel's existing canonical slot for project-specific fields; no schema change was required to support tracker linkage.

## Failure semantics

The bridge never blocks epic creation. On any of these conditions the adapter returns `null`, emits a `tracker: ...` warning to stderr, and falls through to a plain create using the user-provided fallback title:

| Condition | Reported reason |
|---|---|
| Required env vars unset | `credentials not set` |
| `gh` CLI missing on `$PATH` | `gh CLI not installed` |
| HTTP 401 / 403 | numeric status |
| HTTP 404 / GraphQL "not found" | numeric status / `not found` |
| 5s request timeout | `timeout` |
| Network error | `network error` |
| Malformed response | `missing fields` / `missing title` |

The ID counter only advances on disk write, so a bridge failure does not skip an `E-NNN` slot.

## Concrete contract

The bridge is intentionally minimal:

- **No write-back.** v1.13 will not POST anything to the tracker. Status sync is on the [v2 backlog](https://github.com/xantorres/repokernel/labels/v2).
- **No polling.** One-shot at create time. No daemon, no webhooks.
- **No sprint-level ingest yet.** Only epic-level. Sprint mapping is on the [v1.14 backlog](https://github.com/xantorres/repokernel/labels/v2).
- **No retroactive linkage.** Existing epics are not migrated; a `rk migrate add-tracker` command is on the v2 backlog.
- **No stored credentials.** Env vars only, never written to a config file or keychain by `rk`.

## Anti-patterns

- **Don't put tokens in `repokernel.config.yaml`.** Use env vars. Config is checked in; env is not.
- **Don't pass tokens via shell history.** Use a `.envrc` (with `direnv`) or a secrets manager.
- **Don't rely on `extras.tracker_url` for ticket state.** It captures the URL at creation time; if the ticket moves or is renamed in the tracker, RepoKernel does not know. Re-link manually if needed.
