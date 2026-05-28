import type { Severity } from '@repokernel/core';
import { emitJson } from './json.js';

export type BriefCommand = 'status' | 'next' | 'validate' | 'inspect' | 'gates';

export interface BriefJsonBase<TCommand extends BriefCommand> {
  readonly schemaVersion: 1;
  readonly brief: true;
  readonly command: TCommand;
  readonly ok: boolean;
}

export type NextBriefResult = 'runnable' | 'planned' | 'blocked' | 'none';

export interface StatusBriefJson extends BriefJsonBase<'status'> {
  readonly initialized: boolean;
  readonly projectId?: string;
  readonly activeEpicId?: string;
  readonly nextSprintId?: string;
  readonly nextLane: string;
  readonly lanesFree: number;
  readonly lanesTotal: number;
}

export interface NextBriefJson extends BriefJsonBase<'next'> {
  readonly result: NextBriefResult;
  readonly sprintId?: string;
  readonly epicId?: string;
  readonly lane: string;
  readonly queueDepth: number;
  readonly blockers: number;
  readonly warnings: number;
}

export interface ValidateBriefJson extends BriefJsonBase<'validate'> {
  readonly threshold: Severity;
  readonly findings: number;
  readonly blockers: number;
  readonly warnings: number;
  readonly maxSeverity: Severity | null;
}

export interface InspectBriefJson extends BriefJsonBase<'inspect'> {
  readonly entityType: 'sprint' | 'epic' | 'review' | 'queue' | 'lane';
  readonly id: string;
  readonly status?: string;
  readonly title?: string;
  readonly epicId?: string;
  readonly lane?: string;
  readonly blockers: number;
  readonly warnings: number;
}

export interface GatesBriefJson extends BriefJsonBase<'gates'> {
  readonly sprintId: string;
  readonly steps: readonly {
    readonly label: string;
    readonly status: 'passed' | 'failed' | 'skipped';
    readonly exitCode: number | null;
  }[];
  readonly failed: number;
}

export type BriefJson =
  | StatusBriefJson
  | NextBriefJson
  | ValidateBriefJson
  | InspectBriefJson
  | GatesBriefJson;

const ENV_BRIEF_COMMANDS = new Set<BriefCommand>(['status', 'next', 'validate', 'inspect']);

export function shouldUseEnvBrief(command: BriefCommand): boolean {
  const value = process.env.RK_BRIEF;
  return value === '1' && ENV_BRIEF_COMMANDS.has(command);
}

export function emitBriefJson(report: BriefJson): string {
  return emitJson(report);
}

export function formatBriefText(report: BriefJson): string {
  switch (report.command) {
    case 'status':
      if (!report.initialized) return 'RK status | not initialized | run rk init\n';
      return `${[
        'RK status',
        `project=${report.projectId ?? 'unknown'}`,
        `active=${report.activeEpicId ?? 'none'}`,
        `next=${report.nextSprintId ?? 'none'}`,
        `lanes=${report.lanesFree}/${report.lanesTotal}`,
      ].join(' | ')}\n`;
    case 'next':
      return `${[
        'RK next',
        `result=${report.result}`,
        `sprint=${report.sprintId ?? 'none'}`,
        `lane=${report.lane}`,
        `queue=${report.queueDepth}`,
        `blockers=${report.blockers}`,
        `warnings=${report.warnings}`,
      ].join(' | ')}\n`;
    case 'validate':
      return `${[
        'RK validate',
        `ok=${String(report.ok)}`,
        `findings=${report.findings}`,
        `blockers=${report.blockers}`,
        `warnings=${report.warnings}`,
        `max=${report.maxSeverity ?? 'none'}`,
      ].join(' | ')}\n`;
    case 'inspect':
      return `${[
        'RK inspect',
        `${report.entityType}=${report.id}`,
        `status=${report.status ?? 'n/a'}`,
        `blockers=${report.blockers}`,
        `warnings=${report.warnings}`,
      ].join(' | ')}\n`;
    case 'gates':
      return `${[
        'RK gates',
        `sprint=${report.sprintId}`,
        `ok=${String(report.ok)}`,
        `steps=${report.steps.length}`,
        `failed=${report.failed}`,
      ].join(' | ')}\n`;
  }
}
