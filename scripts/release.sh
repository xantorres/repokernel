#!/usr/bin/env bash
# Usage: ./scripts/release.sh [patch|minor|major|<version>]
# Bumps version in all package.json files, commits, tags, and pushes.
set -euo pipefail

BUMP="${1:-patch}"

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

echo "Releasing: $current → $next"

# bump all three package.json files
for pkg in package.json packages/cli/package.json packages/core/package.json; do
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
    p.version = '$next';
    fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
  "
done

# update CHANGELOG heading if it already has an [Unreleased] entry
if grep -q "\[Unreleased\]" CHANGELOG.md 2>/dev/null; then
  today=$(date -u +%Y-%m-%d)
  sed -i.bak "s/\[Unreleased\]/[$next] — $today/" CHANGELOG.md && rm -f CHANGELOG.md.bak
fi

git add package.json packages/cli/package.json packages/core/package.json CHANGELOG.md
git commit -m "chore: release $next"
git tag "v$next"
git push
git push origin "v$next"

echo "Done — v$next tagged and pushed. GitHub Actions will publish to npm."
