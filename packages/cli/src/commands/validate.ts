import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  FINDING_CODES,
  type Finding,
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
import { findLeakedEpicWorktrees, findLeakedSprintWorktrees } from '../lifecycle/worktree.js';
import { openPathInEditor } from '../ux/open.js';

const execFileAsync = promisify(execFile);

export interface ValidateCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly failOn?: Severity;
  readonly filters?: FindingFilters;
  readonly open?: boolean;
  readonly since?: string;
  readonly runtimeVersion?: string;
  /** Include `audit`-scope rules (historical hygiene). Default false (live only). */
  readonly audit?: boolean;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runValidateCommand(opts: ValidateCommandOptions): Promise<CommandResult> {
  const knownCodes = new Set(Object.keys(FINDING_CODES));
  const unknownCodes = (opts.filters?.codes ?? []).filter((c) => !knownCodes.has(c));
  const unknownCodeWarning =
    unknownCodes.length > 0
      ? `Unknown code${unknownCodes.length > 1 ? 's' : ''}: ${unknownCodes.join(', ')}. Run \`rk explain\` to list valid codes.\n`
      : '';

  let report: ValidationReport;
  try {
    report = await validateProject({
      cwd: opts.cwd,
      ...(opts.runtimeVersion !== undefined ? { runtimeVersion: opts.runtimeVersion } : {}),
      scope: opts.audit === true ? 'all' : 'live',
    });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }

  // Layer in the CLI-only operational findings: leaked sprint and epic
  // worktrees recorded in worktrees.json that no longer correspond to active
  // entities. The core validator can't see worktrees.json — it lives outside
  // the project tree.
  if (report.project?.ok) {
    try {
      const activeSprintIds = new Set(
        [...report.project.parsed.sprints]
          .filter((s) => s.status !== 'shipped' && s.status !== 'cancelled')
          .map((s) => s.id),
      );
      const activeEpicIds = new Set(
        [...report.project.parsed.epics]
          .filter((e) => e.status !== 'done' && e.status !== 'cancelled')
          .map((e) => e.id),
      );
      const operationalFindings = [
        ...(await findLeakedSprintWorktrees(activeSprintIds, report.cwd)),
        ...(await findLeakedEpicWorktrees(activeEpicIds, report.cwd)),
      ];
      if (operationalFindings.length > 0) {
        report = { ...report, findings: [...report.findings, ...operationalFindings] };
      }
    } catch {
      // worktrees.json missing or unreadable is fine — no finding to add.
    }
  }

  const threshold: Severity = opts.failOn ?? report.config?.policies.severityFailThreshold ?? 'P1';
  let displayedFindings = await addFindingLocations(
    filterFindings(report.findings, opts.filters),
    report.cwd,
  );
  let sinceWarning = '';
  if (opts.since !== undefined) {
    try {
      const changedFiles = await listChangedFiles(report.cwd, opts.since);
      displayedFindings = filterBySince(displayedFindings, report.cwd, changedFiles);
    } catch (cause) {
      sinceWarning = `--since ${opts.since}: ${(cause as Error).message} (filter not applied)\n`;
    }
  }
  const breaching = report.findings.some((f) => meetsThreshold(f.severity, threshold));
  const displayedBreaching = displayedFindings.some((f) => meetsThreshold(f.severity, threshold));
  const exitCode = breaching ? EXIT_FINDINGS : EXIT_OK;

  if (opts.json) {
    if (opts.open) {
      for (const finding of displayedFindings.filter((f) => f.file)) {
        await openPathInEditor(report.cwd, finding.file!);
      }
    }
    return {
      exitCode,
      stdout: emitJson({
        cwd: report.cwd,
        configPath: report.configPath,
        threshold,
        findings: displayedFindings,
        ...(hasFindingFilters(opts.filters) ? { filters: opts.filters } : {}),
      }),
      stderr: `${unknownCodeWarning}${sinceWarning}`,
    };
  }

  const lines: string[] = [];
  if (opts.since !== undefined) {
    lines.push(
      `(--since ${opts.since}: showing only findings whose file changed; full validation remains authoritative for ship/close/run)`,
    );
    lines.push('');
  }
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
    const withFiles = displayedFindings.filter((f) => f.file);
    lines.push('');
    if (withFiles.length === 0) {
      lines.push('No finding files to open.');
    } else {
      for (const finding of withFiles) {
        const opened = await openPathInEditor(report.cwd, finding.file!);
        lines.push(opened.message);
      }
    }
  }
  return {
    exitCode,
    stdout: `${lines.join('\n')}\n`,
    stderr: `${unknownCodeWarning}${sinceWarning}`,
  };
}

async function addFindingLocations(findings: readonly Finding[], cwd: string): Promise<Finding[]> {
  const cache = new Map<string, string[] | null>();
  const out: Finding[] = [];
  for (const finding of findings) {
    if (!finding.file || finding.line !== undefined) {
      out.push(finding);
      continue;
    }
    const lines = await readFindingFileLines(cwd, finding.file, cache);
    const line = lines ? findBestFindingLine(lines, finding) : 1;
    out.push({ ...finding, line });
  }
  return out;
}

async function readFindingFileLines(
  cwd: string,
  file: string,
  cache: Map<string, string[] | null>,
): Promise<string[] | null> {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  try {
    const text = await readFile(join(cwd, file), 'utf8');
    const lines = text.split(/\r?\n/);
    cache.set(file, lines);
    return lines;
  } catch {
    cache.set(file, null);
    return null;
  }
}

function findBestFindingLine(lines: readonly string[], finding: Finding): number {
  const pathHead = Array.isArray(finding.data?.path) ? finding.data.path[0] : null;
  if (typeof pathHead === 'string') {
    const index = findYamlKeyLine(lines, pathHead);
    if (index !== null) return index + 1;
  }
  const entityId = finding.entityId;
  if (entityId) {
    // Hoist the RegExp out of findIndex so we compile once per finding
    // instead of once per finding × line. ReDoS-safe: entityId is escaped.
    const idLine = new RegExp(`^\\s*id:\\s*['"]?${escapeRegex(entityId)}['"]?\\s*$`);
    const index = lines.findIndex((line) => idLine.test(line));
    if (index >= 0) return index + 1;
  }
  return 1;
}

function findYamlKeyLine(lines: readonly string[], key: string): number | null {
  const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*:`);
  const index = lines.findIndex((line) => re.test(line));
  return index >= 0 ? index : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

async function listChangedFiles(cwd: string, since: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'diff', '--name-only', `${since}`]);
  const files = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(files);
}

function filterBySince(
  findings: readonly Finding[],
  cwd: string,
  changedFiles: ReadonlySet<string>,
): Finding[] {
  return findings.filter((f) => {
    if (!f.file) return true; // findings with no file always display
    const rel = f.file.startsWith(cwd) ? f.file.slice(cwd.length).replace(/^\//, '') : f.file;
    return changedFiles.has(rel) || changedFiles.has(f.file);
  });
}
