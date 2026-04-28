import { join, resolve } from 'node:path';
import { loadConfig, RepoKernelError, type SprintId } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { allocateReviewIds } from '../lifecycle/reviewAlloc.js';
import type { CommandResult } from './validate.js';

export interface ReviewAllocateOptions {
  readonly cwd: string;
  readonly sprintIds: readonly string[];
  readonly json: boolean;
}

/**
 * Public CLI surface for the locked review-id allocator.
 *
 * Worktree agents that need a review ID outside `rk run` should call this
 * instead of rolling their own — `rk run` already pre-allocates correctly via
 * the same path. The lock + counter file at the operational root keep
 * concurrent worktrees on the same repo collision-free.
 */
export async function runReviewAllocateCommand(
  opts: ReviewAllocateOptions,
): Promise<CommandResult> {
  if (opts.sprintIds.length === 0) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: 'review allocate: at least one --sprint <id> is required\n',
    };
  }

  const cwd = resolve(opts.cwd);

  let configResult: Awaited<ReturnType<typeof loadConfig>>;
  try {
    configResult = await loadConfig({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!configResult.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml is invalid; run rk validate for details\n',
    };
  }

  const reviewsDir = join(configResult.cwd, configResult.config.paths.reviews);
  const opRoot = await operationalRootBestEffort(configResult.cwd);

  const allocations = await allocateReviewIds(
    opts.sprintIds as readonly SprintId[],
    reviewsDir,
    opRoot,
  );

  const rows = opts.sprintIds.map((sprintId) => ({
    sprintId,
    reviewId: allocations.get(sprintId as SprintId) ?? null,
  }));

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ allocations: rows }),
      stderr: '',
    };
  }

  const lines = rows.map((r) => `${r.reviewId ?? '(none)'}  ${r.sprintId}`);
  return {
    exitCode: EXIT_OK,
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
  };
}
