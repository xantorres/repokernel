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
IFS='.' read -r release_major _release_minor _release_patch <<< "$next"

if git rev-parse -q --verify "refs/tags/v$next" >/dev/null; then
  echo "error: tag v$next already exists" >&2
  exit 1
fi

echo "Releasing: $current -> $next"

# 1. Preflight: run every check that can fail BEFORE writing any files.
#    A failure here aborts cleanly with the working tree unchanged.
echo "Preflight checks…"

# Verify the credential helper would push as the personal account, not a
# work account that happens to be `gh auth switch`-ed in. Without this,
# a wrong active account leaves the repo half-released (commit + tag local,
# 403 on push) — exactly what happened on v1.14.1.
push_user=$(printf 'protocol=https\nhost=github.com\n\n' \
            | git credential fill 2>/dev/null \
            | awk -F= '$1=="username"{print $2}')
if [[ "$push_user" != "xantorres" ]]; then
  echo "error: git would push to $(git remote get-url origin) as '$push_user', expected 'xantorres'." >&2
  echo "       fix the credential helper before re-running release." >&2
  exit 1
fi

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
  packages/cli/plugin/.claude-plugin/plugin.json
  packages/cli/plugin/skills/repokernel/SKILL.md
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
  const file = 'packages/cli/plugin/.claude-plugin/plugin.json';
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.version = '$next';
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
"

node -e "
  const fs = require('fs');
  const file = 'packages/cli/plugin/skills/repokernel/SKILL.md';
  const src = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, src.replace(/^version: .+$/m, 'version: $next'));
"

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
git add \
  package.json \
  packages/cli/package.json \
  packages/core/package.json \
  packages/core/src/index.ts \
  packages/cli/plugin/.claude-plugin/plugin.json \
  packages/cli/plugin/skills/repokernel/SKILL.md
if [[ -f CHANGELOG.md ]]; then
  git add CHANGELOG.md
fi

git commit -m "chore: release $next"
git tag "v$next"
trap - EXIT

git push
git push origin "v$next"
git tag -f "v$release_major" "v$next"
git push origin "refs/tags/v$release_major" --force

echo "Done: v$next tagged and pushed. Moving action tag v$release_major updated. GitHub Actions will publish to npm."
