import {
  type Graph,
  type LoadProjectOutcome,
  loadProject,
  RepoKernelError,
  resolveNextRunnableSprint,
  runValidators,
  type Sprint,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { formatFindings } from '../format/text.js';
import type { CommandResult } from './validate.js';

export interface NextCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly lane?: string;
}

export async function runNextCommand(opts: NextCommandOptions): Promise<CommandResult> {
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd: opts.cwd });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
  if (!outcome.ok) {
    if (opts.json) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: emitJson({
          result: 'blocked',
          sprintId: null,
          blockers: outcome.findings,
        }),
        stderr: '',
      };
    }
    return {
      exitCode: EXIT_FINDINGS,
      stdout: `${[
        'No runnable sprint',
        '',
        'RepoKernel blocked execution because project state is unsafe.',
        '',
        'Blocking findings:',
        formatFindings(outcome.findings),
        '',
        'Run:',
        '  repokernel validate',
      ].join('\n')}\n`,
      stderr: '',
    };
  }

  if (opts.lane !== undefined && !outcome.graph.lanes.has(opts.lane)) {
    const known = [...outcome.graph.lanes.keys()].sort().join(', ') || 'none';
    if (opts.json) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: emitJson({
          error: `unknown lane: ${opts.lane}`,
          knownLanes: [...outcome.graph.lanes.keys()].sort(),
        }),
        stderr: '',
      };
    }
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
  const resolution = resolveNextRunnableSprint(
    outcome.graph,
    outcome.config,
    findings,
    opts.lane !== undefined ? { lane: opts.lane } : {},
  );

  const exitCode = resolution.result === 'runnable' ? EXIT_OK : EXIT_FINDINGS;

  if (opts.json) {
    return {
      exitCode,
      stdout: emitJson({
        lane: resolution.lane,
        result: resolution.result,
        sprintId: resolution.sprintId,
        blockers: [...resolution.blockers],
      }),
      stderr: '',
    };
  }

  const lines: string[] = [];
  if (resolution.result === 'runnable' && resolution.sprintId) {
    const sprint = outcome.graph.sprints.get(resolution.sprintId);
    if (sprint) {
      lines.push(...formatRunnableSprint(outcome.graph, sprint, resolution.lane));
    } else {
      lines.push(`Next runnable sprint: ${resolution.sprintId}`);
    }
  } else if (resolution.blockers.length > 0) {
    lines.push('No runnable sprint');
    lines.push('');
    lines.push('RepoKernel blocked execution because project state is unsafe.');
    lines.push('');
    lines.push('Blocking findings:');
    lines.push(formatFindings(resolution.blockers));
    lines.push('');
    lines.push('Run:');
    lines.push('  repokernel validate');
  } else if (resolution.result === 'none') {
    lines.push('No runnable sprint');
    lines.push('');
    lines.push('RepoKernel found no runnable sprint in this lane.');
  }
  const queue = formatQueueReasons(outcome.graph, resolution.lane);
  if (queue.length > 0 && resolution.result !== 'runnable') {
    lines.push('');
    lines.push('Queue');
    lines.push(...queue);
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function formatRunnableSprint(graph: Graph, sprint: Sprint, lane: string): string[] {
  const lines: string[] = [];
  lines.push('Next runnable sprint');
  lines.push('');
  lines.push(`${sprint.id}: ${sprint.title}`);
  lines.push(`Epic: ${sprint.epic_id}`);
  lines.push(`Lane: ${sprint.lane}`);
  lines.push(`Status: ${sprint.status}`);
  lines.push('');
  lines.push('Why this sprint:');
  if (sprint.status === 'active') {
    lines.push(`  It is the active sprint in the ${lane} lane.`);
  } else {
    lines.push(`  It is first runnable queued sprint in the ${lane} queue.`);
  }
  const unmet = sprint.depends_on.filter((dep) => graph.sprints.get(dep)?.status !== 'shipped');
  if (sprint.depends_on.length === 0) {
    lines.push('  It has no hard dependencies.');
  } else if (unmet.length === 0) {
    lines.push('  All hard dependencies are shipped.');
  }
  lines.push('  No blocking validation findings apply.');
  lines.push('');
  lines.push('Allowed paths:');
  if (sprint.allowed_paths.length === 0) {
    lines.push('  (none declared)');
  } else {
    for (const path of sprint.allowed_paths) lines.push(`  ${path}`);
  }
  return lines;
}

function formatQueueReasons(graph: Graph, lane: string): string[] {
  const slots = graph.queuesByLane.get(lane) ?? [];
  return slots.flatMap((slot, index) => {
    const sprint = graph.sprints.get(slot.sprint_id);
    const label = sprint ? `${sprint.id} ${sprint.status}` : `${slot.sprint_id} missing`;
    const lines = [`${index + 1}. ${label}`];
    if (!sprint) {
      lines.push('   Runnable: no');
      lines.push('   Reason: sprint file is missing');
      return lines;
    }
    const reason = runnableReason(graph, sprint);
    lines.push(`   Runnable: ${reason.runnable ? 'yes' : 'no'}`);
    if (!reason.runnable) lines.push(`   Reason: ${reason.reason}`);
    return lines;
  });
}

function runnableReason(
  graph: Graph,
  sprint: Sprint,
): { readonly runnable: boolean; readonly reason: string } {
  if (sprint.status === 'active') return { runnable: true, reason: 'active sprint' };
  if (sprint.status !== 'queued') {
    return { runnable: false, reason: `${sprint.status} sprints are not runnable from the queue` };
  }
  const unmet = sprint.depends_on.filter((dep) => graph.sprints.get(dep)?.status !== 'shipped');
  if (unmet.length === 0) return { runnable: true, reason: 'queued and unblocked' };
  return {
    runnable: false,
    reason: `depends on ${unmet.join(', ')}, which ${unmet.length === 1 ? 'is' : 'are'} not shipped`,
  };
}
