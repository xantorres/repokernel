import { join, resolve } from 'node:path';
import {
  effectiveReviewer,
  loadProject,
  RepoKernelError,
  SPRINT_ID_RE,
  type SprintId,
} from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { ambientJournalWrite } from '../lifecycle/journal.js';
import { mutateSprintFrontmatter } from '../lifecycle/mutate.js';
import { allocateReviewIds } from '../lifecycle/reviewAlloc.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import type { CommandResult } from './validate.js';

export interface ReviewCreateOptions {
  readonly cwd: string;
  readonly sprintId: string;
  readonly json: boolean;
  /** Override the stamped reviewer; falls back to automation.reviewer/defaultReviewer when unset. */
  readonly reviewer?: string;
}

function buildRichScaffold(reviewId: string, sprintId: string, reviewer: string): string {
  const now = new Date().toISOString();
  return `---
id: ${reviewId}
sprint_id: ${sprintId}
verdict: pending
reviewer: ${JSON.stringify(reviewer)}
findings: []  # LEAVE EMPTY — populate causes REVIEW_INVALID_FINDING_SHAPE (P0). All finding detail goes in the body markdown below.
created_at: ${now}
changed_files: []
paths_checked:
  denied_paths_clean: true
---

# ${reviewId}: Review ${sprintId}

## Summary

<!-- Brief description of what was reviewed and the overall assessment. -->

## Findings

<!-- Add individual findings below. Format:
- severity: CRITICAL | HIGH | MEDIUM | LOW
  message: "Description of the issue"
-->

## Verdict

<!-- Set the \`verdict\` frontmatter field to one of:
  accepted           - review passed, sprint can ship
  changes_requested  - issues found, needs rework
  rejected           - major issues, sprint must not proceed
-->
`;
}

/**
 * Allocate a review id for the target sprint and write the rich scaffold —
 * both inside a single lifecycle scope, both via `ambientJournalAtomicCreate`
 * so a kill mid-flight leaves nothing half-written. The previous flow
 * allocated under journal but wrote the scaffold via plain `writeFile`,
 * which meant a crash between allocation and scaffold write would orphan
 * the review id in the allocator state.
 */
export async function runReviewCreateCommand(opts: ReviewCreateOptions): Promise<CommandResult> {
  if (!SPRINT_ID_RE.test(opts.sprintId)) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `review-create: invalid sprint id "${opts.sprintId}" (expected S-NNN)\n`,
    };
  }

  if (opts.reviewer !== undefined && opts.reviewer.trim() === '') {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: 'review-create: --reviewer must be a non-empty name\n',
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

  const sprint = outcome.graph.sprints.get(opts.sprintId);
  if (!sprint) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: `review-create: sprint not found: ${opts.sprintId}\n`,
    };
  }

  const reviewsDir = join(outcome.cwd, outcome.config.paths.reviews);
  const reviewer = opts.reviewer ?? effectiveReviewer(outcome.config.automation);

  let reviewId = '';
  let filePath = '';
  let reused = false;
  let linked = false;

  await withLifecycleScope(
    {
      cwd: outcome.cwd,
      command: 'review-create',
      args: { sprintId: opts.sprintId },
    },
    async (tx) => {
      const current = await tx.reloadProject();
      if (!current.ok) {
        throw new RepoKernelError('CONFIG_INVALID', 'project failed to load; run rk validate');
      }
      const currentSprint = current.graph.sprints.get(opts.sprintId);
      if (currentSprint === undefined) {
        throw new RepoKernelError('CONFIG_INVALID', `sprint not found: ${opts.sprintId}`);
      }
      const existingLinkedReview =
        currentSprint.review_id !== undefined
          ? current.graph.reviews.get(currentSprint.review_id)
          : undefined;
      if (existingLinkedReview !== undefined) {
        reviewId = existingLinkedReview.id;
        filePath = join(outcome.cwd, existingLinkedReview.file);
        reused = true;
      } else {
        const allocations = await allocateReviewIds(
          [opts.sprintId as SprintId],
          reviewsDir,
          tx.opRoot,
          reviewer,
        );
        const alloc = allocations.get(opts.sprintId as SprintId);
        if (!alloc) {
          throw new RepoKernelError(
            'INTERNAL',
            `review-create: allocation failed for ${opts.sprintId}`,
          );
        }
        reviewId = alloc.reviewId;
        filePath = join(reviewsDir, `${reviewId}.md`);
        reused = alloc.reused;
        if (!alloc.reused) {
          // allocateReviewIds already wrote a minimal stub via atomicCreateText
          // (so the EEXIST-on-link semantics that gate id allocation hold).
          // Overwrite that stub with the rich authoring scaffold under the
          // same lifecycle scope so recovery can replay the write.
          await ambientJournalWrite(filePath, buildRichScaffold(reviewId, opts.sprintId, reviewer));
        }
      }

      if (currentSprint.review_id !== reviewId) {
        await tx.lockedMutate(`sprint-${opts.sprintId}`, () =>
          mutateSprintFrontmatter(join(outcome.cwd, currentSprint.file), { review_id: reviewId }),
        );
      }
      linked = true;
      await tx.refreshRegistry();
    },
  );

  if (!reviewId) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `review-create: allocation failed for ${opts.sprintId}\n`,
    };
  }

  const relPath = filePath.startsWith(outcome.cwd)
    ? filePath.slice(outcome.cwd.length).replace(/^\//, '')
    : filePath;

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({
        reviewId,
        sprintId: opts.sprintId,
        file: relPath,
        reused,
        linked,
        sprintFile: sprint.file,
        reviewReady: linked,
        next_actions: [`rk review-evidence ${opts.sprintId}`],
      }),
      stderr: '',
    };
  }

  const action = reused ? 'Found existing' : 'Created';
  return {
    exitCode: EXIT_OK,
    stdout: `${action} ${reviewId} for ${opts.sprintId}\n  ${relPath}\n  linked sprint: ${sprint.file}\n`,
    stderr: '',
  };
}
