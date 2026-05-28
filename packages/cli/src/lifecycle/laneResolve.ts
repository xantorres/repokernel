import type { Config, Graph } from '@repokernel/core';

export type LaneRequest = 'named' | 'auto' | 'default';

export interface LaneResolution {
  readonly lane: string;
  readonly requested: LaneRequest;
  /** `auto` was requested but no free lane existed, so the default lane was used. */
  readonly fellBackToDefault: boolean;
}

/** Lane names known to the graph: lane files, queue lanes, and sprint lanes. */
export function laneNamesOf(graph: Graph): readonly string[] {
  const names = new Set<string>([
    ...graph.lanes.keys(),
    ...graph.queuesByLane.keys(),
    ...[...graph.sprints.values()].map((sprint) => sprint.lane),
  ]);
  return [...names].sort();
}

/**
 * Lanes that currently hold an `active` sprint. "Free" everywhere in rk means
 * "no active sprint" (see the `lanes_free` brief metric); a lane absent from
 * this set is free for placement.
 */
export function activeLanesOf(graph: Graph): ReadonlySet<string> {
  const active = new Set<string>();
  for (const sprint of graph.sprints.values()) {
    if (sprint.status === 'active') active.add(sprint.lane);
  }
  return active;
}

/**
 * Pure auto-lane picker. Prefers the default lane when it is free so `auto`
 * only diverges from current behavior when the default lane is busy — which is
 * the case `auto` exists to handle. Otherwise picks the first free lane
 * (sorted, for determinism), and finally falls back to the default lane when
 * every known lane is occupied. The boolean reports that last fallback so the
 * caller can warn the operator that placement landed on a busy lane.
 */
export function pickAutoLane(
  laneNames: readonly string[],
  activeLanes: ReadonlySet<string>,
  defaultLane: string,
): { readonly lane: string; readonly fellBackToDefault: boolean } {
  if (!activeLanes.has(defaultLane)) {
    return { lane: defaultLane, fellBackToDefault: false };
  }
  const free = laneNames.find((lane) => !activeLanes.has(lane));
  if (free !== undefined) {
    return { lane: free, fellBackToDefault: false };
  }
  return { lane: defaultLane, fellBackToDefault: true };
}

/**
 * Resolve the lane for a hotfix-style placement.
 *   undefined → default lane (current behavior, non-breaking)
 *   "auto"    → first free lane, else default (with fellBackToDefault: true)
 *   any other → that named lane verbatim
 */
export function resolveHotfixLane(
  graph: Graph,
  config: Config,
  laneOpt: string | undefined,
): LaneResolution {
  const defaultLane = config.policies.defaultLane;
  if (laneOpt === undefined) {
    return { lane: defaultLane, requested: 'default', fellBackToDefault: false };
  }
  if (laneOpt === 'auto') {
    const picked = pickAutoLane(laneNamesOf(graph), activeLanesOf(graph), defaultLane);
    return { lane: picked.lane, requested: 'auto', fellBackToDefault: picked.fellBackToDefault };
  }
  return { lane: laneOpt, requested: 'named', fellBackToDefault: false };
}
