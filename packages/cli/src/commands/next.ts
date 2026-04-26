import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type Graph,
  type LoadProjectOutcome,
  loadProject,
  parseNextMdText,
  RepoKernelError,
  readNextMd,
  resolveNextRunnableSprint,
  runValidators,
  type Sprint,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { formatFindings } from '../format/text.js';
import { reorderQueueSlots } from '../lifecycle/mutate.js';
import { refreshRegistry } from '../lifecycle/registry.js';
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

// ─── rk next validate ────────────────────────────────────────────────────────

export interface NextValidateCommandOptions {
  readonly cwd: string;
  readonly lane?: string;
  readonly json: boolean;
}

export async function runNextValidateCommand(
  opts: NextValidateCommandOptions,
): Promise<CommandResult> {
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
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: 'project load failed — run rk validate\n',
    };
  }

  if (!outcome.config.paths.next) {
    return {
      exitCode: EXIT_OK,
      stdout: 'no paths.next configured — skipping NEXT.md validation\n',
      stderr: '',
    };
  }

  const nextPath = join(cwd, outcome.config.paths.next);
  const { parsed, findings } = await readNextMd(nextPath, outcome.config.paths.next);

  if (!parsed) {
    if (findings.length === 0) {
      return { exitCode: EXIT_OK, stdout: 'NEXT.md not found — nothing to validate\n', stderr: '' };
    }
    if (opts.json) {
      return { exitCode: EXIT_FINDINGS, stdout: emitJson({ findings }), stderr: '' };
    }
    return { exitCode: EXIT_FINDINGS, stdout: `${formatFindings(findings)}\n`, stderr: '' };
  }

  // Run NEXT.md sync rules inline via the already-parsed nextMd
  const allFindings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: { ...outcome.parsed, nextMd: parsed },
    parseFindings: findings,
  });

  const nextFindings = allFindings.filter(
    (f) =>
      f.code.startsWith('NEXT_MD_') &&
      (opts.lane === undefined || (f.data as { lane?: string })?.lane === opts.lane),
  );

  if (opts.json) {
    return {
      exitCode: nextFindings.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: emitJson({ ok: nextFindings.length === 0, findings: nextFindings }),
      stderr: '',
    };
  }

  if (nextFindings.length === 0) {
    return {
      exitCode: EXIT_OK,
      stdout: `NEXT.md OK — ${parsed.slots.length} slots validated\n`,
      stderr: '',
    };
  }

  return {
    exitCode: EXIT_FINDINGS,
    stdout: `NEXT.md has ${nextFindings.length} finding${nextFindings.length === 1 ? '' : 's'}:\n${formatFindings(nextFindings)}\n`,
    stderr: '',
  };
}

// ─── rk next generate ────────────────────────────────────────────────────────

export interface NextGenerateCommandOptions {
  readonly cwd: string;
  readonly lane?: string;
  readonly force: boolean;
  readonly json: boolean;
}

export async function runNextGenerateCommand(
  opts: NextGenerateCommandOptions,
): Promise<CommandResult> {
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
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: 'project load failed — run rk validate\n',
    };
  }

  const lane = opts.lane ?? outcome.config.policies.defaultLane;
  const slots = 4;
  const queueSlots = outcome.graph.queuesByLane.get(lane) ?? [];

  // Top N queue entries become slots
  const topSlots = queueSlots.slice(0, slots);

  const now = new Date().toISOString();
  const lines: string[] = [
    '---',
    `schema_version: 1`,
    `lane: ${lane}`,
    `slots: ${slots}`,
    `generated_at: ${now}`,
    '---',
    '',
  ];

  const SLOT_LABELS = ['Active', 'Next', 'Queued', 'Queued'];
  for (let i = 0; i < slots; i++) {
    const label = SLOT_LABELS[i] ?? 'Queued';
    lines.push(`## Slot ${i + 1} — ${label}`);
    const qs = topSlots[i];
    if (qs) {
      const sprint = outcome.graph.sprints.get(qs.sprint_id);
      const title = sprint ? ` · ${sprint.epic_id} · ${sprint.title}` : '';
      lines.push(`- ${qs.sprint_id}${title}`);
    }
    lines.push('');
  }

  const content = lines.join('\n');

  // Determine output path
  const nextConfigPath = outcome.config.paths.next ?? 'NEXT.md';
  const nextPath = join(cwd, nextConfigPath);

  // If file exists and --force not set, show diff-like preview
  if (!opts.force) {
    let existingText: string | null = null;
    try {
      const { readFile } = await import('node:fs/promises');
      existingText = await readFile(nextPath, 'utf8');
    } catch {
      // file doesn't exist — safe to write
    }

    if (existingText !== null) {
      const { parsed: existingParsed } = parseNextMdText(existingText, nextConfigPath);
      const existingIds =
        existingParsed?.slots.filter((s) => s.sprintId).map((s) => s.sprintId) ?? [];
      const newIds = topSlots.map((s) => s.sprint_id);
      const same =
        existingIds.length === newIds.length && existingIds.every((id, i) => id === newIds[i]);
      if (same) {
        return { exitCode: EXIT_OK, stdout: `NEXT.md already up to date\n`, stderr: '' };
      }
      return {
        exitCode: EXIT_FINDINGS,
        stdout:
          [
            `NEXT.md exists and differs. Use --force to overwrite.`,
            '',
            `Current slots: ${existingIds.join(', ') || '(empty)'}`,
            `New slots:     ${newIds.join(', ') || '(empty)'}`,
            '',
            `Run: rk next generate --force`,
          ].join('\n') + '\n',
        stderr: '',
      };
    }
  }

  await writeFile(nextPath, content, 'utf8');

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ generated: nextConfigPath, slots: topSlots.length, lane }),
      stderr: '',
    };
  }

  return {
    exitCode: EXIT_OK,
    stdout: `Generated ${nextConfigPath} with ${topSlots.length} slot${topSlots.length === 1 ? '' : 's'} (lane: ${lane})\n`,
    stderr: '',
  };
}

// ─── rk next sync ────────────────────────────────────────────────────────────

export interface NextSyncCommandOptions {
  readonly cwd: string;
  readonly lane?: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export async function runNextSyncCommand(opts: NextSyncCommandOptions): Promise<CommandResult> {
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
    return {
      exitCode: EXIT_FINDINGS,
      stdout: '',
      stderr: 'project load failed — run rk validate\n',
    };
  }

  if (!outcome.config.paths.next) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: 'no paths.next configured\n' };
  }

  const nextPath = join(cwd, outcome.config.paths.next);
  const { parsed: nextMd, findings } = await readNextMd(nextPath, outcome.config.paths.next);

  if (!nextMd) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'NEXT.md not found or could not be parsed\n',
    };
  }

  // Abort on P0/P1 parse-time findings
  const blocking = findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
  if (blocking.length > 0) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: `NEXT.md has ${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'} — fix before syncing:\n${formatFindings(blocking)}\n`,
      stderr: '',
    };
  }

  const lane = opts.lane ?? nextMd.lane;
  const nonVacant = nextMd.slots
    .filter((s) => s.sprintId !== null)
    .map((s) => s.sprintId as string);

  // Find queue for this lane
  const queue = outcome.parsed.queues.find((q) => q.lane === lane);
  if (!queue) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `no queue found for lane "${lane}"\n`,
    };
  }

  // Compute new ordering
  const currentSlots = [...queue.slots].sort((a, b) => a.order - b.order);
  const currentIds = currentSlots.map((s) => s.sprint_id);

  // New order: NEXT.md IDs first (only those in the queue), then remaining
  const nextIdsInQueue = nonVacant.filter((id) => currentIds.includes(id));
  const tailIds = currentIds.filter((id) => !nextIdsInQueue.includes(id));
  const newOrder = [...nextIdsInQueue, ...tailIds];

  const unchanged = newOrder.every((id, i) => id === currentIds[i]);

  if (opts.dryRun) {
    const lines = [`dry-run — would reorder queue (lane: ${lane}):`];
    for (let i = 0; i < newOrder.length; i++) {
      const id = newOrder[i]!;
      const oldPos = currentIds.indexOf(id);
      const changed = oldPos !== i ? ' [moved]' : '';
      lines.push(`  Slot ${i + 1} → ${id} (was order ${oldPos})${changed}`);
    }
    if (unchanged) lines.push('  (no changes needed)');
    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }

  if (unchanged) {
    return {
      exitCode: EXIT_OK,
      stdout: `queue already matches NEXT.md (lane: ${lane})\n`,
      stderr: '',
    };
  }

  const queueFile = join(cwd, queue.file);
  await reorderQueueSlots(queueFile, newOrder);
  await refreshRegistry(cwd);

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ lane, reordered: newOrder.length, file: queue.file }),
      stderr: '',
    };
  }

  return {
    exitCode: EXIT_OK,
    stdout: `Synced queue (lane: ${lane}) to match NEXT.md — ${newOrder.length} slots reordered\n`,
    stderr: '',
  };
}
