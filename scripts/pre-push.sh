#!/bin/sh
# Pre-push gate: typecheck + build + test the workspace.
#
# `git push` exports per-invocation environment variables (GIT_DIR,
# GIT_WORK_TREE, GIT_INDEX_FILE, GIT_PREFIX, GIT_REFLOG_ACTION,
# GIT_QUARANTINE_PATH, ...) that point at the *pushing* repository.
# These leak into every child process spawned by the hook — including
# `pnpm -r test`, which spawns child `git` invocations inside isolated
# tmp directories. Inherited GIT_DIR makes those child commands reach
# back into the parent repository (failing with "not in a work tree" or
# blocking on `.git/config: File exists` if the push is mid-flight).
#
# Strip every GIT_* variable up-front so the test suite sees a clean
# environment, exactly as if it had been launched from a plain shell.
# Skip via the standard `SKIP_SIMPLE_GIT_HOOKS=1` escape hatch.

set -e

if [ "$SKIP_SIMPLE_GIT_HOOKS" = "1" ]; then
  echo "[pre-push] SKIP_SIMPLE_GIT_HOOKS=1 — skipping checks." >&2
  exit 0
fi

for var in $(env | awk -F= '/^GIT_/{print $1}'); do
  unset "$var"
done

pnpm typecheck && pnpm -r build && pnpm -r test
