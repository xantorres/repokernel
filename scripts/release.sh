#!/usr/bin/env bash
# Usage: ./scripts/release.sh [patch|minor|major|<version>] [--advance-major]
#
# Bumps version in all package.json files, commits, tags, and pushes.
#
# By default the moving major-version tag (v1, v2, ...) is NOT advanced.
# Pass --advance-major (or set ADVANCE_MAJOR=1) to also force-push the
# major tag. Floating major tags are an attestation that the GitHub
# Action shape is backwards-compatible — make it deliberate.
#
# Order matters: ALL preflight checks run before any version mutation, so a
# failed check leaves the working tree untouched. If a step fails after the
# version has been bumped, the trap rolls the bumped files back via
# `git checkout --`.
set -euo pipefail

BUMP="${1:-patch}"
ADVANCE_MAJOR="${ADVANCE_MAJOR:-0}"
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --advance-major) ADVANCE_MAJOR=1 ;;
    --no-advance-major) ADVANCE_MAJOR=0 ;;
    *) echo "error: unknown flag '$1'" >&2; exit 1 ;;
  esac
  shift
done

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

post_commit_recovery() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    cat >&2 <<RECOVERY

release pushed partially. local commits + tags are intact; remote is incomplete.
recovery:
  cd $(pwd)
  gh auth switch --user xantorres
  git push                                              # release commit
  git push origin v$next                                # immutable tag$( [[ "$ADVANCE_MAJOR" == "1" ]] && printf '\n  git push origin refs/tags/v%s --force         # major tag advance' "$release_major" )
RECOVERY
  fi
}
trap post_commit_recovery EXIT

git push
git push origin "v$next"

if [[ "$ADVANCE_MAJOR" == "1" ]]; then
  git tag -f "v$release_major" "v$next"
  git push origin "refs/tags/v$release_major" --force
  echo "Done: v$next tagged and pushed. Major tag v$release_major advanced. GitHub Actions will publish to npm + create the GitHub release."
else
  echo "Done: v$next tagged and pushed. Major tag v$release_major NOT advanced (pass --advance-major to advance it). GitHub Actions will publish to npm + create the GitHub release."
fi
trap - EXIT
