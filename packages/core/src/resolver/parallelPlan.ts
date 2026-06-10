import type { Graph } from '../graph/types.js';
import type { Sprint } from '../schemas/sprint.js';

export interface ParallelWaveEntry {
  readonly sprint_id: string;
  readonly allowed_paths: readonly string[];
}

export interface ParallelWave {
  readonly index: number;
  readonly entries: readonly ParallelWaveEntry[];
}

export interface ParallelPlan {
  readonly waves: readonly ParallelWave[];
  /** Sprints that were skipped (cycle root, missing deps, etc.). */
  readonly skipped: ReadonlyArray<{ sprint_id: string; reason: string }>;
}

export interface ParallelPlanOptions {
  /** Subset of sprints to plan over. Defaults to every queued sprint. */
  readonly sprintIds?: readonly string[];
  /**
   * When true, treat overlapping `allowed_paths` as the only blocker for
   * grouping into the same wave. When false (default), also gate on
   * dependency ordering — a sprint that depends_on another sprint in the
   * same wave is split to the next wave.
   */
  readonly ignoreDependencies?: boolean;
}

/**
 * Group sprints into waves where (a) no sprint in a wave depends on another
 * sprint in the same wave, and (b) no two sprints in a wave have overlapping
 * `allowed_paths`. The result is a deterministic sequence of waves: any
 * agent that runs each wave's sprints in parallel will not race against
 * itself on paths or dependencies.
 *
 * Algorithm: greedy scheduling with a stable sort by sprint id.
 *
 *   1. Build the candidate set (defaults to every queued sprint, or
 *      `sprintIds`-filtered when provided).
 *   2. Sort by sprint id for determinism.
 *   3. While there are sprints left to schedule, build a new wave:
 *      iterate candidates; admit each one whose deps are either shipped or
 *      scheduled in a *previous* wave AND whose `allowed_paths` are
 *      disjoint from every sprint already admitted to this wave.
 *   4. If a full pass produces no admissions, declare the rest blocked and
 *      report them in `skipped` with a reason.
 *
 * Path overlap is a string prefix check that mirrors `matchesAnyPathPattern`
 * semantics: a glob like `apps/web/**` is considered to overlap with
 * `apps/web/page.tsx` because either could write into the shared subtree.
 * The check is intentionally conservative — false-positives split a wave
 * unnecessarily (cost: more waves), false-negatives let two agents clobber
 * each other (cost: corruption). We pick the safer side.
 */
export function planParallelWaves(graph: Graph, opts: ParallelPlanOptions = {}): ParallelPlan {
  const allSprints = [...graph.sprints.values()];
  const { sprintIds } = opts;
  const universe = sprintIds
    ? allSprints.filter((s) => sprintIds.includes(s.id))
    : allSprints.filter((s) => s.status === 'queued' || s.status === 'planned');
  const candidates: Sprint[] = [...universe].sort((a, b) => a.id.localeCompare(b.id));

  const waves: ParallelWave[] = [];
  const skipped: Array<{ sprint_id: string; reason: string }> = [];
  const scheduled = new Set<string>();
  const shippedOrCancelled = new Set(
    allSprints.filter((s) => s.status === 'shipped' || s.status === 'cancelled').map((s) => s.id),
  );

  /**
   * Snapshot of `scheduled` at the start of the current wave. A sprint
   * whose dep ships in the same wave is NOT ready — it must wait for the
   * next wave (deps must be in a STRICTLY PRIOR wave). Without this
   * snapshot, the loop would happily place dep + dependent in the same
   * wave for parallel execution, which is exactly wrong.
   */
  let scheduledBeforeWave = new Set<string>();
  const dependencyReady = (sprint: Sprint): boolean => {
    if (opts.ignoreDependencies === true) return true;
    return [...sprint.depends_on, ...sprint.blocked_by].every(
      (depId) => shippedOrCancelled.has(depId) || scheduledBeforeWave.has(depId),
    );
  };

  while (candidates.length > 0) {
    scheduledBeforeWave = new Set(scheduled);
    const wave: ParallelWaveEntry[] = [];
    const waveStarted = scheduled.size;
    const remaining: Sprint[] = [];
    for (const sprint of candidates) {
      if (!dependencyReady(sprint)) {
        remaining.push(sprint);
        continue;
      }
      const overlaps = wave.some((entry) =>
        pathsOverlap(entry.allowed_paths, sprint.allowed_paths),
      );
      if (overlaps) {
        remaining.push(sprint);
        continue;
      }
      wave.push({ sprint_id: sprint.id, allowed_paths: [...sprint.allowed_paths] });
      scheduled.add(sprint.id);
    }
    if (scheduled.size === waveStarted) {
      // No progress this pass: every remaining sprint is blocked. Record
      // them and stop — running the loop again would not change anything.
      for (const sprint of remaining) {
        const unmet = [...sprint.depends_on, ...sprint.blocked_by].filter(
          (depId) => !shippedOrCancelled.has(depId) && !scheduled.has(depId),
        );
        skipped.push({
          sprint_id: sprint.id,
          reason:
            unmet.length > 0
              ? `unmet dependencies: ${unmet.join(', ')}`
              : 'cycle or path-overlap chain prevents scheduling',
        });
      }
      break;
    }
    waves.push({ index: waves.length + 1, entries: wave });
    candidates.length = 0;
    candidates.push(...remaining);
  }

  return { waves, skipped };
}

/**
 * Conservative path-overlap predicate. Two path sets overlap when ANY pair
 * (a from set A, b from set B) share a common subtree. A path with no glob
 * is treated as a prefix; a glob like `apps/web/**` is treated as the
 * directory `apps/web`. The function is symmetric and intentionally
 * conservative (favors splitting waves over data races).
 */
function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    // An empty allowed_paths means "anywhere" — overlaps with everything.
    return true;
  }
  for (const x of a) {
    const xRoot = stripGlobTail(x);
    for (const y of b) {
      const yRoot = stripGlobTail(y);
      if (xRoot === yRoot) return true;
      if (xRoot.startsWith(`${yRoot}/`)) return true;
      if (yRoot.startsWith(`${xRoot}/`)) return true;
    }
  }
  return false;
}

function stripGlobTail(p: string): string {
  // Cut at the first glob meta-character so `apps/web/**` → `apps/web`,
  // `apps/{web,server}/**` → `apps`. Keep trailing slashes off so the
  // prefix check above behaves consistently.
  const idx = p.search(/[*?{[]/u);
  const head = idx === -1 ? p : p.slice(0, idx);
  return head.replace(/\/$/, '');
}
