import { resolve } from 'node:path';
import {
  EPIC_ID_RE,
  loadProject,
  planParallelWaves,
  RepoKernelError,
  SPRINT_ID_RE,
} from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
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

    let sprintFilter: string[] | undefined;
    if (opts.selector !== undefined && opts.selector.trim().length > 0) {
      const expanded = expandSelector(opts.selector, outcome.graph);
      if (!expanded.ok) {
        return { exitCode: EXIT_USAGE, stdout: '', stderr: `${expanded.message}\n` };
      }
      sprintFilter = expanded.value;
    }

    const plan = planParallelWaves(outcome.graph, {
      ...(sprintFilter !== undefined ? { sprintIds: sprintFilter } : {}),
    });

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
