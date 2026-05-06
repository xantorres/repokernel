# Issue fastpath example

Deterministic fixture for the adoption path: issue-shaped input -> isolated worktree -> fake agent -> review pause -> `T-001` shipped.

## Try it

```bash
git init -q && git add -A && git commit -q -m "init"

# Offline deterministic flow: issue.md stands in for a tracker ticket body.
rk run issue.md --agent fake
rk close T-001
```

To use a real tracker instead of the fixture file:

```bash
rk run --from-tracker gh:owner/repo#42 --agent fake
```

`--from-tracker` fetches title and body before allocating IDs. On success, tracker metadata is stored on the synthetic epic and the `T-NNN` alias. On failure, RepoKernel exits before writing state unless `--allow-tracker-fallback` is explicit.

## What's here

- `issue.md` - tracker-style task body for offline demos.
- `app.js` - tiny starter file in the repo.
- `repokernel.config.yaml` - minimal RepoKernel config.
