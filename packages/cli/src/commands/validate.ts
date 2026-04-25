import {
  FINDING_CODES,
  meetsThreshold,
  RepoKernelError,
  type Severity,
  type ValidationReport,
  validateProject,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import {
  type FindingFilters,
  filterFindings,
  formatFindingSummary,
  formatFindings,
  hasFindingFilters,
} from '../format/text.js';
import { openPathInEditor } from '../ux/open.js';

export interface ValidateCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly failOn?: Severity;
  readonly filters?: FindingFilters;
  readonly open?: boolean;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runValidateCommand(opts: ValidateCommandOptions): Promise<CommandResult> {
  if (opts.json && opts.open) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'validate --open cannot be used with --json\n',
    };
  }

  const knownCodes = new Set(Object.keys(FINDING_CODES));
  const unknownCodes = (opts.filters?.codes ?? []).filter((c) => !knownCodes.has(c));
  const unknownCodeWarning =
    unknownCodes.length > 0
      ? `Unknown code${unknownCodes.length > 1 ? 's' : ''}: ${unknownCodes.join(', ')}. Run \`rk explain\` to list valid codes.\n`
      : '';

  let report: ValidationReport;
  try {
    report = await validateProject({ cwd: opts.cwd });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }

  const threshold: Severity = opts.failOn ?? report.config?.policies.severityFailThreshold ?? 'P1';
  const displayedFindings = filterFindings(report.findings, opts.filters);
  const breaching = report.findings.some((f) => meetsThreshold(f.severity, threshold));
  const displayedBreaching = displayedFindings.some((f) => meetsThreshold(f.severity, threshold));
  const exitCode = breaching ? EXIT_FINDINGS : EXIT_OK;

  if (opts.json) {
    return {
      exitCode,
      stdout: emitJson({
        cwd: report.cwd,
        configPath: report.configPath,
        threshold,
        findings: displayedFindings,
        ...(hasFindingFilters(opts.filters) ? { filters: opts.filters } : {}),
      }),
      stderr: unknownCodeWarning,
    };
  }

  const lines: string[] = [];
  lines.push('RepoKernel validation');
  lines.push('');
  if (displayedFindings.length === 0) {
    lines.push(hasFindingFilters(opts.filters) ? 'No findings matched filters.' : 'No findings.');
  } else {
    lines.push(formatFindings(displayedFindings));
  }
  lines.push('');
  lines.push(`Health: ${formatFindingSummary(displayedFindings)}`);
  if (breaching) {
    lines.push(
      displayedBreaching
        ? `Threshold ${threshold} breached.`
        : `Threshold ${threshold} breached by findings hidden by filters.`,
    );
  }
  if (opts.open) {
    const firstWithFile = displayedFindings.find((f) => f.file);
    lines.push('');
    if (firstWithFile?.file) {
      const opened = await openPathInEditor(report.cwd, firstWithFile.file);
      lines.push(opened.message);
    } else {
      lines.push('No finding file to open.');
    }
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: unknownCodeWarning };
}
