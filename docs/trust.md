# Trust Model

RepoKernel separates **repo-authored config** from the **user's machine**.

A `repokernel.config.yaml`, an epic frontmatter file, or a panel reviewer
declaration ships with the repo. None of those things can — by themselves —
execute commands on your machine, request environment-variable passthrough,
or invoke a reviewer binary. The user-local trust file at
`~/.repokernel/trust.yaml` is the single grant authority. **Default is
closed.**

This page is the reference for that boundary: the file format, the
permission model, the error kinds, and the recipes for the common
situations.

## The file

`~/.repokernel/trust.yaml` is YAML with a strict shape:

```yaml
version: 1
repos:
  /Users/you/projects/myrepo:        # canonical realpath of the repo
    checks_cmd: true                 # allow automation.checksCmd to run
    env_passthrough:                 # env names the repo's agents may inherit
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
    agents:                          # agent names the repo may invoke
      - claude-runner
      - codex-reviewer
    reviewers:                       # panel reviewer command bindings
      critique-bot:
        command: /Users/you/.local/bin/critique
        args: ["--mode", "strict"]
        env_passthrough: ["OPENAI_API_KEY"]
        timeout_seconds: 300
```

Defaults:

- `version` MUST be `1`. Future versions raise
  `TRUST_FILE_VERSION_UNSUPPORTED` so you upgrade rk before opting in.
- File path is overridable via `REPOKERNEL_TRUST_FILE` — useful for CI.
- File size is capped at **256 KiB**. Bigger means YAML alias bomb or
  hand-edit gone wrong.
- YAML parses with `{ strict: true, maxAliasCount: 100 }` so duplicate keys
  and alias bombs are rejected at parse time.
- Reserved keys (`__proto__`, `constructor`, `prototype`) are rejected as
  defense in depth.

## What needs a grant

A repo declares a privileged action and rk gates it at runtime:

| Repo-authored field | Trust scope | Grant in YAML |
|---|---|---|
| `automation.checksCmd: "pnpm test"` | `checks_cmd` | `checks_cmd: true` |
| `agents: { claude-runner: { ... } }` | `agent` | `agents: ["claude-runner"]` |
| Same agent's `envPassthrough: ["X"]` | `env_passthrough` | `env_passthrough: ["X"]` |
| Epic `quality_rules.panel_review.reviewers.<id>` | `reviewer` | `reviewers: { <id>: { command, args, ... } }` |

Reviewer commands live in the user-local trust file, **not in the repo**.
The repo declares the reviewer by id only; you control which executable
that id binds to. This means a repo can't unilaterally introduce a new
reviewer binary on your machine.

## Worktree inheritance

A grant on the host repo applies to its worktrees. rk reads the worktree's
`.git` pointer file (pure FS, no subprocess), resolves the host repo path,
and looks up the trust grant under either path. You grant once, every
worktree under that repo inherits.

## Error kinds

| Kind | When | What to do |
|---|---|---|
| `TRUST_DENIED` | A repo declares a privileged action you haven't granted | `rk trust audit <repo> > ~/.repokernel/trust.yaml`, review, accept |
| `TRUST_FILE_INVALID` | YAML parse error, schema mismatch, reserved key, oversized | Open the file, fix the line the message names |
| `TRUST_FILE_UNREADABLE` | Permission denied, not a regular file | Check ownership: should be your user, mode 600 |
| `TRUST_FILE_VERSION_UNSUPPORTED` | `version` in the file is higher than this rk supports | Upgrade rk: `pnpm install -g repokernel@latest` |

Every kind carries the file path in the message so you don't have to guess.

## Recipes

### First-run setup for a new repo

```sh
rk trust audit /path/to/repo                 # emit the YAML fragment to stdout
rk trust audit --apply /path/to/repo         # merge it into ~/.repokernel/trust.yaml
```

The audit walks `repokernel.config.yaml`, epic frontmatter, and every
agent definition. It emits the exact YAML fragment that reproduces current
behavior — review the output, then accept. Reviewer ids that need manual
grants are surfaced as a "note" line (the audit deliberately doesn't
auto-bind commands).

### Check whether grants are missing

```sh
rk trust check                               # exit 0 clean, exit 1 with one-line hint
rk trust check --json                        # full evaluation envelope
```

The Claude Code plugin runs this at session start so trust gaps surface
before mid-task, not after.

### Grant / revoke a specific scope from the CLI

```sh
rk trust grant checks_cmd                    # for the current repo
rk trust grant agent claude-runner
rk trust grant env_passthrough OPENAI_API_KEY
rk trust revoke env_passthrough OPENAI_API_KEY
```

Reviewers are not exposed via `rk trust grant` — they need a
`{ command, args, ... }` block and that's authored by hand.

### List active grants

```sh
rk trust list                                # human-readable
rk trust list --json                         # full file as JSON
```

### CI / headless

Mount a pre-approved trust file via env:

```sh
REPOKERNEL_TRUST_FILE=/etc/repokernel/ci-trust.yaml rk gates S-001
```

The loader prefers `REPOKERNEL_TRUST_FILE` over the default path.

## Spawn-policy chokepoint

The runtime side of the trust boundary. Every child process rk spawns —
configured checks, agents, panel reviewers, internal `git`/`gh` tooling —
routes through `packages/cli/src/security/spawnPolicy.ts`.

- Env is constructed from `DEFAULT_SPAWN_ENV_ALLOWLIST` (PATH, HOME,
  SHELL, TERM, TMPDIR, CI, locale, …) plus trust-granted passthrough.
- For `git`/`gh` calls, an additional `GIT_TOOLING_ENV_ALLOWLIST`
  (author/committer identity, no tokens) layers on top. Tokens
  (`GH_TOKEN`, `GITHUB_TOKEN`, etc.) are forwarded to `gh` only.
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0` are forced on every tooling call, so a hostile
  repo's system/global git config or fsmonitor cannot leak parent secrets
  into hooks fired during `git commit` / `git checkout`.
- The full parent `process.env` is **never** inherited by a child.

## Sensitive env catalog

`isSensitiveEnvName(name)` flags names that match well-known secret
patterns (`_KEY$`, `_TOKEN$`, `_SECRET$`, `_PASSWORD$`, `_PASSPHRASE$`,
`_DSN$`, `_WEBHOOK_URL$`, plus prefixes for AWS / Anthropic / OpenAI /
Cohere / Mistral / Groq / HuggingFace / Replicate / Perplexity / NPM /
PyPI / Cargo / DATABASE / and bare `PASSWORD` / `PASSPHRASE` / `TOKEN` /
`SECRET`). When a repo declares one of these as `envPassthrough`, the
audit output surfaces it with a `# sensitive` annotation so you know
exactly what you're approving before you accept.

## What this is NOT

- Not a sandbox. A granted command runs as your user, with your filesystem
  permissions. The trust model gates **what runs**, not **what it can
  reach** once running.
- Not a network firewall. A granted reviewer binary can phone home if it
  wants to. Use `env_passthrough` discipline to control what credentials
  it has access to.
- Not a sandbox for `node` itself. rk gates the agents it spawns; the
  process running rk has whatever your shell has.

For seccomp / bwrap / Firecracker-style isolation, layer it on top of the
trust model — it's a separate concern.
