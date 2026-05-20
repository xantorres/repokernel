import { resolve } from 'node:path';
import {
  EPIC_ID_RE,
  loadProject,
  planParallelWaves,
  RepoKernelError,
  SPRINT_ID_RE,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { operationalRoot } from '../lifecycle/controlPaths.js';
import { claimSprint, releaseSprint } from '../lifecycle/sprintClaim.js';
import type { CommandResult } from './validate.js';

export interface WaveParallelOptions {
  readonly cwd: string;
  readonly json: boolean;
  /**
   * Optional sprint or epic selector. Accepts `S-NNN`, `S-NNN..S-NNN`,
   * `E-NNN`, `E-NNN..E-NNN`, mixed comma-separated. When omitted, the
   * planner considers every queued and planned sprint in the project.
   */
  readonly selector?: string;
  readonly maxPerLane?: number;
  readonly maxTotal?: number;
}

/**
 * Emit a parallel-execution plan: a sequence of waves where every sprint
 * within a wave can run concurrently without dependency or `allowed_paths`
 * conflicts. Does NOT mutate state; the agent layer (or `rk run --worktree`
 * once shipped) consumes this plan to schedule worktree spawns.
 *
 * Production feedback item #9.
 */
export async function runWaveParallelCommand(opts: WaveParallelOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
      };
    }

    const invalidLimit = invalidLimitMessage(opts);
    if (invalidLimit !== null) {
      return { exitCode: EXIT_USAGE, stdout: '', stderr: `${invalidLimit}\n` };
    }
    let sprintFilter: string[] | undefined;
    if (opts.selector !== undefined && opts.selector.trim().length > 0) {
      const expanded = expandSelector(opts.selector, outcome.graph);
      if (!expanded.ok) {
        return { exitCode: EXIT_USAGE, stdout: '', stderr: `${expanded.message}\n` };
      }
      sprintFilter = expanded.value;
    }

    const rawPlan = planParallelWaves(outcome.graph, {
      ...(sprintFilter !== undefined ? { sprintIds: sprintFilter } : {}),
    });
    const plan = limitPlan(rawPlan, outcome.graph, opts);

    if (opts.json) {
      return { exitCode: EXIT_OK, stdout: emitJson(plan), stderr: '' };
    }

    if (plan.waves.length === 0 && plan.skipped.length === 0) {
      return {
        exitCode: EXIT_OK,
        stdout: 'No sprints matched the selector — nothing to plan.\n',
        stderr: '',
      };
    }

    const lines: string[] = [];
    lines.push(`Parallel wave plan (${plan.waves.length} wave(s), ${plan.skipped.length} skipped)`);
    lines.push('');
    for (const wave of plan.waves) {
      lines.push(`Wave ${wave.index} (${wave.entries.length} sprint(s)):`);
      for (const entry of wave.entries) {
        const paths =
          entry.allowed_paths.length === 0
            ? '(no allowed_paths — wide write surface)'
            : entry.allowed_paths.join(', ');
        lines.push(`  ${entry.sprint_id}  ${paths}`);
      }
      lines.push('');
    }
    if (plan.skipped.length > 0) {
      lines.push('Skipped:');
      for (const s of plan.skipped) {
        lines.push(`  ${s.sprint_id} — ${s.reason}`);
      }
    }
    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

export async function runWaveClaimCommand(opts: WaveParallelOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
      };
    }
    const invalidLimit = invalidLimitMessage(opts);
    if (invalidLimit !== null) {
      return { exitCode: EXIT_USAGE, stdout: '', stderr: `${invalidLimit}\n` };
    }
    let sprintFilter: string[] | undefined;
    if (opts.selector !== undefined && opts.selector.trim().length > 0) {
      const expanded = expandSelector(opts.selector, outcome.graph);
      if (!expanded.ok) {
        return { exitCode: EXIT_USAGE, stdout: '', stderr: `${expanded.message}\n` };
      }
      sprintFilter = expanded.value;
    }
    const selectedIds =
      sprintFilter ??
      [...outcome.graph.sprints.values()]
        .filter((sprint) => sprint.status === 'queued' || sprint.status === 'planned')
        .map((sprint) => sprint.id);
    const unclaimable = selectedIds
      .map((id) => outcome.graph.sprints.get(id))
      .filter(
        (sprint): sprint is NonNullable<typeof sprint> =>
          sprint !== undefined && sprint.status !== 'queued',
      )
      .map((sprint) => ({
        sprint_id: sprint.id,
        status: sprint.status,
        reason: `wave claim only claims queued sprints (found ${sprint.status})`,
      }));
    const claimableFilter = selectedIds.filter(
      (id) => outcome.graph.sprints.get(id)?.status === 'queued',
    );
    const plan = limitPlan(
      planParallelWaves(outcome.graph, {
        ...(claimableFilter !== undefined ? { sprintIds: claimableFilter } : {}),
      }),
      outcome.graph,
      opts,
    );
    const firstWave = plan.waves[0]?.entries ?? [];
    const opRoot = await operationalRoot(cwd);
    const runId = `RUN-${Date.now()}${process.pid}`;
    const claims = [];
    const acquired: string[] = [];
    for (const entry of firstWave) {
      const claim = await claimSprint({ opRoot, runId, sprintId: entry.sprint_id });
      if (claim.ok) acquired.push(entry.sprint_id);
      claims.push({
        sprint_id: entry.sprint_id,
        ok: claim.ok,
        run_id: runId,
        ...(claim.ok ? {} : { held_by: claim.heldBy }),
      });
    }
    const failed = claims.some((claim) => !claim.ok) || unclaimable.length > 0;
    if (failed) {
      await Promise.all(acquired.map((sprintId) => releaseSprint({ opRoot, sprintId, runId })));
    }
    if (opts.json) {
      return {
        exitCode: failed ? EXIT_FINDINGS : EXIT_OK,
        stdout: emitJson({ run_id: runId, claims, unclaimable, planned: plan }),
        stderr: '',
      };
    }
    const lines = [`Wave claim ${runId}`, ''];
    for (const claim of claims) {
      lines.push(
        claim.ok
          ? `claimed ${claim.sprint_id}`
          : `blocked ${claim.sprint_id} — held by ${claim.held_by}`,
      );
    }
    for (const item of unclaimable) {
      lines.push(`blocked ${item.sprint_id} — ${item.reason}`);
    }
    return {
      exitCode: failed ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${lines.join('\n')}\n`,
      stderr: '',
    };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function limitPlan(
  plan: ReturnType<typeof planParallelWaves>,
  graph: {
    readonly sprints: ReadonlyMap<string, { readonly id: string; readonly lane?: string }>;
  },
  opts: { readonly maxPerLane?: number; readonly maxTotal?: number },
): ReturnType<typeof planParallelWaves> {
  const maxPerLane = opts.maxPerLane ?? Number.POSITIVE_INFINITY;
  const maxTotal = opts.maxTotal ?? Number.POSITIVE_INFINITY;
  let nextIndex = 1;
  const waves = [];
  for (const wave of plan.waves) {
    let remaining = [...wave.entries];
    while (remaining.length > 0) {
      const byLane = new Map<string, number>();
      const entries = [];
      const deferred = [];
      for (const entry of remaining) {
        const lane = graph.sprints.get(entry.sprint_id)?.lane ?? 'main';
        const laneCount = byLane.get(lane) ?? 0;
        if (entries.length >= maxTotal || laneCount >= maxPerLane) {
          deferred.push(entry);
          continue;
        }
        byLane.set(lane, laneCount + 1);
        entries.push(entry);
      }
      if (entries.length === 0) break;
      waves.push({ ...wave, index: nextIndex, entries });
      nextIndex += 1;
      remaining = deferred;
    }
  }
  return {
    ...plan,
    waves,
  };
}

function invalidLimitMessage(opts: {
  readonly maxPerLane?: number;
  readonly maxTotal?: number;
}): string | null {
  if (
    opts.maxPerLane !== undefined &&
    (!Number.isSafeInteger(opts.maxPerLane) || opts.maxPerLane < 1)
  ) {
    return '--max-per-lane must be a positive integer';
  }
  if (opts.maxTotal !== undefined && (!Number.isSafeInteger(opts.maxTotal) || opts.maxTotal < 1)) {
    return '--max-total must be a positive integer';
  }
  return null;
}

interface Graph {
  readonly sprints: ReadonlyMap<string, { id: string; epic_id: string }>;
  readonly sprintsByEpic: ReadonlyMap<string, readonly string[]>;
}

/**
 * Parse `S-NNN`, `S-NNN..S-NNN`, `E-NNN`, `E-NNN..E-NNN`, and mixed
 * comma-separated combinations into a flat list of sprint ids. Epic ids
 * expand to their member sprints via `graph.sprintsByEpic`.
 */
function expandSelector(
  selector: string,
  graph: Graph,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const sprintIds: string[] = [];
  for (const part of selector.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const sprintRange = /^(S-)(\d+)\.\.S-(\d+)$/u.exec(trimmed);
    if (sprintRange) {
      const [, prefix, startRaw, endRaw] = sprintRange;
      if (prefix === undefined || startRaw === undefined || endRaw === undefined) {
        return { ok: false, message: `invalid sprint range "${trimmed}"` };
      }
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return { ok: false, message: `invalid sprint range "${trimmed}"` };
      }
      const width = startRaw.length;
      const step = start <= end ? 1 : -1;
      for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
        sprintIds.push(`${prefix}${String(n).padStart(width, '0')}`);
      }
      continue;
    }

    const epicRange = /^(E-)(\d+)\.\.E-(\d+)$/u.exec(trimmed);
    if (epicRange) {
      const [, prefix, startRaw, endRaw] = epicRange;
      if (prefix === undefined || startRaw === undefined || endRaw === undefined) {
        return { ok: false, message: `invalid epic range "${trimmed}"` };
      }
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return { ok: false, message: `invalid epic range "${trimmed}"` };
      }
      const width = startRaw.length;
      const step = start <= end ? 1 : -1;
      for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
        const epicId = `${prefix}${String(n).padStart(width, '0')}`;
        const members = graph.sprintsByEpic.get(epicId) ?? [];
        sprintIds.push(...members);
      }
      continue;
    }

    if (SPRINT_ID_RE.test(trimmed)) {
      sprintIds.push(trimmed);
      continue;
    }

    if (EPIC_ID_RE.test(trimmed)) {
      const members = graph.sprintsByEpic.get(trimmed) ?? [];
      sprintIds.push(...members);
      continue;
    }

    return {
      ok: false,
      message: `invalid selector "${trimmed}" (use S-NNN, S-NNN..S-NNN, E-NNN, or E-NNN..E-NNN)`,
    };
  }
  return { ok: true, value: [...new Set(sprintIds)] };
}
