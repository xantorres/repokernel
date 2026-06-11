import { resolve } from 'node:path';
import { formatHalt, RepoKernelError, type RunStatus } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { padEnd } from '../format/table.js';
import { operationalRoot } from '../lifecycle/controlPaths.js';
import { listRuns } from '../lifecycle/runState.js';
import type { CommandResult } from './validate.js';

export interface RunsCommandOptions {
  readonly cwd: string;
  readonly status?: RunStatus;
  readonly epic?: string;
  readonly json: boolean;
}

export async function runRunsCommand(opts: RunsCommandOptions): Promise<CommandResult> {
  const controlCwd = resolve(opts.cwd);

  try {
    const opRoot = await operationalRoot(controlCwd);
    let runs = await listRuns(opRoot);

    if (opts.status) {
      runs = runs.filter((r) => r.status === opts.status);
    }
    if (opts.epic) {
      runs = runs.filter((r) => r.epic_id === opts.epic);
    }

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify({ runs }, null, 2)}\n`,
        stderr: '',
      };
    }

    if (runs.length === 0) {
      return { exitCode: EXIT_OK, stdout: '(no runs found)\n', stderr: '' };
    }

    const colWidths = {
      id: Math.max(...runs.map((r) => r.id.length), 6),
      epic: Math.max(...runs.map((r) => r.epic_id.length), 4),
      agent: Math.max(...runs.map((r) => r.agent.length), 5),
      status: Math.max(...runs.map((r) => r.status.length), 6),
    };

    const header = [
      padEnd('RUN-ID', colWidths.id),
      padEnd('EPIC', colWidths.epic),
      padEnd('AGENT', colWidths.agent),
      padEnd('STATUS', colWidths.status),
      padEnd('SPRINTS', 7),
      padEnd('STARTED', 19),
      'HALT',
    ].join('  ');

    const sep = '─'.repeat(header.length);
    const lines = [pc.bold(header), sep];

    for (const run of runs) {
      const started = run.started_at.slice(0, 19).replace('T', ' ');
      const statusColor =
        run.status === 'running'
          ? pc.green(run.status)
          : run.status === 'completed'
            ? pc.dim(run.status)
            : run.status === 'paused'
              ? pc.yellow(run.status)
              : pc.red(run.status);

      lines.push(
        [
          padEnd(run.id, colWidths.id),
          padEnd(run.epic_id, colWidths.epic),
          padEnd(run.agent, colWidths.agent),
          padEnd(statusColor, colWidths.status + 10), // +10 for color escape codes
          padEnd(String(run.sprint_count), 7),
          padEnd(started, 19),
          formatHalt(run.halt_reason) ?? '—',
        ].join('  '),
      );
    }

    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}
