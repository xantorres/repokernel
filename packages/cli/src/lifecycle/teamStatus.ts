import type { Registry, Run, TeamStatus, TeamStatusRun, TeamStatusSprint } from '@repokernel/core';
import { listRunsWithCorruption } from './runState.js';

/**
 * Compose a TeamStatus snapshot from the on-disk runs and an
 * already-generated registry.
 *
 * The registry is the source of truth for declared project state; the
 * run files are the source of truth for runtime state. This function is
 * the single place that joins them — keeping the join logic out of the
 * CLI command makes the command a thin orchestrator and lets tests pin
 * the join behaviour without spinning up a real project.
 *
 * The function is async-but-pure-ish: the only IO is the run-file scan.
 * Callers that already have the runs in memory can use the lower-level
 * `composeTeamStatus` instead.
 */
export interface TeamStatusInput {
  readonly opRoot: string;
  readonly registry: Registry;
  readonly now?: () => Date;
  /**
   * Optional filter — when set, only the matching sprint is returned in
   * the `sprints` array. The `runs` array is unaffected.
   */
  readonly sprintId?: string;
}

const ESTIMATED_RUN_DURATION_MS = 60 * 60 * 1000;

function activeSprintIds(run: Run): readonly string[] {
  if (run.active_sprints.length > 0) return run.active_sprints;
  return run.current_sprint ? [run.current_sprint] : [];
}

function progressString(run: Run): string {
  // sprint_count is incremented every time a sprint completes (see
  // run.ts:782 — `sprint_count: run.sprint_count + 1`). It is therefore
  // the count of completed sprints, NOT a planning denominator. Without
  // a `run.limit`, the only honest progress we can report is the count
  // of completions; "%" is meaningless. Use limit when present and the
  // raw count otherwise.
  if (run.limit !== null && run.limit > 0) {
    const pct = Math.min(100, Math.round((run.completed_sprints.length / run.limit) * 100));
    return `${pct}%`;
  }
  return `${run.completed_sprints.length} sprint(s)`;
}

function computeRunEta(run: Run, now: Date): string | null {
  if (run.status === 'completed' || run.status === 'aborted' || run.status === 'failed') {
    return run.ended_at;
  }
  const startedMs = Date.parse(run.started_at);
  if (Number.isNaN(startedMs)) return null;
  const elapsed = now.getTime() - startedMs;
  const completed = run.completed_sprints.length;
  const inflight = Math.max(activeSprintIds(run).length, 1);
  const remaining = run.limit !== null && run.limit > completed ? run.limit - completed : inflight;
  const perSprint = completed > 0 ? elapsed / completed : ESTIMATED_RUN_DURATION_MS;
  const eta = now.getTime() + perSprint * remaining;
  return new Date(eta).toISOString();
}

function summarizeRunStates(run: Run, registry: Registry): TeamStatusRun['states'] {
  const states = { ready: 0, active: 0, review: 0, merging: 0 };
  const sprintIds = new Set([
    ...run.active_sprints,
    ...(run.current_sprint ? [run.current_sprint] : []),
  ]);
  for (const id of sprintIds) {
    const sprint = registry.sprints.find((s) => s.id === id);
    if (!sprint) continue;
    if (sprint.status === 'queued' || sprint.status === 'pending') states.ready++;
    if (sprint.status === 'active') states.active++;
    if (sprint.status === 'review') states.review++;
  }
  if (run.pending_wave?.status === 'merging') states.merging = 1;
  return states;
}

function computeRegistryHealth(registry: Registry): {
  ready_to_merge: boolean;
  health: 'OK' | 'BLOCKED' | 'DEGRADED';
} {
  if (registry.health.blocked) {
    return { ready_to_merge: false, health: 'BLOCKED' };
  }
  if (registry.health.findingCounts.P1 > 0) {
    return { ready_to_merge: false, health: 'DEGRADED' };
  }
  return { ready_to_merge: true, health: 'OK' };
}

function bottleneckLines(registry: Registry, runs: readonly Run[]): string[] {
  const lines: string[] = [];

  // Lane saturation: more than one running run per epic surfaces as a
  // bottleneck because the next sprint cannot start until the wave
  // settles. The map is read here, not just built.
  const inflightRunsByEpic = new Map<string, number>();
  for (const run of runs) {
    if (run.status !== 'running') continue;
    inflightRunsByEpic.set(run.epic_id, (inflightRunsByEpic.get(run.epic_id) ?? 0) + 1);
  }
  for (const [epicId, count] of inflightRunsByEpic) {
    if (count > 1) {
      lines.push(`${epicId}: ${count} concurrent runs (lane saturated)`);
    }
  }

  for (const sprint of registry.sprints) {
    if (sprint.status === 'review') {
      lines.push(`${sprint.id}: awaiting_review`);
    } else if (sprint.blocked_by.length > 0) {
      lines.push(`${sprint.id}: blocked_by ${sprint.blocked_by.join(',')}`);
    }
  }
  return lines;
}

/**
 * Pure compose function — useful for tests that already have the run
 * list in memory and want to avoid a filesystem round-trip.
 */
export function composeTeamStatus(args: {
  readonly registry: Registry;
  readonly runs: readonly Run[];
  readonly now?: Date;
  readonly sprintId?: string;
}): TeamStatus {
  const now = args.now ?? new Date();
  const registry = args.registry;
  const runs = args.runs;

  const teamRuns: TeamStatusRun[] = runs.map((run) => ({
    run_id: run.id,
    epic_id: run.epic_id,
    status: run.status,
    active_sprints: activeSprintIds(run).length,
    states: summarizeRunStates(run, registry),
    started_at: run.started_at,
    ended_at: run.ended_at,
    eta: computeRunEta(run, now),
  }));

  const sprintToRunId = new Map<string, string>();
  for (const run of runs) {
    for (const id of activeSprintIds(run)) {
      if (!sprintToRunId.has(id)) sprintToRunId.set(id, run.id);
    }
  }
  const runById = new Map(runs.map((r) => [r.id, r] as const));

  let sprintList = registry.sprints;
  if (args.sprintId) {
    sprintList = sprintList.filter((s) => s.id === args.sprintId);
  }

  const teamSprints: TeamStatusSprint[] = sprintList.map((sprint) => {
    const runId = sprintToRunId.get(sprint.id) ?? null;
    const run = runId ? (runById.get(runId) ?? null) : null;
    return {
      id: sprint.id,
      title: sprint.title,
      status: sprint.status,
      agent: run?.agent ?? null,
      lane: sprint.lane,
      run_id: runId,
      progress: run ? progressString(run) : null,
      started_at: sprint.started_at,
      eta: run ? computeRunEta(run, now) : null,
    };
  });

  const registryHealth = computeRegistryHealth(registry);

  // `files_changed` is named in the published TeamStatus schema as a
  // count of finding-bearing files rather than a literal git diff count
  // — it surfaces the volume of issues an agent or reviewer must triage.
  // `conflicts` is the count of P0 findings (true blockers). Renaming
  // either field would be a schema break; the docstring clarifies what
  // each value represents.
  const findingFileCount =
    registry.health.findingCounts.P0 +
    registry.health.findingCounts.P1 +
    registry.health.findingCounts.P2;

  return {
    timestamp: now.toISOString(),
    runs: teamRuns,
    sprints: teamSprints,
    registry: {
      files_changed: findingFileCount,
      conflicts: registry.health.findingCounts.P0,
      ...registryHealth,
    },
    bottlenecks: bottleneckLines(registry, runs),
  };
}

export async function getTeamStatus(input: TeamStatusInput): Promise<TeamStatus> {
  const now = (input.now ?? (() => new Date()))();
  const { runs, corrupt } = await listRunsWithCorruption(input.opRoot);
  const status = composeTeamStatus({
    registry: input.registry,
    runs,
    now,
    ...(input.sprintId !== undefined ? { sprintId: input.sprintId } : {}),
  });
  if (corrupt.length === 0) return status;
  return {
    ...status,
    registry: {
      ...status.registry,
      ready_to_merge: false,
      health: status.registry.health === 'BLOCKED' ? 'BLOCKED' : 'DEGRADED',
    },
    bottlenecks: [
      ...status.bottlenecks,
      ...corrupt.map((entry) => `corrupt run state: ${entry.file} (${entry.reason})`),
    ],
  };
}
