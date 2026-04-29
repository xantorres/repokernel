# Recipes

Long-form, opinionated walkthroughs of patterns that build on top of RepoKernel without being shipped as part of the CLI itself.

RepoKernel is a state machine plus a CLI. By design, it does **not** ship project-specific orchestration content (multi-agent panels, founder-action briefs, chained-epic spawn loops). Those concerns belong to your project's own `.agents/protocol/` + `.claude/commands/` layer. The recipes below describe canonical patterns for building that layer cleanly on top of `rk`.

## Available recipes

| Recipe | What it covers |
|---|---|
| [Protocol layer](./protocol-layer.md) | The two-layer `commands + protocols` pattern: how slash-commands route through Claude Code's model tiers into project-owned orchestration prose, with worked examples for close-sprint and chained-epic. |

## When to write a recipe

A recipe earns its place when:
- The pattern is reused across **several** RepoKernel-governed projects.
- The pattern cannot be merged into the operator skill without making it project-specific.
- The pattern depends on **rk primitives** but adds project-side judgment on top (orchestration, prompts, briefs, gates).

If the pattern is generic enough to belong to every rk consumer, it probably belongs in the operator skill, not here.
