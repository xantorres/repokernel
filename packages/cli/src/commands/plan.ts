import { resolve } from 'node:path';
import { loadProject, RepoKernelError } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { runCreateSprintCommand } from './create.js';
import type { CommandResult } from './validate.js';

export interface PlanCommandOptions {
  readonly cwd: string;
  readonly createSprint: boolean;
  readonly enqueue: boolean;
  readonly singleSprint: boolean;
  readonly split: boolean;
  readonly noSprint: boolean;
  readonly allowedPaths: readonly string[];
  readonly yes: boolean;
  readonly json: boolean;
}

export async function runPlanCommand(
  epicId: string,
  opts: PlanCommandOptions,
): Promise<CommandResult> {
  const modeCount = [opts.singleSprint, opts.split, opts.noSprint].filter(Boolean).length;
  if (modeCount > 1) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: '--single-sprint, --split, and --no-sprint are mutually exclusive\n',
    };
  }

  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();
    const epic = outcome.graph.epics.get(epicId);
    if (!epic) return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `epic not found: ${epicId}\n` };

    const mode = opts.noSprint
      ? 'none'
      : opts.singleSprint
        ? 'single'
        : opts.split || isBroadEpic(epic.body)
          ? 'split'
          : 'single';
    if (!opts.createSprint || mode !== 'single') {
      const payload = {
        epicId,
        mode,
        createSprint: false,
        enqueue: opts.enqueue,
        proposed: mode === 'split' ? proposedSplit(epic.title, opts.allowedPaths) : [],
        commands:
          mode === 'single'
            ? [
                `rk plan ${epicId} --create-sprint${opts.enqueue ? ' --enqueue' : ''} --single-sprint`,
              ]
            : [],
      };
      return opts.json
        ? { exitCode: EXIT_OK, stdout: emitJson(payload), stderr: '' }
        : { exitCode: EXIT_OK, stdout: formatPreview(payload), stderr: '' };
    }

    const body = sprintBodyFromEpic(epicId, epic.title, epic.body);
    const created = await runCreateSprintCommand(epic.title, {
      cwd,
      epic: epicId,
      lane: outcome.config.policies.defaultLane,
      status: 'planned',
      allowedPaths: opts.allowedPaths,
      body,
      enqueue: opts.enqueue,
      json: true,
    });
    if (created.exitCode !== 0) return created;
    const obj = JSON.parse(created.stdout) as { id: string; file: string; updated: string[] };
    const payload = {
      epicId,
      mode: 'single',
      sprintId: obj.id,
      file: obj.file,
      enqueue: opts.enqueue,
      updated: obj.updated,
    };
    return opts.json
      ? { exitCode: EXIT_OK, stdout: emitJson(payload), stderr: '' }
      : {
          exitCode: EXIT_OK,
          stdout: `Planned ${epicId}\n  Sprint: ${obj.id}\n  Enqueued: ${opts.enqueue ? 'yes' : 'no'}\n`,
          stderr: '',
        };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function isBroadEpic(body: string): boolean {
  const bullets = body.split('\n').filter((line) => /^\s*[-*]\s+/.test(line)).length;
  return body.length > 1500 || bullets > 8;
}

function proposedSplit(title: string, allowedPaths: readonly string[]): string[] {
  const scope = allowedPaths.length > 0 ? ` (${allowedPaths.join(', ')})` : '';
  return [`${title}: foundation${scope}`, `${title}: integration${scope}`];
}

function sprintBodyFromEpic(epicId: string, title: string, body: string): string {
  const source = body.trim().length > 0 ? body.trim() : `# ${epicId}: ${title}`;
  return `# ${title}

## Objective

${source}

## Acceptance criteria

- [ ] Implement the scoped epic work.
- [ ] \`rk gates <SPRINT_ID>\` passes before ship.
`;
}

function formatPreview(payload: {
  readonly epicId: string;
  readonly mode: string;
  readonly proposed: readonly string[];
  readonly commands: readonly string[];
}): string {
  const lines = [`Plan ${payload.epicId}`, '', `Mode: ${payload.mode}`];
  if (payload.proposed.length > 0) {
    lines.push('', 'Proposed split:', ...payload.proposed.map((p) => `  - ${p}`));
  }
  if (payload.commands.length > 0) {
    lines.push('', 'Apply:', ...payload.commands.map((c) => `  ${c}`));
  }
  return `${lines.join('\n')}\n`;
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}
