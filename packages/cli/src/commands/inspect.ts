import { loadProject, RepoKernelError, type Sprint } from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { findEntity } from '../ux/entities.js';
import type { CommandResult } from './validate.js';

export interface InspectCommandOptions {
  readonly cwd: string;
  readonly id: string;
  readonly json?: boolean;
}

export async function runInspectCommand(opts: InspectCommandOptions): Promise<CommandResult> {
  const json = opts.json === true;
  try {
    const outcome = await loadProject({ cwd: opts.cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: 'project config is invalid; run rk validate\n',
      };
    }

    const entity = findEntity(outcome, opts.id);
    if (!entity) {
      return entityNotFound(opts.id, json);
    }

    if (entity.type === 'sprint') {
      const sprint = outcome.graph.sprints.get(entity.id);
      if (!sprint) return entityNotFound(opts.id, json);
      if (json) return okJson({ schemaVersion: 1, entityType: 'sprint', entity: sprint });
      return ok(formatSprint(outcome, sprint));
    }
    if (entity.type === 'epic') {
      const epic = outcome.graph.epics.get(entity.id);
      if (!epic) return entityNotFound(opts.id, json);
      if (json) return okJson({ schemaVersion: 1, entityType: 'epic', entity: epic });
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
      const review = outcome.graph.reviews.get(entity.id);
      if (!review) return entityNotFound(opts.id, json);
      if (json) return okJson({ schemaVersion: 1, entityType: 'review', entity: review });
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
      const queue = outcome.parsed.queues.find((q) => q.lane === entity.id);
      if (!queue) return entityNotFound(opts.id, json);
      if (json) return okJson({ schemaVersion: 1, entityType: 'queue', entity: queue });
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

    const lane = outcome.graph.lanes.get(entity.id);
    if (!lane) return entityNotFound(opts.id, json);
    if (json) return okJson({ schemaVersion: 1, entityType: 'lane', entity: lane });
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

function entityNotFound(id: string, json: boolean): CommandResult {
  if (json) {
    return {
      exitCode: EXIT_FINDINGS,
      stdout: emitJson({ schemaVersion: 1, error: `entity not found: ${id}` }) + '\n',
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_FINDINGS,
    stdout: `entity not found: ${id}\n\nTry:\n  rk status\n  rk validate\n`,
    stderr: '',
  };
}

function okJson(value: unknown): CommandResult {
  return { exitCode: EXIT_OK, stdout: emitJson(value) + '\n', stderr: '' };
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
