import { join, resolve } from 'node:path';
import { effectiveReviewer, loadConfig, RepoKernelError, SPRINT_ID_RE } from '@repokernel/core';
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

  // Validate at the CLI boundary instead of trusting the cast: a stray
  // E-NNN or T-NNN argument would otherwise allocate a stub against a
  // non-sprint and make the validator unhappy on the next run.
  const invalid = opts.sprintIds.filter((id) => !SPRINT_ID_RE.test(id));
  if (invalid.length > 0) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `review allocate: invalid sprint id(s): ${invalid.join(', ')} (expected S-NNN)\n`,
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
    opts.sprintIds,
    reviewsDir,
    opRoot,
    effectiveReviewer(configResult.config.automation),
  );

  const rows = opts.sprintIds.map((sprintId) => {
    const allocation = allocations.get(sprintId);
    return {
      sprintId,
      reviewId: allocation?.reviewId ?? null,
      reused: allocation?.reused ?? false,
    };
  });

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ allocations: rows }),
      stderr: '',
    };
  }

  const lines = rows.map(
    (r) => `${r.reviewId ?? '(none)'}  ${r.sprintId}${r.reused ? '  (reused)' : ''}`,
  );
  return {
    exitCode: EXIT_OK,
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
  };
}
