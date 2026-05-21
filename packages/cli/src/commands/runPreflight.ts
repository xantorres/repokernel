import {
  buildExecutionWaves,
  type Config,
  type EpicId,
  type loadProject,
  RepoKernelError,
  type SprintId,
} from '@repokernel/core';
import { BUILTIN_PRESETS } from '../agents/catalog.js';
import { assertAgentTrusted, trustCandidatesForCwd } from '../security/spawnPolicy.js';
import { buildChain } from './chain.js';

export type PreflightStatus = 'pass' | 'fail' | 'warn';

export interface PreflightCheck {
  readonly id: string;
  readonly status: PreflightStatus;
  readonly detail: string;
}

export interface EpicPreflightResult {
  readonly epicId: string;
  readonly checks: readonly PreflightCheck[];
  readonly runnableSprintCount: number;
  /** True when any check failed — the run cannot safely proceed. */
  readonly blocking: boolean;
}

type LoadedProject = Extract<Awaited<ReturnType<typeof loadProject>>, { ok: true }>;

/** Agents that run in-process and need no user-local trust grant. */
const RESERVED_AGENTS = new Set(['manual', 'fake', 'ollama']);

export interface EpicPreflightArgs {
  readonly cwd: string;
  readonly epicId: EpicId;
  readonly lane: string;
  readonly agentName: string;
  readonly strategy: 'sequential' | 'parallel';
  readonly config: Config;
  readonly outcome: LoadedProject;
}

/**
 * One cheap, total, strictly read-only pre-flight pass over an epic before
 * `rk run` acquires any worktree, run record, or lane claim. Every probe
 * returns structured data — nothing is thrown for a check failure, so the
 * caller decides which failures are fatal.
 */
export async function epicPreflight(args: EpicPreflightArgs): Promise<EpicPreflightResult> {
  const { cwd, epicId, lane, agentName, strategy, config, outcome } = args;
  const { graph } = outcome;
  const checks: PreflightCheck[] = [];

  // 1. epic-status
  const epic = graph.epics.get(epicId);
  if (!epic) {
    checks.push({ id: 'epic-status', status: 'fail', detail: `epic ${epicId} not found` });
    return { epicId, checks, runnableSprintCount: 0, blocking: true };
  }
  const epicStatusOk = epic.status === 'planned' || epic.status === 'active';
  checks.push({
    id: 'epic-status',
    status: epicStatusOk ? 'pass' : 'fail',
    detail: epicStatusOk
      ? `epic status is ${epic.status}`
      : `epic status is ${epic.status} (must be planned or active)`,
  });

  // 2. runnable-sprints
  const { chain, ineligible, gate } = buildChain(
    outcome,
    lane,
    99,
    config.chaining.sameEpicOnly,
    epicId,
  );
  let runnableSprintCount: number;
  if (strategy === 'parallel') {
    const shipped = new Set<SprintId>();
    for (const s of graph.sprints.values()) {
      if (s.status === 'shipped' || s.status === 'cancelled') shipped.add(s.id as SprintId);
    }
    const waves = buildExecutionWaves(
      graph,
      epicId,
      shipped,
      config.parallel.maxConcurrentSprints,
      {
        lane,
      },
    );
    runnableSprintCount = waves.reduce((sum, w) => sum + w.sprints.length, 0);
  } else {
    runnableSprintCount = chain.length;
  }
  // An epic whose sprints are all shipped/cancelled legitimately has zero
  // runnable sprints — that is EPIC_COMPLETED, not a failure.
  const epicSprints = [...graph.sprints.values()].filter((s) => s.epic_id === epicId);
  const epicComplete =
    epicSprints.length > 0 &&
    epicSprints.every((s) => s.status === 'shipped' || s.status === 'cancelled');
  // A gate ahead of the chain is a legitimate pause point, not a failure: the
  // run will start and halt at the gate. Only a genuinely empty, non-gated,
  // non-complete epic is a blocking "0 runnable sprints".
  checks.push({
    id: 'runnable-sprints',
    status: runnableSprintCount > 0 || epicComplete || gate ? 'pass' : 'fail',
    detail:
      runnableSprintCount > 0
        ? `${runnableSprintCount} runnable sprint(s) on lane ${lane}`
        : epicComplete
          ? 'epic already complete — every sprint is shipped or cancelled'
          : gate
            ? `the run will start and pause at the gate on ${gate.id} (${gate.gate})`
            : `0 runnable sprints on lane ${lane}${
                ineligible.length > 0 ? ` — ${ineligible.length} ineligible` : ''
              }`,
  });

  // 3. trust
  checks.push(await trustCheck(agentName, config, cwd));

  // 4. lane-placement
  const laneHasQueue = graph.queuesByLane.has(lane);
  const laneHasFile = graph.laneFiles.some((l) => l.name === lane);
  checks.push({
    id: 'lane-placement',
    status: laneHasQueue || laneHasFile ? 'pass' : 'warn',
    detail:
      laneHasQueue || laneHasFile
        ? `lane ${lane} exists (queue: ${laneHasQueue ? 'yes' : 'no'}, lane file: ${laneHasFile ? 'yes' : 'no'})`
        : `lane ${lane} has no queue file and no lane file yet`,
  });

  // 5. queue-position — is the chain head actually the head of its lane queue?
  const slots = [...(graph.queuesByLane.get(lane) ?? [])].sort((a, b) => a.order - b.order);
  const headSprint = chain[0];
  if (headSprint) {
    const eligibleSlot = slots.find((slot) => {
      const sp = graph.sprints.get(slot.sprint_id);
      return sp && sp.status !== 'shipped' && sp.status !== 'cancelled';
    });
    const atHead = eligibleSlot === undefined || eligibleSlot.sprint_id === headSprint.id;
    checks.push({
      id: 'queue-position',
      status: atHead ? 'pass' : 'fail',
      detail: atHead
        ? `${headSprint.id} is at the head of lane ${lane}`
        : `${eligibleSlot?.sprint_id} is ahead of ${headSprint.id} in lane ${lane} — close or skip it first`,
    });
  } else {
    checks.push({
      id: 'queue-position',
      status: 'warn',
      detail: `no runnable sprint to position-check on lane ${lane}`,
    });
  }

  // 6. dependency-readiness
  const depBlocked = ineligible.filter((i) => i.reason.includes('depends on unshipped'));
  checks.push({
    id: 'dependency-readiness',
    status: depBlocked.length === 0 ? 'pass' : 'warn',
    detail:
      depBlocked.length === 0
        ? 'no runnable sprint is blocked by an unshipped dependency'
        : `${depBlocked.length} sprint(s) waiting on unshipped dependencies: ${depBlocked
            .map((i) => i.sprint.id)
            .join(', ')}`,
  });

  // 7. path-scope-coverage — parallel runs require every sprint to declare
  //    allowed_paths; an unscoped sprint cannot be conflict-checked.
  const unscoped = chain.filter((s) => s.allowed_paths.length === 0);
  const scopeRequired = strategy === 'parallel';
  checks.push({
    id: 'path-scope-coverage',
    status: unscoped.length === 0 ? 'pass' : scopeRequired ? 'fail' : 'warn',
    detail:
      unscoped.length === 0
        ? 'every runnable sprint declares allowed_paths'
        : `${unscoped.length} runnable sprint(s) have empty allowed_paths: ${unscoped
            .map((s) => s.id)
            .join(', ')}`,
  });

  return {
    epicId,
    checks,
    runnableSprintCount,
    blocking: checks.some((c) => c.status === 'fail'),
  };
}

async function trustCheck(agentName: string, config: Config, cwd: string): Promise<PreflightCheck> {
  if (RESERVED_AGENTS.has(agentName)) {
    return { id: 'trust', status: 'pass', detail: `agent ${agentName} needs no trust grant` };
  }
  const def = config.agents[agentName] ?? BUILTIN_PRESETS[agentName];
  if (!def) {
    return { id: 'trust', status: 'fail', detail: `unknown agent: ${agentName}` };
  }
  try {
    const candidates = await trustCandidatesForCwd(cwd);
    await assertAgentTrusted(agentName, def, cwd, { fallbackCwd: candidates[1] });
    return { id: 'trust', status: 'pass', detail: `agent ${agentName} is trusted for this repo` };
  } catch (e) {
    if (e instanceof RepoKernelError && e.kind === 'TRUST_DENIED') {
      return { id: 'trust', status: 'fail', detail: e.message };
    }
    throw e;
  }
}

/**
 * Render an `EpicPreflightResult` as aligned report lines for `rk run
 * --dry-run` and `rk run --preflight`.
 */
export function renderPreflight(result: EpicPreflightResult): string[] {
  const lines = ['Pre-flight checks:'];
  for (const check of result.checks) {
    const mark = check.status === 'pass' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL';
    lines.push(`  [${mark}] ${check.id} — ${check.detail}`);
  }
  return lines;
}
