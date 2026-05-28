# Codex adapter

Run your RepoKernel tasks with [OpenAI Codex CLI](https://openai.com/codex) as the coding agent. Codex CLI is OpenAI's agentic coding tool — it edits files and runs shell commands inside the worktree RepoKernel provides.

> See also: [claude.md](claude.md) if you want to compare with the Claude Code adapter.

---

## Install Codex CLI

```bash
npm install -g @openai/codex
```

Verify:

```bash
codex --version
```

Full install guide: [github.com/openai/codex](https://github.com/openai/codex)

## Authenticate

Use the CLI login flow:

```bash
codex login
```

For non-interactive environments, set an API key:

```bash
export OPENAI_API_KEY=your-key-here
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist across sessions.

---

## First real task end-to-end

```bash
cd your-git-repo
rk init --commit

rk run -m "Add a /health endpoint that returns 200 OK" --agent codex

# Review the diff and checks result, then:
rk close T-001      # merge to main
# or
rk discard T-001    # drop without merging
```

### What to expect at each stage

**1. Synthesis** — RepoKernel builds a context packet: your task description, relevant config, and the list of allowed paths. You see:

```
Synthesizing task T-001…
Sprint S-001 created.
```

**2. Worktree creation** — An isolated Git branch is checked out at `.repokernel-worktrees/<repo>/T-001`. Codex works entirely inside this directory; your working tree is untouched.

**3. Agent run** — RepoKernel invokes:

```
codex exec --cd <worktree> --sandbox danger-full-access \
  "Read and follow the RepoKernel sprint packet at <packet_path>. Emit the required RepoKernel sentinel block when complete."
```

`codex exec` runs non-interactively, `--cd` points Codex at the sprint
worktree, and `--sandbox danger-full-access` lets it edit files and run shell
commands inside the already-isolated worktree. Codex reads the packet, edits
files, and commits its changes on the sprint branch, e.g.:

```
feat(S-001): add /health endpoint returning 200 OK
```

> **Note on sandboxing.** The preset assumes RepoKernel has already isolated
> the task in a dedicated Git worktree. If you want tighter Codex sandboxing,
> define a custom `agents.codex` entry and choose a different `--sandbox` value.
> RepoKernel's `allowed_paths` check still applies at review time regardless.

**4. Review pause** — When Codex finishes, RepoKernel runs your `checksCmd`. If checks pass, the run enters `review` state and pauses:

```
Run RUN-001 passed checks. Ready for review.
  rk close T-001    — merge to main
  rk discard T-001  — drop
```

If checks fail, the run is marked `active` and you can retry with `rk run T-001`.

**5. Close** — `rk close T-001` fast-forward merges the sprint branch to `main`, records the run as `shipped`, and removes the worktree.

---

## Cost and token expectations

Codex CLI charges according to the configured account and model. Per-task cost
depends on task complexity, context size, retries, and tool usage. Small,
scoped edits are usually cheap; broad refactors and multi-pass debugging cost
more. Check current pricing before budgeting automated runs.

Current pricing: [openai.com/api/pricing](https://openai.com/api/pricing)

---

## Common failure modes

### API key not set

```
Error: OPENAI_API_KEY is not set.
```

Fix: `export OPENAI_API_KEY=your-key-here`.

### Rate limit hit

Codex exits non-zero; RepoKernel marks the sprint `agent_failed:S-001` and logs the summary from the sentinel. Retry after the rate limit window:

```bash
rk run T-001   # resume on the same sprint
```

### Scope violation

If Codex edits files outside `allowed_paths`, RK's review gate catches the violation before `rk close` will merge:

```
Review blocked: changed files outside allowed_paths.
```

Widen `allowed_paths` in `repokernel.config.yaml` if the task legitimately needs broader access, then retry.

### Checks fail

The sprint stays `active`. Inspect the diff:

```bash
rk run inspect RUN-001
```

Then retry:

```bash
rk run T-001
```

Or drop the task:

```bash
rk discard T-001
```

---

## Further reading

- [Fastpath in depth](../fastpath.md) — the three-command flow explained step by step
- [Agent adapters reference](../internals/agent-adapters.md) — sentinel format, timeouts, custom agents
- [Config reference](../internals/config-reference.md) — `checksCmd`, `allowed_paths`, and more
