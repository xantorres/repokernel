import { resolve } from 'node:path';
import {
  generateRegistry,
  type LoadProjectOutcome,
  loadProject,
  RepoKernelError,
  runValidators,
  type TeamStatus,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { padEnd } from '../format/table.js';
import { operationalRoot } from '../lifecycle/controlPaths.js';
import { getTeamStatus } from '../lifecycle/runState.js';
import { RK_GENERATED_BY } from '../version.js';
import type { CommandResult } from './validate.js';

export interface TeamStatusCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly sprint?: string;
  readonly watch?: boolean;
  readonly intervalSeconds?: number;
  /**
   * Bounded iteration count for the watch loop — set by tests and by the
   * eventual `--max-iterations` CLI flag. Defaults to `Infinity`. The
   * loop also exits on SIGINT/SIGTERM via the abort controller below.
   */
  readonly maxIterations?: number;
  /**
   * Inversion-of-control hook for the watch sleep. Tests pass a
   * synchronous resolver so the loop runs without real wall-clock
   * delays. Production code uses the default setTimeout-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function runTeamStatusCommand(opts: TeamStatusCommandOptions): Promise<CommandResult> {
  if (opts.watch) {
    // Watch mode is a thin loop on top of the single-shot render. The
    // loop pulls signal handling and bounded iteration into one place so
    // production runs and tests share the same control flow.
    return runWatchLoop(opts);
  }
  return runOnce(opts);
}

async function runOnce(opts: TeamStatusCommandOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!outcome.ok) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: opts.json ? `${JSON.stringify({ findings: outcome.findings }, null, 2)}\n` : '',
      stderr: opts.json ? '' : 'project state is invalid; run `rk validate`\n',
    };
  }

  const findings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
  });
  const registry = generateRegistry({
    graph: outcome.graph,
    config: outcome.config,
    findings,
    generatedBy: RK_GENERATED_BY,
  });

  const opRoot = await operationalRoot(cwd);
  const status = await getTeamStatus({
    opRoot,
    registry,
    ...(opts.sprint !== undefined ? { sprintId: opts.sprint } : {}),
  });

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify(status, null, 2)}\n`,
      stderr: '',
    };
  }
  return { exitCode: EXIT_OK, stdout: renderTextDashboard(status), stderr: '' };
}

// ANSI: ESC [2J erases the entire screen, ESC [H homes the cursor. Using
// the explicit two-sequence form keeps the behaviour identical across
// terminals that don't honour the shorter `ESC c` full-reset sequence
// (some CI runners and dumb terminals).
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

// Floor for `--interval` set high enough that re-running the entire
// validator + registry generation pipeline every tick stays cheap on
// large projects. 5s was a footgun on real-world repos.
const MIN_WATCH_INTERVAL_SECONDS = 15;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function runWatchLoop(opts: TeamStatusCommandOptions): Promise<CommandResult> {
  const intervalMs = Math.max(MIN_WATCH_INTERVAL_SECONDS, opts.intervalSeconds ?? 30) * 1000;
  const sleep = opts.sleep ?? defaultSleep;

  // Translate SIGINT/SIGTERM into a clean loop exit. The handlers are
  // installed only for the duration of the watch and removed in the
  // finally block so we do not leak listeners across CLI invocations
  // that share the process (tests, embedding hosts).
  let aborted = false;
  const abort = (): void => {
    aborted = true;
    process.stdout.write('\n');
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);

  let lastResult: CommandResult = { exitCode: EXIT_OK, stdout: '', stderr: '' };
  const maxIterations = opts.maxIterations ?? Number.POSITIVE_INFINITY;
  let iteration = 0;

  try {
    while (!aborted && iteration < maxIterations) {
      iteration += 1;
      const result = await runOnce({ ...opts, watch: false });
      // Clear-and-redraw between iterations only — leave the first frame
      // intact so users see initial output even if the process dies
      // before the second render.
      if (iteration > 1) process.stdout.write(CLEAR_SCREEN);
      process.stdout.write(result.stdout);
      lastResult = result;
      if (result.exitCode !== EXIT_OK) return result;
      if (iteration >= maxIterations || aborted) break;
      await sleep(intervalMs);
    }
    return lastResult;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

function renderTextDashboard(status: TeamStatus): string {
  const lines: string[] = [];
  lines.push(pc.bold(`team status — ${status.timestamp}`));
  lines.push('');

  if (status.runs.length === 0) {
    lines.push(pc.dim('runs: (none active)'));
  } else {
    lines.push(pc.bold('Runs'));
    const runHeader = [
      padEnd('RUN', 8),
      padEnd('EPIC', 10),
      padEnd('STATUS', 10),
      padEnd('ACTIVE', 7),
      padEnd('READY', 6),
      padEnd('REVIEW', 7),
      padEnd('STARTED', 19),
      'ETA',
    ].join('  ');
    lines.push(pc.dim(runHeader));
    for (const run of status.runs) {
      lines.push(
        [
          padEnd(run.run_id, 8),
          padEnd(run.epic_id, 10),
          padEnd(colourStatus(run.status), 10 + 10),
          padEnd(String(run.active_sprints), 7),
          padEnd(String(run.states.ready), 6),
          padEnd(String(run.states.review), 7),
          padEnd(run.started_at.slice(0, 19).replace('T', ' '), 19),
          run.eta?.slice(0, 19).replace('T', ' ') ?? '—',
        ].join('  '),
      );
    }
    lines.push('');
  }

  if (status.sprints.length > 0) {
    lines.push(pc.bold('Sprints'));
    const sprintHeader = [
      padEnd('SPRINT', 14),
      padEnd('STATUS', 10),
      padEnd('LANE', 10),
      padEnd('AGENT', 10),
      padEnd('PROGRESS', 9),
      'TITLE',
    ].join('  ');
    lines.push(pc.dim(sprintHeader));
    for (const sprint of status.sprints) {
      lines.push(
        [
          padEnd(sprint.id, 14),
          padEnd(sprint.status, 10),
          padEnd(sprint.lane, 10),
          padEnd(sprint.agent ?? '—', 10),
          padEnd(sprint.progress ?? '—', 9),
          sprint.title,
        ].join('  '),
      );
    }
    lines.push('');
  }

  lines.push(pc.bold('Registry'));
  lines.push(
    `  health=${colourHealth(status.registry.health)}  ` +
      `ready_to_merge=${status.registry.ready_to_merge}  ` +
      `conflicts=${status.registry.conflicts}  ` +
      `files_changed=${status.registry.files_changed}`,
  );

  if (status.bottlenecks.length > 0) {
    lines.push('');
    lines.push(pc.bold('Bottlenecks'));
    for (const b of status.bottlenecks) {
      lines.push(`  ${pc.yellow('•')} ${b}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function colourStatus(status: string): string {
  if (status === 'running') return pc.green(status);
  if (status === 'completed') return pc.dim(status);
  if (status === 'paused') return pc.yellow(status);
  return pc.red(status);
}

function colourHealth(health: string): string {
  if (health === 'OK') return pc.green(health);
  if (health === 'DEGRADED') return pc.yellow(health);
  return pc.red(health);
}
