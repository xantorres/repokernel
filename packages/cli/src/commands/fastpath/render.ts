import pc from 'picocolors';
import type { TaskAlias } from './types.js';

/**
 * Re-frame a CommandResult's stdout to use Task T-NNN terminology instead of
 * the underlying Sprint S-NNN. This is a thin string-replacement layer so the
 * fastpath UX feels coherent without changing how the engine reports.
 *
 * We only translate IDs that map to the synthesized sprint; epic/run IDs are
 * left intact (they're internal anyway and rarely surface to fastpath users).
 */
export function reframeRunOutput(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly alias: TaskAlias;
}): { readonly stdout: string; readonly stderr: string } {
  return {
    stdout: replaceSprintRef(input.stdout, input.alias),
    stderr: replaceSprintRef(input.stderr, input.alias),
  };
}

function replaceSprintRef(text: string, alias: TaskAlias): string {
  if (text.length === 0) return text;
  // Only reframe standalone references — never inside paths or words. The
  // negative lookbehind/lookahead keep things like ".repokernel/plan/sprints/S-001.md"
  // intact while still translating "Sprint S-001" headings or bullet entries.
  const sprintIdRe = new RegExp(`(?<![/\\w])${escapeRegex(alias.sprint_id)}(?![\\w/])`, 'g');
  return text.replace(sprintIdRe, alias.id);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface TaskSummary {
  readonly alias: TaskAlias;
  readonly status: 'review' | 'active' | 'shipped' | 'cancelled';
  readonly checksPassed: boolean | null;
  readonly worktreePath?: string;
  readonly nextHints: readonly string[];
}

/**
 * Format a concise post-run summary in the fastpath voice. Used after the
 * underlying runRunCommand returns. Caller decides what to show, this just
 * provides consistent formatting.
 */
export function formatTaskSummary(summary: TaskSummary): string {
  const lines: string[] = [];
  lines.push(`${pc.bold('Task:')}     ${summary.alias.id} — ${summary.alias.title}`);
  if (summary.worktreePath) {
    lines.push(`${pc.bold('Worktree:')} ${summary.worktreePath}`);
  }
  if (summary.checksPassed !== null) {
    const tag = summary.checksPassed ? pc.green('passed') : pc.red('failed');
    lines.push(`${pc.bold('Checks:')}   ${tag}`);
  }
  lines.push(`${pc.bold('Status:')}   ${formatStatus(summary.status)}`);
  if (summary.nextHints.length > 0) {
    lines.push('', 'Next:');
    for (const hint of summary.nextHints) lines.push(`  ${pc.dim(hint)}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatStatus(status: TaskSummary['status']): string {
  switch (status) {
    case 'review':
      return pc.yellow('review');
    case 'active':
      return pc.cyan('active');
    case 'shipped':
      return pc.green('shipped');
    case 'cancelled':
      return pc.dim('cancelled');
  }
}
