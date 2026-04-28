#!/usr/bin/env bash
# Usage: ./scripts/release.sh [patch|minor|major|<version>]
# Bumps version in all package.json files, commits, tags, and pushes.
#
# Order matters: ALL preflight checks run before any version mutation, so a
# failed check leaves the working tree untouched. If a step fails after the
# version has been bumped, the trap rolls the bumped files back via
# `git checkout --`.
set -euo pipefail

BUMP="${1:-patch}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: release requires a clean working tree and index" >&2
  exit 1
fi

current=$(node -p "require('./packages/cli/package.json').version")

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  next="$BUMP"
else
  IFS='.' read -r major minor patch <<< "$current"
  case "$BUMP" in
    major) next="$((major + 1)).0.0" ;;
    minor) next="${major}.$((minor + 1)).0" ;;
    patch) next="${major}.${minor}.$((patch + 1))" ;;
    *) echo "error: invalid bump type '$BUMP' (use patch|minor|major or an explicit version)" >&2; exit 1 ;;
  esac
fi

if git rev-parse -q --verify "refs/tags/v$next" >/dev/null; then
  echo "error: tag v$next already exists" >&2
  exit 1
fi

echo "Releasing: $current -> $next"

# 1. Preflight: run every check that can fail BEFORE writing any files.
#    A failure here aborts cleanly with the working tree unchanged.
echo "Preflight checks…"
pnpm check
pnpm typecheck
pnpm -r build
pnpm -r test
pnpm --dir packages/cli pack --dry-run

# 2. Mutation: bump versions and changelog. From this point on, a failure
#    must roll back the modified files.
TOUCHED_FILES=(
  package.json
  packages/cli/package.json
  packages/core/package.json
  packages/core/src/index.ts
)
if grep -q "\[Unreleased\]" CHANGELOG.md 2>/dev/null; then
  TOUCHED_FILES+=(CHANGELOG.md)
fi

cleanup_on_fail() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "release aborted ($rc) — rolling back version bump…" >&2
    git checkout -- "${TOUCHED_FILES[@]}" 2>/dev/null || true
  fi
}
trap cleanup_on_fail EXIT

for pkg in package.json packages/cli/package.json packages/core/package.json; do
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
    p.version = '$next';
    fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
  "
done

node -e "
  const fs = require('fs');
  const file = 'packages/core/src/index.ts';
  const src = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, src.replace(/export const VERSION = '[^']+';/, \"export const VERSION = '$next';\"));
"

if grep -q "\[Unreleased\]" CHANGELOG.md 2>/dev/null; then
  today=$(date -u +%Y-%m-%d)
  sed -i.bak "s/\[Unreleased\]/[$next] - $today/" CHANGELOG.md && rm -f CHANGELOG.md.bak
fi

# 3. Commit + tag + push. Disarm the rollback trap once we've committed —
#    an undo from here is a git revert by the operator, not a checkout --.
git add package.json packages/cli/package.json packages/core/package.json packages/core/src/index.ts
if [[ -f CHANGELOG.md ]]; then
  git add CHANGELOG.md
fi

git commit -m "chore: release $next"
git tag "v$next"
trap - EXIT

git push
git push origin "v$next"

echo "Done: v$next tagged and pushed. GitHub Actions will publish to npm."
