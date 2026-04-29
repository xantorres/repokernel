# Claude Code adapter

Run your RepoKernel tasks with [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) as the coding agent. Claude Code is Anthropic's official agentic coding CLI — it edits files, runs tests, and commits changes inside the worktree RepoKernel provides.

> See also: [codex.md](codex.md) if you want to compare with the OpenAI Codex adapter.

---

## Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

Verify:

```bash
claude --version
```

Full install guide: [docs.anthropic.com/en/docs/claude-code/getting-started](https://docs.anthropic.com/en/docs/claude-code/getting-started)

## Authenticate

```bash
claude login
```

This opens a browser-based OAuth flow and writes a credential to `~/.claude/credentials.json`. No manual env var required for interactive use.

For non-interactive environments (CI, headless servers), set:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

The key takes precedence over the stored credential.

---

## First real task end-to-end

```bash
cd your-git-repo
rk init --commit

rk run -m "Add a /health endpoint that returns 200 OK" --agent claude

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

**2. Worktree creation** — An isolated Git branch is checked out at `.repokernel-worktrees/<repo>/T-001`. Claude Code works entirely inside this directory; your working tree is untouched.

**3. Agent run** — RepoKernel invokes:

```
claude --print --cwd <worktree> -p <packet_path>
```

Claude Code reads the packet, edits files, runs any checks you configured, and commits its changes. You see Claude's output streaming to the terminal. Each commit lands on the sprint branch, e.g.:

```
feat(S-001): add /health endpoint returning 200 OK
```

**4. Review pause** — When Claude finishes, RepoKernel runs your `checksCmd` (defined in `repokernel.config.yaml`). If checks pass, the run enters `review` state and pauses:

```
Run RUN-001 passed checks. Ready for review.
  rk close T-001    — merge to main
  rk discard T-001  — drop
```

If checks fail, the run is marked `active` and you can retry with `rk run T-001`.

**5. Close** — `rk close T-001` fast-forward merges the sprint branch to `main`, records the run as `shipped`, and removes the worktree.

---

## Cost and token expectations

Claude Code's per-task cost depends on task complexity and model. Rough ranges:

| Task size | Typical token use | Cost (Claude Sonnet 4) |
|---|---|---|
| Small (1–2 file edit) | 10k–50k tokens | $0.02–$0.15 |
| Medium (new feature, tests) | 50k–200k tokens | $0.15–$0.60 |
| Large (refactor, multiple files) | 200k–500k tokens | $0.60–$1.50 |

These are rough estimates. Actual usage depends on context window fill, number of tool calls, and model version.

Current pricing: [anthropic.com/pricing](https://www.anthropic.com/pricing)

---

## Common failure modes

### Auth not configured

```
Error: No API key found. Run `claude login` or set ANTHROPIC_API_KEY.
```

Fix: `claude login` or `export ANTHROPIC_API_KEY=...`.

### Rate limit hit

Claude Code exits non-zero; RepoKernel marks the sprint `agent_failed:S-001` and logs the summary from the sentinel. Retry after the rate limit window:

```bash
rk run T-001   # resume on the same sprint
```

### Sandbox / scope refusal

If Claude Code declines to write a file outside `allowed_paths` in your config, RK's review gate also catches out-of-scope changes before `rk close` will merge. Check `allowed_paths` in `repokernel.config.yaml` and widen it if the task legitimately needs broader access.

### Checks fail

The sprint stays `active`. Inspect the diff:

```bash
rk run inspect RUN-001
```

Then retry:

```bash
rk run T-001
```

Or drop the task entirely:

```bash
rk discard T-001
```

---

## Further reading

- [Fastpath in depth](../fastpath.md) — the three-command flow explained step by step
- [Agent adapters reference](../internals/agent-adapters.md) — sentinel format, timeouts, custom agents
- [Config reference](../internals/config-reference.md) — `checksCmd`, `allowed_paths`, and more
