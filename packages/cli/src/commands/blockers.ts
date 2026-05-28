import { resolve } from 'node:path';
import { loadProject, materialPathGlobs, RepoKernelError } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { classifySprintDiff, type SprintBlocker } from '../lifecycle/diffClassifier.js';
import { changedFilesForSprint } from '../lifecycle/git.js';
import type { CommandResult } from './validate.js';

export interface BlockersCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
}

export async function runBlockersCommand(
  sprintId: string,
  opts: BlockersCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();
    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) {
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `sprint not found: ${sprintId}\n` };
    }

    let blockers: readonly SprintBlocker[] = [];
    let warnings: readonly SprintBlocker[] = [];
    if (!sprint.base_sha) {
      blockers = [
        {
          category: 'missing_base_sha',
          scope: 'environment',
          paths: [sprint.file],
          owner: 'environment',
          next_actions: [`rk inspect ${sprint.id}`],
        },
      ];
    } else {
      const reviewFile =
        sprint.review_id !== undefined
          ? outcome.graph.reviews.get(sprint.review_id)?.file
          : undefined;
      const changed = await changedFilesForSprint(cwd, sprint.base_sha);
      const classification = classifySprintDiff({
        config: outcome.config,
        sprint,
        changed,
        exemptPaths: [
          sprint.file,
          outcome.config.paths.registry,
          `${outcome.config.paths.queues}/${sprint.lane}.md`,
          ...(reviewFile !== undefined ? [reviewFile] : []),
        ],
        ...(reviewFile !== undefined ? { reviewFile } : {}),
        rkOwnedGlobs: materialPathGlobs(outcome.config),
      });
      blockers = classification.blockers;
      warnings = classification.warnings;
    }

    const ok = blockers.length === 0;
    const payload = {
      ok,
      sprint_id: sprint.id,
      blockers,
      warnings,
      next_actions: [...new Set(blockers.flatMap((blocker) => blocker.next_actions))],
    };
    if (opts.json) {
      return {
        exitCode: ok ? EXIT_OK : EXIT_BLOCKED,
        stdout: emitJson(payload),
        stderr: '',
      };
    }
    return {
      exitCode: ok ? EXIT_OK : EXIT_BLOCKED,
      stdout: renderText(payload),
      stderr: '',
    };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function renderText(payload: {
  readonly ok: boolean;
  readonly sprint_id: string;
  readonly blockers: readonly SprintBlocker[];
  readonly warnings: readonly SprintBlocker[];
  readonly next_actions: readonly string[];
}): string {
  const lines = [`Blockers ${payload.sprint_id}`, ''];
  if (payload.blockers.length === 0) {
    lines.push('No durable blockers.');
  } else {
    for (const blocker of payload.blockers) {
      lines.push(`${blocker.category}: ${blocker.paths.join(', ')}`);
    }
  }
  if (payload.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of payload.warnings) {
      lines.push(`${warning.category}: ${warning.paths.join(', ')}`);
    }
  }
  if (payload.next_actions.length > 0) {
    lines.push('', 'Next:');
    for (const action of payload.next_actions) lines.push(`  ${action}`);
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
