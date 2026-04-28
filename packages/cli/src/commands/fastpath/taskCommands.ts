import { join, resolve } from 'node:path';
import { loadConfig, loadProject } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../../exitCodes.js';
import { renderTable, truncate } from '../../format/table.js';
import type { CommandResult } from '../validate.js';
import { listTaskAliases, readTaskAlias } from './taskAlias.js';
import { normalizeTaskId } from './taskId.js';
import type { TaskAlias } from './types.js';

const TASK_STATUSES: ReadonlySet<TaskAlias['status']> = new Set([
  'active',
  'review',
  'shipped',
  'cancelled',
]);

export interface TaskListOptions {
  readonly cwd: string;
  readonly status?: TaskAlias['status'];
  readonly json: boolean;
}

export interface TaskStatusOptions {
  readonly cwd: string;
  readonly json: boolean;
}

export interface TaskInspectOptions {
  readonly cwd: string;
  readonly json: boolean;
}

export async function runTaskListCommand(opts: TaskListOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  const cfg = await loadConfig({ cwd });
  if (!cfg.ok) return configError();

  if (opts.status !== undefined && !TASK_STATUSES.has(opts.status)) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `error: invalid --status value "${opts.status}"; expected one of ${[...TASK_STATUSES].join('|')}\n`,
    };
  }

  const aliases = await listTaskAliases(cwd, cfg.config);
  const filtered =
    opts.status !== undefined ? aliases.filter((a) => a.status === opts.status) : aliases;

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify(filtered, null, 2)}\n`,
      stderr: '',
    };
  }

  if (filtered.length === 0) {
    const msg = opts.status !== undefined ? `(no tasks in status "${opts.status}")` : '(no tasks)';
    return { exitCode: EXIT_OK, stdout: `${msg}\n`, stderr: '' };
  }

  const rows = filtered.map((a) => ({
    id: a.id,
    status: colorTaskStatus(a.status),
    epic: a.epic_id,
    sprint: a.sprint_id,
    title: truncate(a.title, 50),
  }));

  const out = renderTable(rows, [
    { key: 'id', header: 'ID' },
    { key: 'status', header: 'STATUS' },
    { key: 'epic', header: 'EPIC' },
    { key: 'sprint', header: 'SPRINT' },
    { key: 'title', header: 'TITLE' },
  ]);

  return { exitCode: EXIT_OK, stdout: `${out}\n`, stderr: '' };
}

export async function runTaskStatusCommand(
  taskIdInput: string,
  opts: TaskStatusOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  const id = normalizeTaskId(taskIdInput);
  if (!id) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `error: ${taskIdInput} is not a valid task ID (expected T-NNN)\n`,
    };
  }

  const cfg = await loadConfig({ cwd });
  if (!cfg.ok) return configError();

  const alias = await readTaskAlias(cwd, cfg.config, id);
  if (!alias) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `error: no task alias found for ${id} — run \`rk task list\` to see available tasks\n`,
    };
  }

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify(alias, null, 2)}\n`,
      stderr: '',
    };
  }

  const lines = [
    `${pc.bold(alias.id)}  ${alias.title}`,
    '',
    `  ${pc.bold('Status')}      ${colorTaskStatus(alias.status)}`,
    `  ${pc.bold('Epic')}        ${alias.epic_id}`,
    `  ${pc.bold('Sprint')}      ${alias.sprint_id}`,
    `  ${pc.bold('Source')}      ${alias.source}`,
    `  ${pc.bold('Created')}     ${alias.created_at}`,
  ];
  if (alias.closed_at) {
    lines.push(`  ${pc.bold('Closed')}      ${alias.closed_at}`);
  }
  if (alias.review_sha) {
    lines.push(`  ${pc.bold('Review SHA')}  ${alias.review_sha.slice(0, 12)}`);
  }
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

export async function runTaskInspectCommand(
  taskIdInput: string,
  opts: TaskInspectOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  const id = normalizeTaskId(taskIdInput);
  if (!id) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `error: ${taskIdInput} is not a valid task ID (expected T-NNN)\n`,
    };
  }

  const cfg = await loadConfig({ cwd });
  if (!cfg.ok) return configError();

  const alias = await readTaskAlias(cwd, cfg.config, id);
  if (!alias) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `error: no task alias found for ${id} — run \`rk task list\` to see available tasks\n`,
    };
  }

  // Resolve sprint + review file paths from the live project graph if it
  // loads. If the project fails to load (broken config, etc.) we fall back to
  // alias-only output rather than 500'ing — inspect is a diagnostic surface.
  const project = await loadProject({ cwd });
  const sprintFile = project.ok ? (project.graph.sprints.get(alias.sprint_id)?.file ?? null) : null;
  const reviewId = project.ok
    ? (project.graph.sprints.get(alias.sprint_id)?.review_id ?? null)
    : null;
  const reviewFile =
    project.ok && reviewId ? (project.graph.reviews.get(reviewId)?.file ?? null) : null;
  const aliasFile = join(cfg.config.paths.generated, 'tasks', `${alias.id}.json`);

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify(
        {
          alias,
          paths: {
            alias: aliasFile,
            sprint: sprintFile,
            review: reviewFile,
          },
        },
        null,
        2,
      )}\n`,
      stderr: '',
    };
  }

  const lines = [
    `${pc.bold(alias.id)}  ${alias.title}`,
    '',
    `  ${pc.bold('Status')}      ${colorTaskStatus(alias.status)}`,
    `  ${pc.bold('Epic')}        ${alias.epic_id}`,
    `  ${pc.bold('Sprint')}      ${alias.sprint_id}`,
    `  ${pc.bold('Source')}      ${alias.source}`,
    `  ${pc.bold('Created')}     ${alias.created_at}`,
  ];
  if (alias.closed_at) {
    lines.push(`  ${pc.bold('Closed')}      ${alias.closed_at}`);
  }
  if (alias.review_sha) {
    lines.push(`  ${pc.bold('Review SHA')}  ${alias.review_sha.slice(0, 12)}`);
  }
  lines.push('');
  lines.push('Files:');
  lines.push(`  ${pc.bold('alias')}    ${aliasFile}`);
  lines.push(`  ${pc.bold('sprint')}   ${sprintFile ?? '(not found)'}`);
  lines.push(`  ${pc.bold('review')}   ${reviewFile ?? '(none)'}`);

  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function colorTaskStatus(status: TaskAlias['status']): string {
  switch (status) {
    case 'active':
      return pc.cyan(status);
    case 'review':
      return pc.yellow(status);
    case 'shipped':
      return pc.green(status);
    case 'cancelled':
      return pc.gray(status);
  }
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}
