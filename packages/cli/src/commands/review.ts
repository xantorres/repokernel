import { join, resolve } from 'node:path';
import { loadProject, RepoKernelError, resolveReviewerGate, SPRINT_ID_RE } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_RUNTIME } from '../exitCodes.js';
import { mutateReviewFrontmatter } from '../lifecycle/mutate.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import { isoNow } from '../templates/time.js';
import { runReviewerGateForLinkedSprint } from './reviewGate.js';
import type { CommandResult } from './validate.js';

export interface ReReviewCommandOptions {
  readonly cwd: string;
  readonly sprintId: string;
  readonly json: boolean;
}

/**
 * `rk re-review S-NNN` — reset the verdict to pending (so a prior accepted /
 * rejected does not linger if the gate now blocks) and re-run the reviewer
 * gate, which increments `review_attempt` on completion.
 */
export async function runReReviewCommand(opts: ReReviewCommandOptions): Promise<CommandResult> {
  if (!SPRINT_ID_RE.test(opts.sprintId)) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `re-review: invalid sprint id "${opts.sprintId}" (expected S-NNN)\n`,
    };
  }
  const cwd = resolve(opts.cwd);

  let outcome: Awaited<ReturnType<typeof loadProject>>;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml is invalid; run rk validate for details\n',
    };
  }

  if (!resolveReviewerGate(outcome.config.automation)) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr:
        'no reviewer gate configured\n  Hint: set automation.defaultReviewer to a key under automation.reviewers\n',
    };
  }
  const sprint = outcome.graph.sprints.get(opts.sprintId);
  if (!sprint) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `re-review: sprint not found: ${opts.sprintId}\n`,
    };
  }
  if (sprint.status !== 'review') {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `re-review requires status review (got: ${sprint.status})\n  Hint: run rk review ${opts.sprintId} first\n`,
    };
  }
  if (!sprint.review_id) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `${opts.sprintId} has no review_id\n  Hint: run rk review ${opts.sprintId} first\n`,
    };
  }
  const review = outcome.graph.reviews.get(sprint.review_id);
  if (!review) {
    return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `review ${sprint.review_id} not found\n` };
  }

  await withLifecycleScope(
    { cwd: outcome.cwd, command: 're-review', args: { sprintId: opts.sprintId } },
    async (tx) => {
      await mutateReviewFrontmatter(join(outcome.cwd, review.file), {
        verdict: 'pending',
        updated_at: isoNow(),
      });
      await tx.refreshRegistry();
    },
  );

  return runReviewerGateForLinkedSprint(cwd, opts.sprintId, { json: opts.json });
}
