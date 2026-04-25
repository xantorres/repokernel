import {
  type Finding,
  type LoadProjectOutcome,
  loadProject,
  meetsThreshold,
  RepoKernelError,
  resolveNextRunnableSprint,
  runValidators,
  type Severity,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { formatFindingSummary, formatFirstFindingSummary } from '../format/text.js';
import type { CommandResult } from './validate.js';

export interface StatusCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
}

interface StatusReport {
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly configPath: string;
  readonly maxSeverity: Severity | null;
  readonly findingCounts: Record<Severity, number>;
  readonly blocked: boolean;
  readonly counts: {
    readonly sprints: number;
    readonly epics: number;
    readonly reviews: number;
    readonly active: number;
    readonly queued: number;
    readonly shipped: number;
  };
  readonly next: {
    readonly lane: string;
    readonly result: string;
    readonly sprintId: string | null;
  };
  readonly registryPath: string | null;
}

export async function runStatusCommand(opts: StatusCommandOptions): Promise<CommandResult> {
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd: opts.cwd });
  } catch (e) {
    if (e instanceof RepoKernelError) {
      if (e.kind === 'CONFIG_FILE_NOT_FOUND') {
        if (opts.json) {
          return {
            exitCode: EXIT_FINDINGS,
            stdout: emitJson({
              project: null,
              configPath: null,
              maxSeverity: 'P0',
              findingCounts: { P0: 1, P1: 0, P2: 0, P3: 0 },
              blocked: true,
              counts: { sprints: 0, epics: 0, reviews: 0, active: 0, queued: 0, shipped: 0 },
              next: { lane: 'unknown', result: 'blocked', sprintId: null },
              registryPath: null,
            }),
            stderr: '',
          };
        }
        return {
          exitCode: EXIT_FINDINGS,
          stdout: `${[
            'RepoKernel',
            '',
            'Project: <not initialized>',
            'State:   incomplete',
            'Health:  setup incomplete',
            '',
            'Fix:',
            '  repokernel init',
          ].join('\n')}\n`,
          stderr: '',
        };
      }
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
  if (!outcome.ok) {
    const counts: Record<Severity, number> = { P0: 1, P1: 0, P2: 0, P3: 0 };
    const report: StatusReport = {
      project: null,
      configPath: outcome.configPath,
      maxSeverity: 'P0',
      findingCounts: counts,
      blocked: true,
      counts: { sprints: 0, epics: 0, reviews: 0, active: 0, queued: 0, shipped: 0 },
      next: { lane: 'unknown', result: 'blocked', sprintId: null },
      registryPath: null,
    };
    return formatStatus(report, outcome.findings, opts.json, EXIT_FINDINGS);
  }

  const findings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
  });

  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity]++;
  const sevOrder: Severity[] = ['P0', 'P1', 'P2', 'P3'];
  const maxSeverity = sevOrder.find((s) => counts[s] > 0) ?? null;
  const blocked = findings.some((f) =>
    meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
  );

  const sprints = [...outcome.graph.sprints.values()];
  const sprintCounts = {
    sprints: sprints.length,
    epics: outcome.graph.epics.size,
    reviews: outcome.graph.reviews.size,
    active: sprints.filter((s) => s.status === 'active').length,
    queued: sprints.filter((s) => s.status === 'queued').length,
    shipped: sprints.filter((s) => s.status === 'shipped').length,
  };

  const next = resolveNextRunnableSprint(outcome.graph, outcome.config, findings);

  const report: StatusReport = {
    project: { id: outcome.config.projectId, name: outcome.config.projectName },
    configPath: outcome.configPath,
    maxSeverity,
    findingCounts: counts,
    blocked,
    counts: sprintCounts,
    next: { lane: next.lane, result: next.result, sprintId: next.sprintId },
    registryPath: outcome.config.paths.registry,
  };

  const nextSprint =
    next.sprintId !== null ? (outcome.graph.sprints.get(next.sprintId) ?? null) : null;
  return formatStatus(
    report,
    findings,
    opts.json,
    blocked ? EXIT_FINDINGS : EXIT_OK,
    nextSprint ? { title: nextSprint.title } : undefined,
  );
}

function formatStatus(
  report: StatusReport,
  findings: readonly Finding[],
  json: boolean,
  exitCode: number,
  nextSprint?: { readonly title: string },
): CommandResult {
  if (json) {
    return { exitCode, stdout: emitJson(report), stderr: '' };
  }
  const lines: string[] = [];
  lines.push('RepoKernel');
  lines.push('');
  if (report.project) {
    lines.push(`Project: ${report.project.id} (${report.project.name})`);
  } else {
    lines.push('Project: <config invalid>');
  }
  lines.push(`State:   ${report.blocked ? 'blocked' : 'valid'}`);
  lines.push(`Health:  ${formatFindingSummary(findings)}`);
  lines.push('');
  lines.push('Project files:');
  lines.push(
    `  ${report.counts.sprints} sprints, ${report.counts.epics} epics, ${report.counts.reviews} reviews`,
  );
  lines.push(
    `  ${report.counts.active} active, ${report.counts.queued} queued, ${report.counts.shipped} shipped`,
  );
  lines.push('');
  lines.push('Next work:');
  if (report.next.result === 'runnable' && report.next.sprintId) {
    const title = nextSprint?.title ? `: ${nextSprint.title}` : '';
    lines.push(`  ${report.next.sprintId}${title}`);
    lines.push(`  Lane: ${report.next.lane}`);
  } else if (report.next.result === 'blocked') {
    lines.push('  No runnable sprint');
  } else {
    lines.push('  No runnable sprint');
  }

  const blocker = findings.find((f) => report.maxSeverity && f.severity === report.maxSeverity);
  if (blocker) {
    lines.push('');
    lines.push('Blocking:');
    lines.push(
      formatFirstFindingSummary(blocker)
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
  }
  if (report.registryPath) {
    lines.push('');
    lines.push(`Registry: ${report.registryPath}`);
  }
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
