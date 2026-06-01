import { resolve } from 'node:path';
import {
  buildSatisfiedSprints,
  type Finding,
  type Graph,
  type LoadProjectOutcome,
  loadProject,
  RepoKernelError,
  resolveNextRunnableSprint,
  runValidators,
  type Sprint,
  unmetDependencies,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson, jsonError, jsonOk } from '../format/json.js';
import { formatFindings } from '../format/text.js';
import { runStartCommand } from './lifecycle.js';
import type { CommandResult } from './validate.js';

export interface StartNextCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly lane?: string;
  readonly epic?: string;
  readonly dryRun?: boolean;
}

/**
 * Resolve the next runnable (or unblocked-planned) sprint and start it in one
 * step — the missing verb between `rk next` (read-only) and `rk start <id>`.
 * A planned-but-unqueued candidate is queued and started via start's --enqueue.
 */
export async function runStartNextCommand(opts: StartNextCommandOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
  if (!outcome.ok) {
    return reportBlocked(opts.json, outcome.findings);
  }
  if (opts.lane !== undefined && !outcome.graph.lanes.has(opts.lane)) {
    const known = [...outcome.graph.lanes.keys()].sort().join(', ') || 'none';
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `unknown lane: ${opts.lane}\nKnown lanes: ${known}\n`,
    };
  }

  const findings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
  });
  const resolveOpts: { lane?: string; epicId?: string } = {};
  if (opts.lane !== undefined) resolveOpts.lane = opts.lane;
  if (opts.epic !== undefined) resolveOpts.epicId = opts.epic;
  const resolution = resolveNextRunnableSprint(
    outcome.graph,
    outcome.config,
    findings,
    resolveOpts,
  );

  // Mirror `rk next`: an unblocked planned sprint that isn't queued yet is a
  // valid start target — start --enqueue queues and starts it in one step.
  const plannedCandidate =
    resolution.result !== 'runnable' && resolution.blockers.length === 0
      ? (findUnblockedPlanned(outcome.graph, resolution.lane, opts.epic)[0] ?? null)
      : null;
  const targetId = plannedCandidate?.id ?? resolution.sprintId;

  if (targetId === null) {
    if (resolution.blockers.length > 0) return reportBlocked(opts.json, resolution.blockers);
    return reportNone(opts.json, resolution.lane);
  }

  const target = outcome.graph.sprints.get(targetId);
  if (target?.status === 'active') {
    return reportAlreadyActive(opts.json, targetId, resolution.lane);
  }

  if (opts.dryRun === true) {
    return reportWouldStart(opts.json, targetId, resolution.lane);
  }

  // Hand off to start; --enqueue queues+starts a planned candidate and is a
  // no-op for an already-queued sprint. Its result (and any error) is returned
  // verbatim so the caller sees the canonical start output.
  return runStartCommand(targetId, {
    cwd,
    force: false,
    enqueue: true,
    dryRun: false,
    json: opts.json,
  });
}

function findUnblockedPlanned(graph: Graph, lane: string, epicId?: string): Sprint[] {
  const satisfied = buildSatisfiedSprints(graph.sprints.values());
  const results: Sprint[] = [];
  for (const sprint of graph.sprints.values()) {
    if (sprint.status !== 'planned') continue;
    if (sprint.lane !== lane) continue;
    if (epicId !== undefined && sprint.epic_id !== epicId) continue;
    if (unmetDependencies(sprint, satisfied).length === 0) results.push(sprint);
  }
  return results;
}

function reportBlocked(json: boolean, blockers: readonly Finding[]): CommandResult {
  if (json) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: emitJson(
        jsonError('NO_RUNNABLE_SPRINT', 'project state is unsafe', {
          details: { result: 'blocked', sprint_id: null, blockers: [...blockers] },
          warnings: [...blockers],
          nextActions: ['rk validate'],
        }),
      ),
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_FINDINGS,
    stdout: `No runnable sprint — project state is unsafe.\n\n${formatFindings(blockers)}\n\nRun:\n  rk validate\n`,
    stderr: '',
  };
}

function reportNone(json: boolean, lane: string): CommandResult {
  if (json) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: emitJson(
        jsonError('NO_RUNNABLE_SPRINT', 'no runnable sprint', {
          details: { result: 'none', sprint_id: null, lane },
          nextActions: ['rk next'],
        }),
      ),
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_FINDINGS,
    stdout: `No runnable or unblocked sprint in lane "${lane}".\n`,
    stderr: '',
  };
}

function reportAlreadyActive(json: boolean, sprintId: string, lane: string): CommandResult {
  if (json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson(jsonOk({ result: 'already_active', sprint_id: sprintId, lane })),
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: `${sprintId} is already active in lane "${lane}" — nothing to start.\n`,
    stderr: '',
  };
}

function reportWouldStart(json: boolean, sprintId: string, lane: string): CommandResult {
  if (json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson(jsonOk({ result: 'would_start', sprint_id: sprintId, lane })),
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: `Would start ${sprintId} (lane "${lane}").\n`,
    stderr: '',
  };
}
