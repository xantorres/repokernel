import type { Sprint } from '../schemas/sprint.js';
import type { Graph } from './types.js';

/**
 * Walk the transitive dependent closure of `rootSprintId`: every sprint that
 * depends_on it (directly or transitively), restricted to sprints currently
 * in a queueable status (queued, planned, pending). Returns sprints in
 * lexicographic id order for determinism.
 *
 * Used by `rk queue remove --cascade-dependents` to enumerate the sprints
 * that would be orphaned by a queue removal and roll them back in the same
 * transaction. `cancelled` and `shipped` dependents are excluded: a
 * cancelled sprint stops blocking anything, and a shipped sprint has
 * nothing to remove.
 */
export function transitiveDependents(graph: Graph, rootSprintId: string): readonly Sprint[] {
  const visited = new Set<string>();
  const queue: string[] = [rootSprintId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const sprint of graph.sprints.values()) {
      if (visited.has(sprint.id)) continue;
      if (!sprint.depends_on.includes(current) && !sprint.blocked_by.includes(current)) continue;
      queue.push(sprint.id);
    }
  }
  visited.delete(rootSprintId);
  const eligibleStatuses = new Set(['queued', 'planned', 'pending']);
  const result: Sprint[] = [];
  for (const id of visited) {
    const sprint = graph.sprints.get(id);
    if (sprint && eligibleStatuses.has(sprint.status)) result.push(sprint);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
