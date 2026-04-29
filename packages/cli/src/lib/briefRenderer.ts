import type { Epic, Review, Sprint } from '@repokernel/core';

export type BriefGate = 'review-fail' | 'ready-to-close' | 'pause' | 'blocked' | 'status';
export const BRIEF_GATES: readonly BriefGate[] = [
  'review-fail',
  'ready-to-close',
  'pause',
  'blocked',
  'status',
];

export interface BriefSprintInput {
  readonly sprint: Sprint;
  readonly epic: Epic | undefined;
  readonly review: Review | undefined;
  readonly unmetDeps: readonly string[];
}

export interface BriefEpicInput {
  readonly epic: Epic;
  readonly sprints: readonly Sprint[];
  readonly nextRunnable: Sprint | undefined;
}

export interface BriefOutput {
  readonly markdown: string;
  readonly nextAction: string;
}

export function detectSprintGate(input: BriefSprintInput): BriefGate {
  const { review, unmetDeps } = input;
  if (review) {
    if (review.verdict === 'accepted') return 'ready-to-close';
    if (review.verdict === 'changes_requested' || review.verdict === 'rejected') {
      return 'review-fail';
    }
    if (review.verdict === 'pending') return 'pause';
  }
  if (unmetDeps.length > 0) return 'blocked';
  return 'status';
}

function metaLine(sprint: Sprint, epic: Epic | undefined): string {
  const epicPart = epic ? `${epic.id} (${epic.status})` : sprint.epic_id;
  return `**Epic:** ${epicPart}  ·  **Lane:** ${sprint.lane}  ·  **Status:** ${sprint.status}`;
}

function reviewFailSection(review: Review): string {
  const lines: string[] = [];
  lines.push(`## Review failed`);
  lines.push('');
  lines.push(`Verdict: \`${review.verdict}\`  ·  Review: ${review.id}`);
  const latestRun = review.panel_runs?.[review.panel_runs.length - 1];
  if (latestRun) {
    lines.push('');
    lines.push(`Panel aggregate: **${latestRun.aggregate}** (round ${latestRun.round})`);
    lines.push('');
    lines.push('| Reviewer | Verdict |');
    lines.push('|---|---|');
    for (const r of latestRun.reviewers) {
      lines.push(`| ${r.reviewer_id} | ${r.verdict} |`);
    }
  }
  if (review.findings.length > 0) {
    lines.push('');
    lines.push(`### Findings (${review.findings.length})`);
    for (const f of review.findings) {
      lines.push(`- [${f.severity}] ${f.message}`);
    }
  }
  return lines.join('\n');
}

function readyToCloseSection(review: Review, sprintId: string): string {
  const lines: string[] = [];
  lines.push('## Ready to close');
  lines.push('');
  lines.push(`Review ${review.id} accepted. Sprint ${sprintId} can ship.`);
  return lines.join('\n');
}

function pauseSection(review: Review, sprint: Sprint): string {
  const lines: string[] = [];
  lines.push('## Awaiting review verdict');
  lines.push('');
  lines.push(`Review ${review.id} is pending for sprint ${sprint.id}.`);
  if (review.findings.length > 0) {
    lines.push('');
    lines.push(`Pre-existing findings: ${review.findings.length}`);
  }
  return lines.join('\n');
}

function blockedSection(unmetDeps: readonly string[], sprint: Sprint): string {
  const lines: string[] = [];
  lines.push('## Blocked');
  lines.push('');
  lines.push(`Sprint ${sprint.id} cannot start — unshipped dependencies:`);
  for (const dep of unmetDeps) {
    lines.push(`- ${dep}`);
  }
  if (sprint.gate) {
    lines.push('');
    lines.push(`Also blocked by gate: \`${sprint.gate}\``);
  }
  return lines.join('\n');
}

function statusSection(sprint: Sprint): string {
  const lines: string[] = [];
  lines.push('## Status');
  lines.push('');
  lines.push(`Sprint ${sprint.id} is currently \`${sprint.status}\`.`);
  if (sprint.depends_on.length > 0) {
    lines.push('');
    lines.push(`Depends on: ${sprint.depends_on.join(', ')}`);
  }
  return lines.join('\n');
}

function nextActionForSprint(gate: BriefGate, sprint: Sprint, review: Review | undefined): string {
  switch (gate) {
    case 'review-fail':
      return `rk fix --preview\n# review fixes, then:\nrk review-sprint ${sprint.id}`;
    case 'ready-to-close':
      return `rk close ${sprint.id}`;
    case 'pause':
      return `rk review-sprint ${sprint.id}`;
    case 'blocked':
      return `# ship blocking sprints first, then:\nrk start ${sprint.id}`;
    case 'status':
      if (
        sprint.status === 'planned' ||
        sprint.status === 'pending' ||
        sprint.status === 'queued'
      ) {
        return `rk start ${sprint.id}`;
      }
      if (sprint.status === 'active') {
        return review ? `rk review-sprint ${sprint.id}` : `rk review ${sprint.id}`;
      }
      if (sprint.status === 'review') return `rk review-sprint ${sprint.id}`;
      return `rk inspect ${sprint.id}`;
  }
}

export function renderSprintBrief(input: BriefSprintInput, gate: BriefGate): BriefOutput {
  const { sprint, epic, review, unmetDeps } = input;
  const lines: string[] = [];
  lines.push(`# Sprint ${sprint.id} — ${sprint.title}`);
  lines.push('');
  lines.push(metaLine(sprint, epic));
  lines.push('');

  switch (gate) {
    case 'review-fail':
      if (review) lines.push(reviewFailSection(review));
      else lines.push('## Review failed\n\n_(forced gate, but no review found)_');
      break;
    case 'ready-to-close':
      if (review) lines.push(readyToCloseSection(review, sprint.id));
      else lines.push('## Ready to close\n\n_(forced gate, but no review found)_');
      break;
    case 'pause':
      if (review) lines.push(pauseSection(review, sprint));
      else lines.push('## Awaiting review verdict\n\n_(forced gate, but no review found)_');
      break;
    case 'blocked':
      lines.push(blockedSection(unmetDeps, sprint));
      break;
    case 'status':
      lines.push(statusSection(sprint));
      break;
  }

  const nextAction = nextActionForSprint(gate, sprint, review);
  lines.push('');
  lines.push('## Suggested next action');
  lines.push('');
  lines.push('```bash');
  lines.push(nextAction);
  lines.push('```');

  return { markdown: `${lines.join('\n')}\n`, nextAction };
}

export function renderEpicBrief(input: BriefEpicInput): BriefOutput {
  const { epic, sprints, nextRunnable } = input;
  const total = sprints.length;
  const shipped = sprints.filter((s) => s.status === 'shipped').length;

  const lines: string[] = [];
  lines.push(`# Epic ${epic.id} — ${epic.title}`);
  lines.push('');
  lines.push(`**Status:** ${epic.status}  ·  **Progress:** ${shipped} / ${total} shipped`);
  lines.push('');
  lines.push('## Sprints');
  lines.push('');
  lines.push('| ID | Title | Lane | Status |');
  lines.push('|---|---|---|---|');
  for (const s of sprints) {
    lines.push(`| ${s.id} | ${s.title} | ${s.lane} | ${s.status} |`);
  }
  lines.push('');

  let nextAction: string;
  if (nextRunnable) {
    lines.push(`## Next runnable: ${nextRunnable.id} — ${nextRunnable.title}`);
    nextAction = `rk start ${nextRunnable.id}`;
  } else if (shipped === total && total > 0) {
    lines.push('## All sprints shipped');
    nextAction = `rk epic close ${epic.id}`;
  } else {
    lines.push('## No runnable sprint');
    nextAction = `rk next`;
  }
  lines.push('');
  lines.push('## Suggested next action');
  lines.push('');
  lines.push('```bash');
  lines.push(nextAction);
  lines.push('```');

  return { markdown: `${lines.join('\n')}\n`, nextAction };
}
