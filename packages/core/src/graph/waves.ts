import type { EpicId, SprintId } from '../schemas/ids.js';
import type { Sprint } from '../schemas/sprint.js';
import { gatingDependencies, isDependencyMet, unmetDependencies } from './readiness.js';
import type { Graph, Wave, WavePreview, WavePreviewBlocked } from './types.js';

/**
 * Compute executable dependency waves for a parallel epic.
 *
 * Algorithm:
 * 1. Collect queued sprints belonging to the epic, in epic.sprints canonical order.
 * 2. Iteratively extract the "ready" set: sprints whose depends_on are all in `shipped`.
 *    Gated sprints (sprint.gate is set) are never ready.
 * 3. Sort each natural wave by sprint ID for determinism.
 * 4. Chunk each natural wave into sub-waves of at most `limit` sprints.
 *
 * Returns an empty array when no queued sprints exist or all are blocked/gated.
 */
export function buildExecutionWaves(
  graph: Graph,
  epicId: EpicId,
  shipped: ReadonlySet<SprintId>,
  limit: number,
  options: { readonly lane?: string } = {},
): Wave[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`wave limit must be a positive safe integer (got ${String(limit)})`);
  }

  const epic = graph.epics.get(epicId);
  if (!epic) return [];

  // Collect queued sprints in queue order when lane-scoped, otherwise epic canonical order.
  const candidates: Sprint[] = [];
  const canonicalSprintIds = graph.sprintsByEpic?.get(epicId) ?? epic.sprints;
  const orderedSprintIds =
    options.lane !== undefined
      ? (graph.queuesByLane.get(options.lane) ?? []).map((slot) => slot.sprint_id)
      : canonicalSprintIds;
  const epicSprintIds = new Set(canonicalSprintIds);
  for (const sid of orderedSprintIds) {
    if (!epicSprintIds.has(sid)) continue;
    const sprint = graph.sprints.get(sid);
    if (sprint?.status === 'queued') candidates.push(sprint);
  }

  // Build queue order map — used to preserve slot priority within lane-scoped waves.
  const queueOrder = new Map<SprintId, number>();
  for (let i = 0; i < orderedSprintIds.length; i++) {
    queueOrder.set(orderedSprintIds[i]!, i);
  }

  // Build natural dependency waves (unlimited)
  const naturalWaves: Sprint[][] = [];
  const willBeShipped = new Set(shipped);
  let remaining = candidates;

  while (remaining.length > 0) {
    const wave: Sprint[] = [];
    const notReady: Sprint[] = [];

    for (const sprint of remaining) {
      if (sprint.gate) {
        notReady.push(sprint);
        continue;
      }
      if (isDependencyMet(sprint, willBeShipped)) {
        wave.push(sprint);
      } else {
        notReady.push(sprint);
      }
    }

    if (wave.length === 0) break; // all remaining are gated or have unsatisfied deps

    if (options.lane !== undefined) {
      wave.sort((a, b) => {
        const ao = queueOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bo = queueOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ao - bo || a.id.localeCompare(b.id);
      });
    } else {
      wave.sort((a, b) => a.id.localeCompare(b.id));
    }
    naturalWaves.push(wave);
    for (const s of wave) willBeShipped.add(s.id);
    remaining = notReady;
  }

  // Chunk each natural wave into sub-waves by limit
  const result: Wave[] = [];
  let waveIndex = 0;
  for (const nw of naturalWaves) {
    for (let i = 0; i < nw.length; i += limit) {
      const chunk = nw.slice(i, i + limit);
      result.push({
        index: waveIndex++,
        sprints: chunk,
        canParallelize: chunk.length > 1,
      });
    }
  }
  return result;
}

/**
 * Build a full wave preview for display commands (rk chain preview, rk epic map).
 *
 * Like buildExecutionWaves but includes blocked/gated/planned sprints for visibility.
 * Does not apply a limit — intended for human-readable preview only.
 */
export function buildWavePreview(
  graph: Graph,
  epicId: EpicId,
  shipped: ReadonlySet<SprintId>,
): WavePreview[] {
  const epic = graph.epics.get(epicId);
  if (!epic) return [];

  const planned: Sprint[] = [];
  const queued: Sprint[] = [];

  const canonicalSprintIds = graph.sprintsByEpic?.get(epicId) ?? epic.sprints;
  for (const sid of canonicalSprintIds) {
    const sprint = graph.sprints.get(sid);
    if (!sprint) continue;
    if (sprint.status === 'queued') {
      queued.push(sprint);
    } else if (sprint.status === 'planned' || sprint.status === 'pending') {
      planned.push(sprint);
    }
  }

  planned.sort((a, b) => a.id.localeCompare(b.id));

  const result: WavePreview[] = [];
  const willBeShipped = new Set(shipped);
  let remaining = queued;
  let waveIndex = 0;

  while (remaining.length > 0) {
    const wave: Sprint[] = [];
    const blocked: WavePreviewBlocked[] = [];
    const gated: Sprint[] = [];
    const notReady: Sprint[] = [];

    for (const sprint of remaining) {
      if (sprint.gate) {
        gated.push(sprint);
        notReady.push(sprint);
        continue;
      }
      const unmet = unmetDependencies(sprint, willBeShipped);
      if (unmet.length > 0) {
        blocked.push({
          sprint,
          reason: dependencyBlockReason(sprint, unmet),
        });
        notReady.push(sprint);
      } else {
        wave.push(sprint);
      }
    }

    if (wave.length === 0) {
      // All remaining are blocked/gated — terminal preview entry
      result.push({
        index: waveIndex++,
        sprints: [],
        canParallelize: false,
        blocked,
        gated,
        planned,
      });
      break;
    }

    wave.sort((a, b) => a.id.localeCompare(b.id));
    result.push({
      index: waveIndex++,
      sprints: wave,
      canParallelize: wave.length > 1,
      blocked,
      gated,
      planned: [],
    });
    for (const s of wave) willBeShipped.add(s.id);
    remaining = notReady;
  }

  // If nothing was queued but there are planned sprints, surface them
  if (result.length === 0 && planned.length > 0) {
    result.push({
      index: 0,
      sprints: [],
      canParallelize: false,
      blocked: [],
      gated: [],
      planned,
    });
  } else if (result.length > 0 && planned.length > 0) {
    // Append planned to the last wave (they have nowhere else to go)
    const last = result[result.length - 1]!;
    const merged = [...last.planned, ...planned].sort((a, b) => a.id.localeCompare(b.id));
    result[result.length - 1] = { ...last, planned: merged };
  }

  return result;
}

function dependencyBlockReason(
  sprint: Pick<Sprint, 'depends_on' | 'blocked_by'>,
  unmet: readonly SprintId[],
): string {
  const dependsOnUnmet = unmet.filter((id) => sprint.depends_on.includes(id));
  const blockedByUnmet = unmet.filter(
    (id) => sprint.blocked_by.includes(id) && !sprint.depends_on.includes(id),
  );
  const parts: string[] = [];
  if (dependsOnUnmet.length > 0) parts.push(`depends on unshipped: ${dependsOnUnmet.join(', ')}`);
  if (blockedByUnmet.length > 0) parts.push(`blocked by: ${blockedByUnmet.join(', ')}`);
  return parts.join('; ');
}

// Re-export for downstream consumers that previously read graph.dependsOn.
export { gatingDependencies };
