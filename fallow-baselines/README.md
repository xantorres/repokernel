# Fallow Baselines

These files are the current quality debt snapshot for the new-only gate.

Current debt:

- Dead-code findings: 141
- Health findings: 718 across 188 files
- Duplicate clone groups: 16

Refresh with:

```bash
pnpm quality:baseline
```

Guardrails:

- Baselines may shrink in ordinary PRs.
- Baseline growth needs a deliberate protected refresh and reviewer approval.
- CI compares PR baselines against the base branch, so branch-local baseline edits cannot hide new findings.
- Keep the Fallow version pinned when refreshing; analyzer drift changes fingerprints and counts.
