import {
  loadProject,
  resolveNextRunnableSprint,
  RepoKernelError,
  runValidators,
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
  let outcome;
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
      stdout: `result: blocked\n\n${formatFindings(outcome.findings)}\n`,
      stderr: '',
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
  lines.push(`lane:   ${resolution.lane}`);
  lines.push(`result: ${resolution.result}`);
  if (resolution.sprintId) lines.push(`sprint: ${resolution.sprintId}`);
  if (resolution.blockers.length > 0) {
    lines.push('');
    lines.push('Blocking findings:');
    lines.push(formatFindings(resolution.blockers));
  } else if (resolution.result === 'none') {
    lines.push('');
    lines.push('No runnable sprint and no blockers.');
  }
  return { exitCode, stdout: lines.join('\n') + '\n', stderr: '' };
}
