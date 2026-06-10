import type { SprintId } from '../schemas/ids.js';
import type { Sprint } from '../schemas/sprint.js';

/**
 * Set of sprint IDs whose state satisfies a downstream dependency edge.
 * Canonical rule: only `shipped` upstream sprints satisfy a downstream
 * `depends_on` or `blocked_by` reference. `cancelled` upstream is treated
 * as a soft block — downstream stays blocked until a human cancels or
 * re-targets it. This is intentionally conservative: a soft block is
 * safer than a soft pass, especially for `depends_on` edges where the
 * upstream sprint's output may genuinely be required.
 */
export type SatisfiedSprints = ReadonlySet<SprintId>;

/**
 * Build the canonical satisfied-sprint set from a graph snapshot.
 * Used as the seed input to `isDependencyMet` / `unmetDependencies`.
 */
export function buildSatisfiedSprints(
  sprints: Iterable<Pick<Sprint, 'id' | 'status'>>,
): Set<SprintId> {
  const set = new Set<SprintId>();
  for (const sprint of sprints) {
    if (sprint.status === 'shipped') set.add(sprint.id);
  }
  return set;
}

/**
 * Combined dependency edges that gate execution: depends_on + blocked_by.
 * Both edge types must be satisfied before a sprint is runnable. Until
 * we wired this helper in, `blocked_by` was validated for refs/cycles
 * but never enforced at execution time.
 */
export function gatingDependencies(
  sprint: Pick<Sprint, 'depends_on' | 'blocked_by'>,
): readonly SprintId[] {
  return [...sprint.depends_on, ...sprint.blocked_by] as readonly SprintId[];
}

/**
 * Returns the unmet gating dependency IDs for a sprint, given the
 * current satisfied set. The order is `depends_on` first, then
 * `blocked_by`, both preserving sprint-defined order, with duplicates
 * collapsed. An empty result means the sprint is dependency-clear.
 */
export function unmetDependencies(
  sprint: Pick<Sprint, 'depends_on' | 'blocked_by'>,
  satisfied: SatisfiedSprints,
): SprintId[] {
  const seen = new Set<SprintId>();
  const out: SprintId[] = [];
  for (const dep of gatingDependencies(sprint)) {
    if (satisfied.has(dep)) continue;
    if (seen.has(dep)) continue;
    seen.add(dep);
    out.push(dep);
  }
  return out;
}

/**
 * True iff every gating dependency of the sprint is in the satisfied set.
 */
export function isDependencyMet(
  sprint: Pick<Sprint, 'depends_on' | 'blocked_by'>,
  satisfied: SatisfiedSprints,
): boolean {
  return unmetDependencies(sprint, satisfied).length === 0;
}
