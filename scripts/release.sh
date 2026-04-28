#!/usr/bin/env bash
# Usage: ./scripts/release.sh [patch|minor|major|<version>]
# Bumps version in all package.json files, commits, tags, and pushes.
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

pnpm check
pnpm typecheck
pnpm -r build
pnpm -r test
pnpm --dir packages/cli pack --dry-run

git add package.json packages/cli/package.json packages/core/package.json packages/core/src/index.ts
if [[ -f CHANGELOG.md ]]; then
  git add CHANGELOG.md
fi

git commit -m "chore: release $next"
git tag "v$next"
git push
git push origin "v$next"

echo "Done: v$next tagged and pushed. GitHub Actions will publish to npm."
