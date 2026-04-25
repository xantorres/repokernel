import type { EpicStatus, ReviewVerdict, SprintStatus } from '@repokernel/core';
import pc from 'picocolors';

export type LaneHealth = 'healthy' | 'stalled' | 'blocked';

const SPRINT_ICONS: Record<SprintStatus, string> = {
  shipped: '■',
  active: '▶',
  review: '◆',
  queued: '○',
  planned: '·',
  pending: '·',
  reopened: '↺',
  cancelled: '✗',
};

const EPIC_ICONS: Record<EpicStatus, string> = {
  done: '■',
  active: '▶',
  on_hold: '◆',
  planned: '·',
  cancelled: '✗',
};

const REVIEW_ICONS: Record<ReviewVerdict, string> = {
  accepted: '✓',
  pending: '◆',
  changes_requested: '↺',
  rejected: '✗',
};

export function sprintIcon(status: SprintStatus): string {
  return SPRINT_ICONS[status] ?? '?';
}

export function epicIcon(status: EpicStatus): string {
  return EPIC_ICONS[status] ?? '?';
}

export function reviewIcon(verdict: ReviewVerdict): string {
  return REVIEW_ICONS[verdict] ?? '?';
}

export function colorSprintStatus(status: SprintStatus): string {
  const icon = sprintIcon(status);
  const label = `${icon} ${status}`;
  switch (status) {
    case 'active':
      return pc.green(label);
    case 'review':
    case 'queued':
    case 'reopened':
      return pc.yellow(label);
    case 'cancelled':
      return pc.red(label);
    default:
      return pc.dim(label);
  }
}

export function colorEpicStatus(status: EpicStatus): string {
  const icon = epicIcon(status);
  const label = `${icon} ${status}`;
  switch (status) {
    case 'active':
      return pc.green(label);
    case 'on_hold':
      return pc.yellow(label);
    case 'cancelled':
      return pc.red(label);
    default:
      return pc.dim(label);
  }
}

export function colorReviewVerdict(verdict: ReviewVerdict): string {
  const icon = reviewIcon(verdict);
  const label = `${icon} ${verdict}`;
  switch (verdict) {
    case 'accepted':
      return pc.green(label);
    case 'pending':
    case 'changes_requested':
      return pc.yellow(label);
    case 'rejected':
      return pc.red(label);
  }
}

export function laneHealthDot(health: LaneHealth): string {
  switch (health) {
    case 'healthy':
      return pc.green('●');
    case 'stalled':
      return pc.yellow('○');
    case 'blocked':
      return pc.red('✗');
  }
}

export function progressBar(shipped: number, total: number, barWidth = 10): string {
  if (total === 0) {
    return `${pc.dim('─'.repeat(barWidth))}   0/0`;
  }
  const pct = Math.round((shipped / total) * barWidth);
  const bar = '█'.repeat(pct) + pc.dim('░'.repeat(barWidth - pct));
  const maxDigits = String(total).length;
  const label = `${shipped}/${total}`.padStart(maxDigits * 2 + 1);
  return `${bar}  ${label}`;
}
