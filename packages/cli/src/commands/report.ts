import {
  type Epic,
  type Finding,
  type LoadProjectOutcome,
  loadProject,
  resolveNextRunnableSprint,
  runValidators,
  type Severity,
  type Sprint,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import type { CommandResult } from './validate.js';

export interface ReportCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly all?: boolean;
}

type LoadedProject = Extract<LoadProjectOutcome, { ok: true }>;

const SEVERITY_ORDER: readonly Severity[] = ['P0', 'P1', 'P2', 'P3'];

export async function runReportCommand(opts: ReportCommandOptions): Promise<CommandResult> {
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd: opts.cwd });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${message}\n` };
  }
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `cannot build report: ${outcome.findings[0]?.message ?? 'project failed to load'}\n`,
    };
  }

  let findings: readonly Finding[];
  try {
    findings = runValidators({
      graph: outcome.graph,
      config: outcome.config,
      parsed: outcome.parsed,
      parseFindings: outcome.parsed.findings,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `report failed: ${message}\n` };
  }

  if (opts.json === true) {
    return {
      exitCode: EXIT_OK,
      stdout: `${emitJson(buildJsonReport(outcome, findings))}\n`,
      stderr: '',
    };
  }

  return {
    exitCode: EXIT_OK,
    stdout: `${renderReportConsole(outcome, findings, opts.all === true)}\n`,
    stderr: '',
  };
}

interface JsonReport {
  readonly project: { readonly id: string; readonly name: string };
  readonly generatedAt: string;
  readonly counts: {
    readonly epics: number;
    readonly sprints: number;
    readonly active: number;
    readonly queued: number;
    readonly shipped: number;
    readonly findings: number;
  };
  readonly maxSeverity: Severity | null;
  readonly next: {
    readonly result: string;
    readonly sprintId: string | null;
    readonly lane: string;
  };
  readonly epics: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly sprints: number;
  }>;
  readonly sprints: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly lane: string;
    readonly epicId: string;
  }>;
  readonly findings: ReadonlyArray<{
    readonly severity: Severity;
    readonly code: string;
    readonly entityId: string | null;
    readonly message: string;
  }>;
}

function buildJsonReport(outcome: LoadedProject, findings: readonly Finding[]): JsonReport {
  const epics = [...outcome.graph.epics.values()].sort(byId);
  const sprints = [...outcome.graph.sprints.values()].sort(byId);
  const next = resolveNextRunnableSprint(outcome.graph, outcome.config, findings);
  const counts = countByStatus(sprints);
  const maxSeverity =
    SEVERITY_ORDER.find((sev) => findings.some((f) => f.severity === sev)) ?? null;

  return {
    project: { id: outcome.config.projectId, name: outcome.config.projectName },
    generatedAt: new Date().toISOString(),
    counts: {
      epics: epics.length,
      sprints: sprints.length,
      active: counts.active ?? 0,
      queued: counts.queued ?? 0,
      shipped: counts.shipped ?? 0,
      findings: findings.length,
    },
    maxSeverity,
    next: { result: next.result, sprintId: next.sprintId, lane: next.lane },
    epics: epics.map((e) => ({
      id: e.id,
      title: e.title,
      status: e.status,
      sprints: e.sprints.length,
    })),
    sprints: sprints.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      lane: s.lane,
      epicId: s.epic_id,
    })),
    findings: findings.map((f) => ({
      severity: f.severity,
      code: f.code,
      entityId: f.entityId ?? null,
      message: f.message,
    })),
  };
}

const DEFAULT_EPIC_LIMIT = 8;

function renderReportConsole(
  outcome: LoadedProject,
  findings: readonly Finding[],
  all: boolean,
): string {
  const epics = [...outcome.graph.epics.values()].sort(byId);
  const sprints = [...outcome.graph.sprints.values()].sort(byId);
  const next = resolveNextRunnableSprint(outcome.graph, outcome.config, findings);
  const maxSeverity = SEVERITY_ORDER.find((sev) => findings.some((f) => f.severity === sev));

  const titleWidth = computeTitleWidth(sprints);
  const sections: string[] = [];

  sections.push(headline(outcome, epics, sprints, findings, maxSeverity));
  sections.push('');
  sections.push(nextLine(next, sprints, titleWidth));

  const orphanSprints = sprints.filter((s) => !outcome.graph.epics.has(s.epic_id));

  if (epics.length > 0) {
    sections.push('');
    sections.push(epicWorkSection(epics, sprints, all, titleWidth));
  }

  if (orphanSprints.length > 0) {
    sections.push('');
    sections.push(orphanSection(orphanSprints, all, titleWidth));
  }

  if (findings.length > 0) {
    sections.push('');
    sections.push(findingsSection(findings, all));
  }

  return sections.join('\n');
}

interface EpicSummary {
  readonly epic: Epic;
  readonly counts: Record<string, number>;
  readonly sprints: readonly Sprint[];
  readonly active: readonly Sprint[];
  readonly relevant: number;
}

function summarizeEpics(epics: readonly Epic[], sprints: readonly Sprint[]): EpicSummary[] {
  const byEpic = new Map<string, Sprint[]>();
  for (const s of sprints) {
    const list = byEpic.get(s.epic_id) ?? [];
    list.push(s);
    byEpic.set(s.epic_id, list);
  }
  return epics.map((epic) => {
    const epicSprints = (byEpic.get(epic.id) ?? []).slice().sort(byId);
    const counts: Record<string, number> = {};
    for (const s of epicSprints) counts[s.status] = (counts[s.status] ?? 0) + 1;
    const active = epicSprints.filter((s) => s.status === 'active');
    const relevant =
      (counts.active ?? 0) + (counts.queued ?? 0) + (counts.planned ?? 0) + (counts.blocked ?? 0);
    return { epic, counts, sprints: epicSprints, active, relevant };
  });
}

function epicWorkSection(
  epics: readonly Epic[],
  sprints: readonly Sprint[],
  all: boolean,
  titleWidth: number,
): string {
  const summaries = summarizeEpics(epics, sprints);
  const ranked = [...summaries].sort((a, b) => {
    const activeDiff = (b.counts.active ?? 0) - (a.counts.active ?? 0);
    if (activeDiff !== 0) return activeDiff;
    const relevantDiff = b.relevant - a.relevant;
    if (relevantDiff !== 0) return relevantDiff;
    return a.epic.id.localeCompare(b.epic.id);
  });
  const visible = all ? ranked : ranked.filter((e) => e.relevant > 0);
  const limited = all ? visible : visible.slice(0, DEFAULT_EPIC_LIMIT);
  const hidden = visible.length - limited.length;
  const archivedHidden = all ? 0 : ranked.length - visible.length;

  const headerCount = all ? `${ranked.length} total` : `${limited.length} of ${ranked.length}`;
  const lines: string[] = [`${pc.bold('EPICS')} ${pc.dim(`(${headerCount})`)}`];

  if (limited.length === 0) {
    lines.push(pc.dim('  No active epic work.'));
  }

  for (const summary of limited) {
    lines.push(epicLine(summary, titleWidth));
    const sprintsToShow = all ? summary.sprints : summary.active;
    for (const sprint of sprintsToShow) {
      lines.push(sprintLine(sprint, titleWidth));
    }
  }

  const footerParts: string[] = [];
  if (hidden > 0) footerParts.push(`+${hidden} more with active/planned work`);
  if (archivedHidden > 0) footerParts.push(`${archivedHidden} archived (use --all)`);
  if (footerParts.length > 0) {
    lines.push(pc.dim(`  ${footerParts.join(' · ')}`));
  }

  return lines.join('\n');
}

function epicLine(summary: EpicSummary, titleWidth: number): string {
  const id = pc.bold(summary.epic.id);
  const title = truncateText(summary.epic.title, titleWidth).padEnd(titleWidth);
  const badges = epicBadges(summary.counts);
  return `  ${id}  ${title}  ${badges}`;
}

function epicBadges(counts: Record<string, number>): string {
  const parts: string[] = [];
  const a = counts.active ?? 0;
  const q = (counts.queued ?? 0) + (counts.planned ?? 0);
  const b = counts.blocked ?? 0;
  const s = (counts.shipped ?? 0) + (counts.done ?? 0);
  if (a > 0) parts.push(pc.green(`▶${a}`));
  if (b > 0) parts.push(pc.red(`✗${b}`));
  if (q > 0) parts.push(pc.cyan(`·${q}`));
  if (s > 0) parts.push(pc.dim(`✓${s}`));
  return parts.length > 0 ? parts.join(' ') : pc.dim('(empty)');
}

function sprintLine(sprint: Sprint, titleWidth: number): string {
  const glyph = statusGlyph(sprint.status);
  const id = pc.bold(sprint.id);
  const title = truncateText(sprint.title, titleWidth - 4).padEnd(titleWidth - 4);
  return `      ${glyph} ${id}  ${title}  ${pc.dim(sprint.lane)}`;
}

function orphanSection(orphanSprints: readonly Sprint[], all: boolean, titleWidth: number): string {
  const limit = all ? orphanSprints.length : 5;
  const visible = orphanSprints.slice(0, limit);
  const lines: string[] = [
    `${pc.bold('UNASSIGNED SPRINTS')} ${pc.dim(`(${orphanSprints.length})`)}`,
  ];
  for (const s of visible) lines.push(sprintLine(s, titleWidth));
  if (orphanSprints.length > visible.length) {
    lines.push(pc.dim(`  +${orphanSprints.length - visible.length} more (use --all)`));
  }
  return lines.join('\n');
}

function headline(
  outcome: LoadedProject,
  epics: readonly Epic[],
  sprints: readonly Sprint[],
  findings: readonly Finding[],
  maxSeverity: Severity | undefined,
): string {
  const health =
    findings.length === 0
      ? pc.green('clean')
      : maxSeverity !== undefined
        ? `${severityColor(maxSeverity)} ${pluralize(findings.length, 'finding', 'findings')}`
        : `${findings.length} findings`;
  return [
    pc.bold(outcome.config.projectId),
    pluralize(epics.length, 'epic', 'epics'),
    pluralize(sprints.length, 'sprint', 'sprints'),
    health,
  ].join(pc.dim(' · '));
}

function nextLine(
  next: { result: string; sprintId: string | null; lane: string },
  sprints: readonly Sprint[],
  titleWidth: number,
): string {
  const label = pc.bold('NEXT');
  if (next.result === 'runnable' && next.sprintId) {
    const sprint = sprints.find((s) => s.id === next.sprintId);
    const title = sprint ? truncateText(sprint.title, titleWidth) : '';
    const padded = title.padEnd(titleWidth);
    return `${label}  ${pc.green(next.sprintId)}  ${padded}  ${pc.dim(next.lane)}`;
  }
  const reason = nextHint(next.result, sprints);
  return `${label}  ${pc.yellow(next.result)}  ${pc.dim(reason)}`;
}

function nextHint(result: string, sprints: readonly Sprint[]): string {
  if (result === 'none') {
    const planned = sprints.filter((s) => s.status === 'planned' || s.status === 'queued').length;
    if (planned === 0) return 'no planned/queued sprints — `rk plan` to scope new work';
    return `${planned} sprint(s) waiting — \`rk queue add <SPRINT_ID>\` to schedule`;
  }
  if (result === 'blocked') {
    return 'a finding blocks scheduling — `rk validate` for detail';
  }
  return '';
}

interface FindingGroup {
  readonly severity: Severity;
  readonly code: string;
  readonly count: number;
  readonly sample: Finding;
}

function aggregateFindings(findings: readonly Finding[]): FindingGroup[] {
  const map = new Map<string, FindingGroup>();
  for (const f of findings) {
    const key = `${f.severity}:${f.code}`;
    const existing = map.get(key);
    if (existing) {
      map.set(key, { ...existing, count: existing.count + 1 });
    } else {
      map.set(key, { severity: f.severity, code: f.code, count: 1, sample: f });
    }
  }
  return [...map.values()].sort((a, b) => {
    const sev = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (sev !== 0) return sev;
    if (b.count !== a.count) return b.count - a.count;
    return a.code.localeCompare(b.code);
  });
}

function findingsSection(findings: readonly Finding[], all: boolean): string {
  const groups = aggregateFindings(findings);
  const codeCount = groups.length;
  const header = `${pc.bold('FINDINGS')} ${pc.dim(`(${findings.length} across ${codeCount} ${codeCount === 1 ? 'code' : 'codes'})`)}`;

  if (all) {
    const sorted = [...findings].sort((a, b) => {
      const sev = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      if (sev !== 0) return sev;
      const code = a.code.localeCompare(b.code);
      if (code !== 0) return code;
      return (a.entityId ?? '').localeCompare(b.entityId ?? '');
    });
    const codeWidth = sorted.reduce((m, f) => Math.max(m, f.code.length), 0);
    const rows = sorted.map((f) => {
      const entity = f.entityId ? `[${f.entityId}]` : '';
      return `  ${severityColor(f.severity)}  ${pc.bold(f.code.padEnd(codeWidth))}  ${pc.dim(entity.padEnd(8))}  ${f.message}`;
    });
    return [header, ...rows].join('\n');
  }

  const codeWidth = groups.reduce((m, g) => Math.max(m, g.code.length), 0);
  const rows = groups.map((g) => {
    const occ = `×${g.count}`.padStart(5);
    const sample = g.sample.message;
    return `  ${severityColor(g.severity)}  ${pc.bold(g.code.padEnd(codeWidth))}  ${pc.dim(occ)}  ${pc.dim(truncateText(sample, 60))}`;
  });
  rows.push(pc.dim('  Use --all or `rk validate` for per-entity detail.'));
  return [header, ...rows].join('\n');
}

function statusGlyph(status: string): string {
  switch (status) {
    case 'active':
      return pc.green('▶');
    case 'queued':
      return pc.cyan('·');
    case 'planned':
      return pc.dim('·');
    case 'shipped':
      return pc.dim('✓');
    case 'blocked':
      return pc.red('✗');
    case 'done':
      return pc.dim('✓');
    default:
      return ' ';
  }
}

function computeTitleWidth(sprints: readonly Sprint[]): number {
  const cols = Number.isFinite(process.stdout.columns) ? (process.stdout.columns as number) : 80;
  const fixedOverhead = 2 + 2 + 5 + 2 + 2 + 6;
  const available = Math.max(20, cols - fixedOverhead);
  const longest = sprints.reduce((m, s) => Math.max(m, s.title.length), 0);
  return Math.min(available, Math.max(20, longest));
}

function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function severityColor(severity: Severity): string {
  switch (severity) {
    case 'P0':
      return pc.red(pc.bold(severity));
    case 'P1':
      return pc.yellow(severity);
    case 'P2':
      return pc.cyan(severity);
    case 'P3':
      return pc.dim(severity);
  }
}

function byId<T extends Epic | Sprint>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function countByStatus(sprints: readonly Sprint[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sprint of sprints) counts[sprint.status] = (counts[sprint.status] ?? 0) + 1;
  return counts;
}
