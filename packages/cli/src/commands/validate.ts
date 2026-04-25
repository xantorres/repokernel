import {
  meetsThreshold,
  RepoKernelError,
  validateProject,
  type Severity,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { formatFindings, formatFindingSummary } from '../format/text.js';

export interface ValidateCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly failOn?: Severity;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runValidateCommand(
  opts: ValidateCommandOptions,
): Promise<CommandResult> {
  let report;
  try {
    report = await validateProject({ cwd: opts.cwd });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }

  const threshold: Severity = opts.failOn ?? 'P1';
  const breaching = report.findings.some((f) => meetsThreshold(f.severity, threshold));
  const exitCode = breaching ? EXIT_FINDINGS : EXIT_OK;

  if (opts.json) {
    return {
      exitCode,
      stdout: emitJson({
        cwd: report.cwd,
        configPath: report.configPath,
        threshold,
        findings: report.findings,
      }),
      stderr: '',
    };
  }

  const lines: string[] = [];
  lines.push(formatFindings(report.findings));
  lines.push('');
  lines.push(formatFindingSummary(report.findings));
  if (breaching) {
    lines.push(`Threshold ${threshold} breached.`);
  }
  return { exitCode, stdout: lines.join('\n') + '\n', stderr: '' };
}
