# Fastpath: one task, one worktree

The fastpath is the shortest end-to-end flow RepoKernel offers. Use it when you have a single coding task you want an agent to do in isolation.

```bash
rk init --commit
rk run -m "Add a /health endpoint that returns 200 OK" --agent claude
rk close T-001
```

That is the entire surface. Everything else (epics, sprints, queues, parallel waves) is for when you outgrow one task at a time.

## What happens behind the scenes

`rk run` accepts the task description in four equivalent ways:

```bash
rk run                            # opens $EDITOR with a structured template
rk run -m "Short task description"
rk run path/to/task.md
echo "Task description" | rk run --stdin
```

Task files and stdin may include optional YAML frontmatter:

```markdown
---
ac:
  - Returns 200 OK
allow:
  - src/api/**
deny:
  - src/legacy/**
---
Add a /health endpoint.
```

`ac` becomes sprint acceptance criteria. `allow` maps to `allowed_paths`; `deny` plus editor constraints map to `denied_paths`.

Each invocation:

1. Allocates a fresh task id `T-NNN` (scan `.repokernel/tasks/T-*.json`, max+1).
2. Synthesizes a one-sprint epic on the configured planning paths and adds the sprint to the default lane queue.
3. Commits the synthesis as `chore(rk): synthesize task T-NNN` so the working tree is clean before agent work begins.
4. Acquires an isolated Git worktree at `<config.worktrees.root>/<repo>/E-NNN`.
5. Hands the task packet to the chosen agent adapter.
6. Runs the configured checks command (see `automation.checksCmd` in `repokernel.config.yaml`).
7. Pauses with a reviewable diff if checks pass; leaves the task `active` if they do not.

A task alias `.repokernel/tasks/T-NNN.json` records the mapping from the user-visible `T-NNN` to the underlying epic and sprint ids so you never have to think about them.

## Closing a task

```bash
rk close T-001
```

Close is atomic. It only succeeds when the alias is in `review` state (i.e. checks passed). It then:

1. Commits any uncommitted RK metadata in the worktree.
2. Merges the worktree branch into your current branch with `git merge --no-ff`.
3. Auto-accepts the review verdict (the fastpath convention: arriving at review means the agent's work passed checks).
4. Marks the sprint `shipped`, captures `end_sha`, and clears the queue slot.
5. Releases the worktree.
6. Updates the alias to `shipped` with `closed_at`.

Each step is committed individually so the audit trail in `git log` is explicit:

```text
chore(rk): mark T-001 shipped
chore(rk): close T-001
chore(rk): auto-accept R-001 for T-001
merge rk/epic/E-001 (rk fastpath close)
chore(rk): record review state              # worktree-side metadata
chore(rk): record T-001 review state        # alias status update
chore(rk): synthesize task T-001
feat(S-001): fake implementation             # the agent's actual change
```

If `git merge` produces conflicts the merge is aborted, your branch stays at its prior HEAD, and the task remains in `review`. Resolve the conflicts manually and retry.

## Discarding a task

```bash
rk discard T-001
```

Cancels the sprint and epic, releases the worktree without merging, and marks the alias `cancelled`. No commits from the worktree branch enter your main branch.

## Failed checks

When the configured checks command fails after the agent's run, RepoKernel leaves the task in `active` with the worktree intact. You have two options:

```bash
rk run T-001       # retry the agent in the same worktree (TODO: documented in roadmap)
rk discard T-001   # release the worktree and drop the changes
```

`rk close T-001` refuses to merge until checks pass, so failed checks are a hard stop.

## Configuring checks

`rk init` produces a `repokernel.config.yaml`. Set the command(s) the agent's work must pass before merge:

```yaml
automation:
  checksCmd: pnpm lint && pnpm typecheck && pnpm test
```

The command runs inside the worktree so it sees the agent's commits.

## Editor template

When you run `rk run` with no arguments, RepoKernel opens `$EDITOR` (with a fallback chain `$VISUAL` → `$EDITOR` → `code --wait` → `nvim` → `vi`) on a structured template:

```markdown
# What should the agent do? (required)


# Acceptance criteria (optional, one per line)


# Constraints / forbidden paths (optional, one per line)


# Lines starting with # are ignored. Save and close to run, leave empty to abort.
```

You can fill only the first section (free-form prose) and leave the rest blank. Acceptance criteria are written into the synthesized sprint checklist. Constraints are treated as denied path globs, so the review gate blocks matching edits before close.

If you save the template with an empty first section, RepoKernel aborts the run and reports `Task aborted (empty body, nothing changed).`.

## Picking an agent

```bash
rk run -m "..." --agent claude    # Claude Code (cloud)
rk run -m "..." --agent codex     # OpenAI Codex (cloud)
rk run -m "..." --agent ollama    # local model via Ollama (no API keys)
rk run -m "..." --agent fake      # deterministic test agent (no LLM)
rk run -m "..." --agent manual    # pauses so you do the work yourself
```

Custom adapters are configured in `repokernel.config.yaml`. See [internals/agent-adapters.md](internals/agent-adapters.md).

### Local agent via Ollama

Install [Ollama](https://ollama.ai), pull a model, and point RepoKernel at it:

```bash
ollama pull llama3.1
ollama serve   # if not already running

OLLAMA_MODEL=llama3.1 rk run -m "Add a function add(a,b)" --agent ollama
```

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.1` | Model tag from `ollama list` |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama HTTP endpoint |
| `OLLAMA_TIMEOUT_MS` | `1800000` (30 min) | Per-request timeout — local CPUs are slow on long prompts |

The Ollama runner implements a deliberately simple single-turn protocol:

1. Read the sprint packet plus up to 20 tracked files from the worktree (truncated at 4 KB each so the prompt fits in modest context windows).
2. Ask the model for a JSON response of the shape `{ summary, files: [{path, content}] }`. Each returned file replaces the entire file at that path — no diffs.
3. Write the files inside the worktree, `git add` + `git commit`, return the result.

**Limitations** of the built-in `ollama` adapter:

- Whole-file replacement only — diffs are unreliable on small local models.
- Single turn — no retry, no tool use, no iterative refinement.
- Output quality scales with the model — Llama 3.1 8B handles trivial tasks; non-trivial work needs a larger model or a richer agent (consider running [aider](https://aider.chat) against your Ollama endpoint via the custom-adapter pattern).
- Ollama must be running and reachable at `OLLAMA_HOST`. The runner returns `failed` with a clear message if the request errors out.

## Files written

After `rk init --commit && rk run -m "..." --agent fake && rk close T-001`, your repo contains:

```
.repokernel/
  plan/
    epics/E-001.md          synthesized
    sprints/S-001.md        synthesized, status: shipped
    queues/main.md          slot was added then removed
    reviews/R-001.md        verdict: accepted
  tasks/T-001.json          alias mapping (T-001 → E-001 / S-001)
  registry.json             generated
```

Plus a merge commit on your current branch with the agent's actual code changes.

## When to graduate from fastpath

The fastpath is intentionally narrow: one task, one worktree, sequential. Reach for the deeper machinery when:

- You want multiple sprints driven by a single plan with explicit dependencies — see [internals/run-loop.md](internals/run-loop.md).
- You want sprints to run concurrently — see [internals/parallel-waves.md](internals/parallel-waves.md).
- You want explicit `allowed_paths` / `denied_paths` enforcement per sprint — see [internals/path-safety.md](internals/path-safety.md).
- You want quality-rule review panels — see [internals/review-gates.md](internals/review-gates.md).

The fastpath flow continues to work alongside those features; they are not mutually exclusive.
