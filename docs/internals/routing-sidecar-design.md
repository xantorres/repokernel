# Routing sidecar — design (deferred to 1.16.0)

Long-form design for promoting `extras.routing` out of sprint frontmatter
into a dedicated sidecar file. **Implementation deferred to 1.16.0**;
this document captures the design and migration path so 1.15.0 callers
know what they're working against.

## Problem

Sprint frontmatter is becoming a god-object. As of 1.14.x, a single
sprint markdown file's `---` block carries:

- Identity: `id`, `title`, `epic_id`, `lane`, `status`, `started_at`,
  `closed_at`, `cancelled_at`, `review_id`, `base_sha`, `merge_sha`.
- Scope: `depends_on`, `allowed_paths`, `denied_paths`, `quality_rules`.
- Operator-meaningful extras: `extras.routing.{complexity, prefer_tier,
  pin_tier, fanout}`, `extras.tracker_*`, `extras.pr_*`, `extras.task_id`,
  `extras.fastpath`, plus arbitrary user-extension keys.

This is fine when each block is small and orthogonal; it gets fragile as
each new feature plants its own keys under `extras`. The two concrete
costs already showing up:

1. **Schema evolution per feature is coupled to the sprint shape.**
   Adding a routing field forces the whole sprint frontmatter parser to
   re-validate, even though routing is structurally independent.
2. **Lock contention.** `mutateSprintExtras` serializes ALL extras
   mutations through one lock per file because tracker/PR/routing share
   the object — a tracker comment landing while a routing edit is in
   flight has to wait, even though they don't touch the same keys.

## Proposed shape

A dedicated sidecar per sprint:

```
.repokernel/
├── routing/
│   ├── S-001.json    # { schemaVersion: 1, complexity: "deep", pin_tier: "heavy", ... }
│   ├── S-002.json
│   └── ...
└── ...
```

Sprint frontmatter no longer carries `extras.routing`. The routing CLI
(`rk sprint routing set/clear`) reads/writes `.repokernel/routing/<id>.json`
exclusively. `loadProject` joins routing files into the sprint graph at
parse time so existing graph consumers see the same shape they always did.

## Interface

```ts
// packages/cli/src/integrations/routingMetadata.ts (already exists in 1.15.0)
// In 1.16.0 the implementation switches from frontmatter mutation to
// sidecar file mutation. The signature is unchanged.
export async function mutateSprintRouting(
  sprintFile: string,
  opRoot: string,
  update: (current: Routing | null) => Routing | null,
): Promise<{ prior: Routing | null; next: Routing | null }>;
```

## Migration

`rk migrate routing-to-sidecar` (a one-shot CLI verb introduced in 1.16.0):

1. Walk every sprint markdown.
2. If frontmatter has `extras.routing`, read it.
3. Write `.repokernel/routing/<sprint-id>.json` with the contents.
4. Strip `extras.routing` from the sprint frontmatter.
5. Add the sidecar file to git, stage the sprint file edit.
6. Operator commits with a single message: "chore: migrate routing to sidecar".

For the deprecation cycle (1.16.x), `loadProject` reads BOTH locations
and surfaces a finding (`F_ROUTING_LEGACY_LOCATION`) when frontmatter
still carries `extras.routing`. `rk fix --apply --yes` auto-migrates.

## Backward compatibility

| Version | Reads frontmatter | Reads sidecar | Writes sidecar | Notes                                    |
|---------|-------------------|---------------|----------------|------------------------------------------|
| 1.15.x  | Yes               | No            | No             | All routing in frontmatter.              |
| 1.16.0  | Yes (legacy)      | Yes           | Yes            | New writes go to sidecar; reads honor both. Migration verb available. |
| 1.17.0  | No                | Yes           | Yes            | Frontmatter routing is rejected as a finding; auto-fix migrates.       |
| 1.18.0  | No                | Yes           | Yes            | Auto-fix removed; users must run migration before upgrading.           |

## Why not multiple sidecars per concern

The same argument generalises (tracker → `tracker/<id>.json`, PR →
`pr/<id>.json`, etc.). The principle is sound but the cost of doing it
all at once is high — this proposal scopes to routing, treats it as the
template for future migrations, and lets each concern pick its own
moment. If routing-as-sidecar lands cleanly in 1.16.0 and feels good in
practice, tracker fields move next.

## Why JSON, not YAML

Sidecars are machine-owned. JSON is unambiguous, has no indentation
sensitivity, parses faster, and `canonicalJson` already exists in the
codebase. Sprint markdown stays YAML because it's human-edited.

## What this enables

- **Per-feature schema evolution.** A new routing field changes the
  sidecar schema only; sprint frontmatter is untouched.
- **Independent locks.** `mutateSprintRouting` locks routing files;
  `mutateSprintExtras` (renamed appropriately) locks the rest.
  Concurrent tracker/routing edits proceed in parallel.
- **Cleaner test surface.** Routing tests no longer need to assert
  surrounding frontmatter is preserved — there's no surrounding
  frontmatter.
- **Grep-able audit.** `git log -p .repokernel/routing/` shows every
  routing change without sprint-file noise.

## What this complicates

- **One more file per sprint.** Cosmetic; offset by the cleaner shape.
- **Migration costs (one-time).** The 1.16.x → 1.18.x deprecation cycle
  is the cost. Worth paying now while RepoKernel has few external
  adopters; cost grows with adoption.
- **Backup discipline.** Operators who copy "the sprint file" must now
  also copy the sidecar. Document loudly.
