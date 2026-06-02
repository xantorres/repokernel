---
name: repokernel-operator
description: Compatibility pointer for the current bundled RepoKernel operator skill.
---

# RepoKernel Operator

This example is intentionally thin. The maintained operator skill now ships in
`packages/cli/plugin/skills/repokernel/SKILL.md`, and `rk install-skill`
installs that plugin plus its slash commands and hooks.

## Use The Bundled Skill

```bash
npm i -g repokernel
rk install-skill
rk install-skill --dry-run
```

For IDE rule targets:

```bash
rk install-skill --ide cursor --project
rk install-skill --ide windsurf --project
rk install-skill --ide copilot --project
rk install-skill --ide gemini --project
rk install-skill --ide opencode --project
```

## Operator Verbs

| Intent | Slash |
|---|---|
| Plan new work | `/rk-plan` |
| Read project state | `/rk-status` |
| Resolve next runnable work | `/rk-next` |
| Execute sprint, epic, or fastpath work | `/rk-run` |
| Review a sprint | `/rk-review` |
| Diagnose drift | `/rk-doctor` |
| Record out-of-scope decisions | `/rk-reject` |

## Quick CLI Reference

```bash
rk status --brief --json
rk preflight --json
rk next --json
rk run <ID>
rk review <S-NNN>
rk gates <S-NNN>
rk ship <S-NNN>
rk wave plan [SELECTOR] --json
rk queue remove <S-NNN> --lane <name> --cascade-dependents
rk review-evidence <S-NNN> --label focused-tests --command "pnpm test"
```

Use `packages/cli/plugin/skills/repokernel/reference/cheatsheet.md` for the
complete current command map.

## CI Gate

```yaml
- uses: xantorres/repokernel/.github/actions/rk-validate@v1.32.0
  with:
    fail-on: P0,P1
    version: 1.32.0
```

Pin the action ref and npm package version together for reproducible CI.
