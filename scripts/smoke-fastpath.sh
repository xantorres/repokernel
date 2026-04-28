#!/usr/bin/env bash
#
# scripts/smoke-fastpath.sh — end-to-end fastpath smoke for the published tarball.
#
# Drives `rk init` → `rk run -m "..." --agent fake` → `rk close T-001` against
# a freshly-initialized repo and asserts the resulting task is shipped. Used by
# .github/workflows/publish.yml after `pnpm pack` to catch regressions in the
# happy path before npm publish.
#
# Optional env:
#   RK_SMOKE_LAYOUT  — default | docs-layout — choose the path layout.
#                      Default uses `rk init`'s scaffold; "docs-layout" rewrites
#                      the config to put sprints/reviews/queues under docs/ and
#                      regenerates the scaffold so the close-merge transaction
#                      exercises a non-default layout.
#
# Usage: scripts/smoke-fastpath.sh </path/to/repokernel-x.y.z.tgz>

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <tarball.tgz>" >&2
  exit 2
fi

TARBALL="$1"
LAYOUT="${RK_SMOKE_LAYOUT:-default}"

if [ ! -f "$TARBALL" ]; then
  echo "error: tarball not found: $TARBALL" >&2
  exit 2
fi

# — install the published artifact globally and verify it runs —
#
# When RK_BIN is set, the script trusts the caller and uses the provided
# `rk` binary path verbatim instead of installing the tarball globally. This
# lets contributors validate the script against a built dist without a global
# npm install during development.

if [ -n "${RK_BIN:-}" ]; then
  rk() { "$RK_BIN" "$@"; }
  export -f rk
else
  npm install -g "$TARBALL" >/dev/null
fi

rk --version

# — scaffold a fresh git repo —

SMOKE_ROOT="$(mktemp -d)"
trap 'rm -rf "$SMOKE_ROOT"' EXIT
cd "$SMOKE_ROOT"
git init -q
git config user.email rk-smoke@example.com
git config user.name rk-smoke
git config commit.gpgsign false || true

rk init
# Commit the init scaffold so `rk run` doesn't refuse on a dirty tree when
# acquiring a worktree.
git add -A
git commit -q -m "chore: rk init"
rk validate

if [ "$LAYOUT" = "docs-layout" ]; then
  # Rewrite config to use docs/ for sprints/reviews/queues so the smoke
  # exercises the custom-path close path, then re-scaffold + re-validate.
  cat > repokernel.config.yaml <<'EOF'
schemaVersion: 1
projectId: rk-smoke
projectName: rk-smoke (docs layout)
paths:
  epics: docs/epics
  sprints: docs/sprints
  reviews: docs/reviews
  queues: docs/queues
  lanes: docs/lanes
  generated: .repokernel
  registry: .repokernel/registry.json
automation:
  defaultAgent: fake
worktrees:
  baseBranch: main
EOF
  rm -rf .repokernel/plan
  mkdir -p docs/epics docs/sprints docs/reviews docs/queues docs/lanes .repokernel
  cat > docs/queues/main.md <<'EOF'
---
lane: "main"
slots: []
---
EOF
  cat > docs/lanes/main.md <<'EOF'
---
name: "main"
---
EOF
  git add -A
  git commit -q -m "chore: scaffold docs layout"
  rk validate
fi

# — fastpath round-trip —

echo "» rk run -m \"smoke fastpath\" --agent fake"
rk run -m "smoke fastpath" --agent fake

echo "» rk task list (after run, expect status=review)"
rk task list

echo "» rk close T-001"
rk close T-001

# — assertions —

# Task list must report T-001 as shipped.
status_json="$(rk task list --json)"
echo "$status_json"
shipped="$(printf '%s' "$status_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
ok = any(a.get("id") == "T-001" and a.get("status") == "shipped" for a in data)
print("yes" if ok else "no")
')"
if [ "$shipped" != "yes" ]; then
  echo "::error::T-001 did not reach shipped status (layout=$LAYOUT)"
  exit 1
fi

# Working tree must be clean — fastpath close commits its own metadata.
if [ -n "$(git status --porcelain)" ]; then
  echo "::error::working tree dirty after fastpath close (layout=$LAYOUT)"
  git status
  exit 1
fi

echo "✓ fastpath smoke passed (layout=$LAYOUT)"
