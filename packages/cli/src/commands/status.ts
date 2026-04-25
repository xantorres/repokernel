import {
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
import { formatFindingSummary } from '../format/text.js';
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

  return formatStatus(report, findings, opts.json, EXIT_OK);
}

function formatStatus(
  report: StatusReport,
  findings: readonly { severity: Severity }[],
  json: boolean,
  exitCode: number,
): CommandResult {
  if (json) {
    return { exitCode, stdout: emitJson(report), stderr: '' };
  }
  const lines: string[] = [];
  if (report.project) {
    lines.push(`Project: ${report.project.id} (${report.project.name})`);
  } else {
    lines.push('Project: <config invalid>');
  }
  lines.push(`Config:  ${report.configPath}`);
  lines.push(
    `Health:  max=${report.maxSeverity ?? 'none'} blocked=${report.blocked ? 'yes' : 'no'}`,
  );
  lines.push(`Findings: ${formatFindingSummary(findings as never)}`);
  lines.push(
    `Counts:  sprints=${report.counts.sprints} epics=${report.counts.epics} reviews=${report.counts.reviews}`,
  );
  lines.push(
    `Sprint statuses: active=${report.counts.active} queued=${report.counts.queued} shipped=${report.counts.shipped}`,
  );
  lines.push(
    `Next:    lane=${report.next.lane} result=${report.next.result} sprint=${report.next.sprintId ?? '-'}`,
  );
  if (report.registryPath) lines.push(`Registry path: ${report.registryPath}`);
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
