import type { Config } from './schema.js';

/**
 * Canonical set of repository paths that RepoKernel manages on behalf of the
 * caller. Every site that needs to "stage all RK-touched files" or "verify the
 * RK surface exists" should derive its path list from this function rather than
 * hardcoding `.repokernel/` or open-coding a subset of `config.paths.*`.
 *
 * The triple `all` / `worktreeStaged` / `mainStaged` lets callers express
 * intent without re-deriving which subset matters for which transactional
 * boundary:
 *   - `all`           — every defined RK path (e.g. for init scaffolding,
 *                        smoke audits, validate gating).
 *   - `worktreeStaged` — paths that may be dirty inside a fastpath worktree
 *                        before the close-merge folds it back into main.
 *   - `mainStaged`    — paths the post-merge close commit may need to stage
 *                        on the main checkout (sprint→shipped, queue cleanup,
 *                        review end_sha capture, registry refresh, alias
 *                        terminal-state mutation).
 *
 * Order is canonical (`epics, sprints, reviews, queues, lanes, decisions,
 * next, generated, registry`) so callers can compare snapshots stably.
 */
export interface MaterialPaths {
  readonly epics: string;
  readonly sprints: string;
  readonly reviews: string;
  readonly queues: string;
  readonly lanes: string;
  readonly decisions: string | null;
  readonly next: string | null;
  readonly generated: string;
  readonly registry: string;
  readonly all: readonly string[];
  readonly worktreeStaged: readonly string[];
  readonly mainStaged: readonly string[];
}

export function materialPaths(config: Config): MaterialPaths {
  const p = config.paths;
  const decisions = p.decisions ?? null;
  const next = p.next ?? null;

  const all: string[] = [
    p.epics,
    p.sprints,
    p.reviews,
    p.queues,
    p.lanes,
    ...(decisions ? [decisions] : []),
    ...(next ? [next] : []),
    p.generated,
    p.registry,
  ];

  const worktreeStaged: string[] = dedupe([
    p.sprints,
    p.reviews,
    p.queues,
    ...(decisions ? [decisions] : []),
    ...(next ? [next] : []),
    p.registry,
    p.generated,
  ]);

  const mainStaged: string[] = dedupe([p.sprints, p.reviews, p.queues, p.registry, p.generated]);

  return {
    epics: p.epics,
    sprints: p.sprints,
    reviews: p.reviews,
    queues: p.queues,
    lanes: p.lanes,
    decisions,
    next,
    generated: p.generated,
    registry: p.registry,
    all: dedupe(all),
    worktreeStaged,
    mainStaged,
  };
}

/**
 * Every repository location RepoKernel manages as machine-written state:
 * epics, sprints, reviews, queues, lanes, optional decisions/next, the
 * generated directory, and the single-file registry.
 *
 * Distinct from `materialPaths().all`: this export exists for *path matching*
 * (exempting RK-owned files from a sprint diff-scope gate) rather than for
 * staging snapshots. Keeping match-intent in its own export lets it be tested
 * independently of the transactional-boundary semantics of `all`.
 *
 * Entries are bare directory roots (plus the registry file). `matchesAnyPathPattern`
 * treats a non-glob string as a directory prefix, so no trailing-glob suffix
 * is required for these to match nested files.
 */
export function materialPathGlobs(config: Config): readonly string[] {
  const p = config.paths;
  return dedupe([
    p.epics,
    p.sprints,
    p.reviews,
    p.queues,
    p.lanes,
    ...(p.decisions ? [p.decisions] : []),
    ...(p.next ? [p.next] : []),
    p.generated,
    p.registry,
  ]);
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
