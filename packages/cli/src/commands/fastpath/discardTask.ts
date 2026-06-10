import { join, resolve } from 'node:path';
import {
  type Config,
  type EpicId,
  loadConfig,
  loadProject,
  RepoKernelError,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../../exitCodes.js';
import { stagePathsAndCommit } from '../../lifecycle/git.js';
import {
  mutateEpicFrontmatter,
  mutateSprintFrontmatter,
  removeSlotFromQueue,
} from '../../lifecycle/mutate.js';
import { withLifecycleScope } from '../../lifecycle/transaction.js';
import { releaseWorktree } from '../../lifecycle/worktree.js';
import { isoNow } from '../../templates/time.js';
import type { CommandResult } from '../validate.js';
import { resolveAlias } from './closeTask.js';
import { writeTaskAliasUpdate } from './taskAlias.js';
import type { TaskAlias } from './types.js';

export interface DiscardTaskOptions {
  readonly cwd: string;
  readonly taskId?: string;
}

/**
 * Discard a fastpath task. Cancels the sprint, releases the worktree, and
 * marks the alias as `cancelled`. Does not merge any commits into main.
 */
export async function runDiscardTaskCommand(opts: DiscardTaskOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  const cfg = await loadConfig({ cwd });
  if (!cfg.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml not found; run rk init first\n',
    };
  }
  const config = cfg.config;

  // Discard accepts a task in either 'review' or 'active' state. Try review
  // first (the most common case); fall back to active when not found.
  let resolved = await resolveAlias(cwd, config, opts.taskId, 'review');
  if (!resolved.ok) {
    resolved = await resolveAlias(cwd, config, opts.taskId, 'active');
  }
  if (!resolved.ok) return resolved.error;
  const alias = resolved.alias;

  if (alias.status === 'shipped' || alias.status === 'cancelled') {
    return blocked(`${alias.id} is already ${alias.status}`);
  }

  const outcome = await loadProject({ cwd });
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'project failed to load; run rk validate to see findings\n',
    };
  }
  const sprint = outcome.graph.sprints.get(alias.sprint_id);
  if (!sprint) {
    return blocked(`sprint ${alias.sprint_id} not found (alias ${alias.id} is stale)`);
  }

  const touched: string[] = [];
  let worktreeReleased = false;
  try {
    await withLifecycleScope(
      { cwd, command: 'fastpath-discard', args: { taskId: alias.id, sprintId: alias.sprint_id } },
      async (tx) => {
        // Mark sprint cancelled.
        await mutateSprintFrontmatter(join(cwd, sprint.file), {
          status: 'cancelled',
          closed_at: isoNow(),
        });
        touched.push(sprint.file);

        // Cancel the synthesized epic too — fastpath epics own exactly one sprint.
        const epic = outcome.graph.epics.get(alias.epic_id);
        if (epic && epic.sprints.length === 1 && epic.sprints[0] === alias.sprint_id) {
          await mutateEpicFrontmatter(join(cwd, epic.file), { status: 'cancelled' });
          touched.push(epic.file);
        }

        // Remove the slot from the queue (if still present).
        const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
        if (queue) {
          const stillQueued = queue.slots.some((s) => s.sprint_id === alias.sprint_id);
          if (stillQueued) {
            const removed = await removeSlotFromQueue(
              join(cwd, queue.file),
              alias.sprint_id,
              tx.opRoot,
              sprint.lane,
            );
            if (removed.kind === 'removed') {
              touched.push(queue.file);
            }
          }
        }

        await tx.refreshRegistry();
        touched.push(config.paths.registry);

        const updated: TaskAlias = {
          ...alias,
          status: 'cancelled',
          closed_at: new Date().toISOString(),
        };
        await writeTaskAliasUpdate(cwd, config, updated);
        touched.push(join(config.paths.generated, 'tasks', `${alias.id}.json`));
      },
    );

    worktreeReleased = await releaseEpicWorktreeBestEffort(cwd, config, alias.epic_id);

    // Commit all the discard-side metadata so the working tree stays clean.
    await stagePathsAndCommit(cwd, touched, `chore(rk): discard ${alias.id}`);
  } catch (cause) {
    return runtimeErr(cause);
  }

  const worktreeLine = worktreeReleased
    ? `  ${pc.bold('Worktree')}  released`
    : `  ${pc.bold('Worktree')}  ${pc.yellow('NOT released')} — clean up later with rk lane release`;

  const stdout = [
    `${pc.bold(`Discarded ${alias.id}`)} — ${alias.title}`,
    '',
    `  ${pc.bold('Sprint')}    ${alias.sprint_id} (status → cancelled)`,
    `  ${pc.bold('Epic')}      ${alias.epic_id} (status → cancelled)`,
    worktreeLine,
    '',
  ].join('\n');

  return { exitCode: EXIT_OK, stdout: `${stdout}\n`, stderr: '' };
}

async function releaseEpicWorktreeBestEffort(
  cwd: string,
  config: Config,
  epicId: EpicId,
): Promise<boolean> {
  try {
    await releaseWorktree(epicId, config, cwd);
    return true;
  } catch {
    // Releasing is best-effort. Lingering worktrees can be cleaned up
    // later with `rk lane release`. Return false so the caller can surface
    // the failure in the command output instead of misleading the user.
    return false;
  }
}

function blocked(message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${lines.join('\n')}\n` };
}

function runtimeErr(cause: unknown): CommandResult {
  if (cause instanceof RepoKernelError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${cause.message}\n` };
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${msg}\n` };
}
