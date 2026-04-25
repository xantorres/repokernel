import { loadProject, RepoKernelError, type Sprint } from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { findEntity } from '../ux/entities.js';
import type { CommandResult } from './validate.js';

export interface InspectCommandOptions {
  readonly cwd: string;
  readonly id: string;
}

export async function runInspectCommand(opts: InspectCommandOptions): Promise<CommandResult> {
  try {
    const outcome = await loadProject({ cwd: opts.cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: 'project config is invalid; run repokernel validate\n',
      };
    }

    const entity = findEntity(outcome, opts.id);
    if (!entity) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `entity not found: ${opts.id}\n` };
    }

    if (entity.type === 'sprint') {
      return ok(formatSprint(outcome, outcome.graph.sprints.get(entity.id)!));
    }
    if (entity.type === 'epic') {
      const epic = outcome.graph.epics.get(entity.id)!;
      const lines = [
        `${epic.id}: ${epic.title}`,
        '',
        `Status: ${epic.status}`,
        `File:   ${epic.file}`,
        '',
      ];
      lines.push('Sprints:');
      if (epic.sprints.length === 0) {
        lines.push('  none');
      } else {
        for (const id of epic.sprints) {
          const sprint = outcome.graph.sprints.get(id);
          lines.push(`  ${id}${sprint ? ` ${sprint.status}` : ' missing'}`);
        }
      }
      return ok(lines);
    }
    if (entity.type === 'review') {
      const review = outcome.graph.reviews.get(entity.id)!;
      const sprint = outcome.graph.sprints.get(review.sprint_id);
      return ok([
        `${review.id}: Review ${review.sprint_id}`,
        '',
        `Verdict:   ${review.verdict}`,
        `Reviewer:  ${review.reviewer}`,
        `Sprint:    ${review.sprint_id}${sprint ? ` ${sprint.status}` : ' missing'}`,
        `Base SHA:  ${review.base_sha ?? '-'}`,
        `End SHA:   ${review.end_sha ?? '-'}`,
        `File:      ${review.file}`,
      ]);
    }
    if (entity.type === 'queue') {
      const queue = outcome.parsed.queues.find((q) => q.lane === entity.id)!;
      const lines = [`Queue: ${queue.lane}`, '', `File: ${queue.file}`, '', 'Slots:'];
      if (queue.slots.length === 0) {
        lines.push('  none');
      } else {
        for (const slot of [...queue.slots].sort((a, b) => a.order - b.order)) {
          const sprint = outcome.graph.sprints.get(slot.sprint_id);
          lines.push(
            `  ${slot.order}. ${slot.sprint_id}${sprint ? ` ${sprint.status}` : ' missing'}`,
          );
        }
      }
      return ok(lines);
    }

    const lane = outcome.graph.lanes.get(entity.id)!;
    const slots = outcome.graph.queuesByLane.get(entity.id) ?? [];
    const lines = [
      `Lane: ${lane.name}`,
      '',
      `Source: ${entity.file ?? 'inferred'}`,
      `Queue slots: ${slots.length}`,
    ];
    return ok(lines);
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function formatSprint(
  project: Extract<Awaited<ReturnType<typeof loadProject>>, { ok: true }>,
  sprint: Sprint,
): string[] {
  const lines = [`${sprint.id}: ${sprint.title}`, ''];
  lines.push(`Status:      ${sprint.status}`);
  lines.push(`Epic:        ${sprint.epic_id}`);
  lines.push(`Lane:        ${sprint.lane}`);
  lines.push(`Started at:  ${sprint.started_at ?? '-'}`);
  lines.push(`Base SHA:    ${sprint.base_sha ?? '-'}`);
  lines.push(`File:        ${sprint.file}`);
  lines.push('', 'Dependencies:');
  if (sprint.depends_on.length === 0) {
    lines.push('  none');
  } else {
    for (const dep of sprint.depends_on) {
      const depSprint = project.graph.sprints.get(dep);
      lines.push(`  ${dep} ${depSprint?.status ?? 'missing'}`);
    }
  }
  lines.push('', 'Review:');
  const reviews = project.graph.reviewsBySprint.get(sprint.id) ?? [];
  if (!sprint.review_required) {
    lines.push('  not required');
  } else if (sprint.review_id) {
    const review = project.graph.reviews.get(sprint.review_id);
    lines.push(`  required, ${sprint.review_id}${review ? ` ${review.verdict}` : ' missing'}`);
  } else if (reviews.length > 0) {
    lines.push(`  required, ${reviews.join(', ')}`);
  } else {
    lines.push('  required, not created yet');
  }
  lines.push('', 'Path policy:');
  appendList(lines, 'allowed', sprint.allowed_paths);
  appendList(lines, 'denied', sprint.denied_paths);
  appendList(lines, 'generated', sprint.generated_paths);
  return lines;
}

function appendList(lines: string[], label: string, values: readonly string[]): void {
  lines.push(`  ${label}:`);
  if (values.length === 0) {
    lines.push('    none');
  } else {
    for (const value of values) lines.push(`    ${value}`);
  }
}

function ok(lines: readonly string[]): CommandResult {
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
