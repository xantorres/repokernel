# Release policy

How RepoKernel cuts releases, advances tags, and authors notes. Operator
reference, not user-facing.

## Versioning

Semantic versioning (`major.minor.patch`).
- `major` — breaking changes to the CLI surface, on-disk schema, or
  public JSON contract.
- `minor` — additive features (new verbs, new flags, new schema fields
  with defaults).
- `patch` — bug fixes, doc fixes, internal refactors that do not
  change observable behavior.

The schema-version envelope (see [json-schemas.md](json-schemas.md))
moves independently per surface and bumps when the shape changes in a
way consumers must branch on.

## Tag taxonomy

Three classes of git tags published by `pnpm release`:

| Tag                | Mutability       | Purpose                                                  |
|--------------------|------------------|----------------------------------------------------------|
| `v1.31.0`          | Immutable        | Pinpoint identification of a specific release.           |
| `v1`               | Floating (force) | "The latest 1.x" — used by GitHub Action consumers.      |
| (none for `v1.27`) | n/a              | We do not ship floating minor tags.                      |

`v1.31.0` is created on every release. `v1` is **only** advanced when the
operator opts in via `--advance-major` (or `pnpm release:advance-major`).
Floating major tag advancement is an attestation that `action.yml` shape
is backwards-compatible with what `@v1` consumers expect — make it
deliberate.

## Recommended pinning

The canonical guidance in user-facing docs:

```yaml
- uses: xantorres/repokernel/.github/actions/rk-validate@v1.31.0
  with:
    fail-on: P0,P1
    version: 1.31.0
```

`@v1` is documented as "implicit upgrades on every patch — accept this
trade-off only if you want the latest 1.x without re-pinning." All
worked examples pin to a specific release.

## Release sequence (`scripts/release.sh`)

1. **Preflight** — runs every check that can fail BEFORE any version
   mutation. A failure here aborts cleanly with the working tree
   untouched.
   - Clean working tree + index.
   - Tag does not already exist.
   - Credential helper would push as `xantorres` (not a work account).
   - CHANGELOG has either `[Unreleased]` block or a literal
     `## [<next>] - YYYY-MM-DD` heading.
   - `pnpm check`, `pnpm typecheck`, `pnpm -r build`, `pnpm -r test`,
     `pnpm pack --dry-run`.
2. **Mutation** — bump versions and CHANGELOG. From this point on, a
   failure rolls back the modified files via the trap.
   - Update `package.json`, `packages/cli/package.json`,
     `packages/core/package.json`, `packages/core/src/index.ts`,
     `packages/cli/plugin/.claude-plugin/plugin.json`,
     `packages/cli/plugin/skills/repokernel/SKILL.md`.
   - Rename `[Unreleased]` heading to `[<next>] - <today>` if present.
3. **Commit + tag + push.** Disarm the rollback trap. Push the release
   commit and the immutable patch tag. Print recovery instructions
   if any push fails.
4. **Optional major-tag advance.** When `--advance-major` was passed,
   force-update `v<major>` to point at the new release and force-push
   it.

## Publish pipeline (`.github/workflows/publish.yml`)

Triggered on tag push matching `v[0-9]+.[0-9]+.[0-9]+`.

Order matters: GitHub release creation runs **before** npm publish. The
release is cheap and revertible (`gh release delete`); npm publish is
permanent. A missing CHANGELOG section, malformed body, or transient
`gh` failure aborts the workflow before the tarball ships to npm.

Release notes are extracted from `CHANGELOG.md` by literal-string match
(`awk index()`) on the `## [<version>] - <date>` heading. Both ASCII
hyphen and em-dash separators are accepted. A missing section fails
loud — no silent fallback to a generic body.

## Rollback

| Failure mode                                          | Recovery                                                         |
|-------------------------------------------------------|------------------------------------------------------------------|
| Preflight check fails                                 | Fix the underlying issue, re-run `pnpm release`.                 |
| Mutation step fails (cleanup trap fires)              | Working tree restored automatically; investigate and re-run.     |
| Push fails after commit/tag                           | Recovery script printed by trap; manually push commit + tag.     |
| `gh release create` fails                             | npm publish has not run; fix CHANGELOG / gh auth and re-run workflow. |
| npm publish fails after gh release                    | `gh release delete v<version>`, fix npm auth, re-run workflow.   |
| Wrong release published                               | `npm deprecate repokernel@<version>` (cannot unpublish 24h+).    |
| Wrong `v1` tag advanced                               | `git push origin v<last-good>:refs/tags/v1 --force` to roll back. |

## CHANGELOG conventions

- Top of file: `## [Unreleased]` block, kept up to date as work lands.
- Each release section: `## [X.Y.Z] - YYYY-MM-DD`.
- Hyphen separator preferred (`-`); em-dash (`—`) is accepted but
  legacy and slowly being normalized.
- Section bodies use `### Added`, `### Changed`, `### Fixed`,
  `### Removed`, `### Documentation`, `### Schema`.

## Why `v1` is opt-in

A fully automatic floating major tag is a contract that the maintainer
silently signs every patch. RepoKernel's GitHub Action installs
`repokernel` from npm at runtime, so the action.yml shape rarely
changes — but the moment it does (new input default, additional
required input, behavior change), pinned `@v1` consumers get implicit
upgrades with no release window. Making the advance opt-in turns it
into a deliberate "this is backwards-compatible" attestation.
