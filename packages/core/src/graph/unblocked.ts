import type { Sprint } from '../schemas/sprint.js';
import type { Graph } from './types.js';

/**
 * Returns sprints in `planned` status that became runnable (all deps shipped)
 * specifically because `justClosed` was just shipped. A sprint is included only
 * if it lists `justClosed` as a dependency AND every other dep is already
 * shipped — sprints that were already unblocked before this close are excluded.
 *
 * Used by `rk close` to surface "newly unblocked" sprints so agents don't have
 * to grep NEXT.md or the dep graph to discover what to enqueue next.
 */
export function findNewlyUnblockedSprints(graph: Graph, justClosed: string): Sprint[] {
  const out: Sprint[] = [];
  for (const sprint of graph.sprints.values()) {
    if (sprint.status !== 'planned') continue;
    if (!sprint.depends_on.includes(justClosed)) continue;
    const allShipped = sprint.depends_on.every((depId) => {
      if (depId === justClosed) return true;
      return graph.sprints.get(depId)?.status === 'shipped';
    });
    if (allShipped) out.push(sprint);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
