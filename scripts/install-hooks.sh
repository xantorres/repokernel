#!/bin/sh
# Install simple-git-hooks safely.
#
# `simple-git-hooks` writes to `<git-common-dir>/hooks/`. Running it from
# inside a linked worktree (where `.git` is a file pointing at
# `.git/worktrees/<name>`) fails with `ENOTDIR: not a directory, mkdir
# '<worktree>/.git/hooks'` *and*, depending on the version, has been
# observed to leave the parent repository's `core.bare` flipped to true,
# which then breaks every other worktree with "fatal: this operation must
# be run in a work tree".
#
# Skip cleanly when invoked from a worktree so `pnpm install` (which
# triggers the `prepare` script automatically) cannot corrupt the parent
# repository. Hook installation is a one-time setup task — running it
# from the main checkout is sufficient.

set -e

git_dir=$(git rev-parse --git-dir 2>/dev/null || true)
common_dir=$(git rev-parse --git-common-dir 2>/dev/null || true)

if [ -z "$git_dir" ] || [ -z "$common_dir" ]; then
  echo "[install-hooks] Not inside a git repository, skipping." >&2
  exit 0
fi

# Resolve both paths to absolute form so the comparison is robust against
# relative `.git` and `.git/worktrees/<name>` returns.
abs_git_dir=$(cd "$git_dir" 2>/dev/null && pwd -P || echo "$git_dir")
abs_common_dir=$(cd "$common_dir" 2>/dev/null && pwd -P || echo "$common_dir")

if [ "$abs_git_dir" != "$abs_common_dir" ]; then
  echo "[install-hooks] Detected a linked worktree ($abs_git_dir)." >&2
  echo "[install-hooks] Skipping simple-git-hooks install — run it from the main checkout instead." >&2
  exit 0
fi

exec npx simple-git-hooks
