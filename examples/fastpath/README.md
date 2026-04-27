# Fastpath example

Smallest possible RepoKernel project. One JavaScript file, one pre-written task, no plan files of your own to maintain.

## Try it

From a fresh checkout of this folder:

```bash
git init -q && git add -A && git commit -q -m "init"

# Run the deterministic test agent so this works without API credentials.
rk run task.md --agent fake

# Inspect the diff RepoKernel produced inside its worktree, then ship it:
rk close T-001
```

Or use a real agent by swapping `fake` for `claude` or `codex`:

```bash
rk run task.md --agent claude
```

## What's here

- `index.js` — a starter file the agent edits.
- `task.md` — the task description RepoKernel hands to the agent.
- `repokernel.config.yaml` — minimal config (defaults are fine in most cases; this just renames the projectId).

After you run the flow once, RepoKernel will have created `.repokernel/` with the synthesized epic and sprint, the alias `tasks/T-001.json`, and a `registry.json` snapshot.

## Reset

To rerun from scratch:

```bash
git clean -fdx
git checkout -- .
```

(Or recreate the example by checking out this directory fresh.)
