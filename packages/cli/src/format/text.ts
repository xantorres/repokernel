import { type Finding, meetsThreshold, type Severity } from '@repokernel/core';
import pc from 'picocolors';
import { explainFinding } from '../ux/explanations.js';

const SEVERITIES: Severity[] = ['P0', 'P1', 'P2', 'P3'];

export interface FindingFilters {
  readonly only?: Severity;
  readonly min?: Severity;
  readonly codes?: readonly string[];
  readonly entity?: string;
}

export function hasFindingFilters(filters: FindingFilters | undefined): boolean {
  if (!filters) return false;
  return (
    filters.only !== undefined ||
    filters.min !== undefined ||
    filters.entity !== undefined ||
    (filters.codes !== undefined && filters.codes.length > 0)
  );
}

export function filterFindings(
  findings: readonly Finding[],
  filters: FindingFilters | undefined,
): Finding[] {
  if (!hasFindingFilters(filters)) return [...findings];
  const codes = new Set(filters?.codes ?? []);
  return findings.filter((finding) => {
    if (filters?.only !== undefined && finding.severity !== filters.only) return false;
    if (filters?.min !== undefined && !meetsThreshold(finding.severity, filters.min)) return false;
    if (codes.size > 0 && !codes.has(finding.code)) return false;
    if (filters?.entity !== undefined && finding.entityId !== filters.entity) return false;
    return true;
  });
}

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No findings.';
  const lines: string[] = [];
  for (const severity of SEVERITIES) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(formatSeverityHeader(severity, group.length));
    for (const finding of group) {
      lines.push(...formatFindingBlock(finding).map((line) => (line ? `  ${line}` : '')));
    }
  }
  return lines.join('\n');
}

export function formatFindingSummary(findings: readonly Finding[]): string {
  const counts = countFindings(findings);
  const nonzero = SEVERITIES.filter((severity) => counts[severity] > 0).map(
    (severity) => `${counts[severity]} ${severity}`,
  );
  return nonzero.length > 0 ? nonzero.join(', ') : 'clean';
}

export function countFindings(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function formatSingleFinding(finding: Finding): string {
  return formatFindingBlock(finding).join('\n');
}

export function formatFirstFindingSummary(finding: Finding): string {
  const explanation = explainFinding(finding);
  const lines: string[] = [];
  lines.push(`${finding.severity} ${finding.code}`);
  if (finding.message) lines.push(finding.message);
  lines.push(explanation.why);
  lines.push('');
  lines.push('Fix:');
  lines.push(`  ${finding.suggestion ?? explanation.fix}`);
  if (explanation.command) {
    lines.push(
      `  or run: ${explanation.command.replace('<SPRINT_ID>', finding.entityId ?? '<SPRINT_ID>')}`,
    );
  }
  return lines.join('\n');
}

export function severityLabel(severity: Severity): string {
  switch (severity) {
    case 'P0':
      return pc.red(severity);
    case 'P1':
      return pc.red(severity);
    case 'P2':
      return pc.yellow(severity);
    case 'P3':
      return pc.dim(severity);
  }
}

function formatSeverityHeader(severity: Severity, count: number): string {
  const noun = count === 1 ? 'finding' : 'findings';
  const label =
    severity === 'P0'
      ? 'Critical'
      : severity === 'P1'
        ? 'Blocking'
        : severity === 'P2'
          ? 'Warning'
          : 'Notice';
  return `${severityLabel(severity)} ${label} (${count} ${noun})`;
}

function formatFindingBlock(finding: Finding): string[] {
  const explanation = explainFinding(finding);
  const lines: string[] = [];
  const entity = finding.entityId ? ` ${pc.dim(`[${finding.entityId}]`)}` : '';
  lines.push(`${pc.bold(finding.code)}${entity}`);
  if (finding.file) lines.push(`File: ${finding.file}`);
  lines.push('');
  lines.push('Problem:');
  lines.push(`  ${finding.message}`);
  lines.push('');
  lines.push('Why it matters:');
  lines.push(`  ${explanation.why}`);
  lines.push('');
  lines.push('Expected:');
  lines.push(`  ${explanation.expected}`);
  lines.push('');
  lines.push('Fix:');
  lines.push(`  ${finding.suggestion ?? explanation.fix}`);
  if (explanation.command) {
    lines.push(
      `  Related: ${explanation.command.replace('<SPRINT_ID>', finding.entityId ?? '<SPRINT_ID>')}`,
    );
  }
  lines.push('');
  return lines;
}
