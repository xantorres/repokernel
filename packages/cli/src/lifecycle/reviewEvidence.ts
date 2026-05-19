import { join, resolve } from 'node:path';
import {
  type CommandEvidence,
  loadProject,
  REVIEW_ID_RE,
  RepoKernelError,
  SPRINT_ID_RE,
} from '@repokernel/core';
import { withLockRetrying } from './locks.js';
import { mutateReviewFrontmatter } from './mutate.js';
import { withLifecycleScope } from './transaction.js';

export interface EvidenceInput {
  readonly label: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly status?: CommandEvidence['status'];
  readonly summary?: string;
}

export function buildCommandEvidence(input: EvidenceInput): CommandEvidence {
  const label = input.label.trim();
  const command = input.command?.trim();
  const summary = input.summary?.trim();
  const status =
    input.status ??
    (input.exitCode === undefined || input.exitCode === null
      ? 'skipped'
      : input.exitCode === 0
        ? 'passed'
        : 'failed');
  return {
    label,
    ...(command !== undefined && command.length > 0 ? { command } : {}),
    ...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
    status,
    ran_at: new Date().toISOString(),
    ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
  };
}

export async function appendReviewEvidence(
  cwdInput: string,
  targetId: string,
  evidence: CommandEvidence,
): Promise<{ reviewId: string; file: string; evidence: CommandEvidence }> {
  const cwd = resolve(cwdInput);
  const outcome = await loadProject({ cwd });
  if (!outcome.ok) {
    throw new RepoKernelError('CONFIG_INVALID', 'project failed to load; run rk validate');
  }

  const initialReviewId = resolveReviewId(outcome, targetId);
  if (!initialReviewId) {
    throw new RepoKernelError(
      'INTERNAL',
      `review not found for ${targetId}; create or link a review first`,
    );
  }

  return withLifecycleScope({ cwd, command: 'review-evidence', args: { targetId } }, async (tx) =>
    withLockRetrying(`review-evidence-${initialReviewId}`, tx.opRoot, async () => {
      const current = await tx.reloadProject();
      const reviewId = resolveReviewId(current, targetId);
      const review = reviewId ? current.graph.reviews.get(reviewId) : undefined;
      if (reviewId !== initialReviewId) {
        throw new RepoKernelError(
          'INTERNAL',
          `review link for ${targetId} changed while recording evidence; retry the command`,
        );
      }
      if (!review) {
        throw new RepoKernelError(
          'INTERNAL',
          `review not found for ${targetId}; create or link a review first`,
        );
      }
      await mutateReviewFrontmatter(join(cwd, review.file), (data) => {
        const existing = Array.isArray(data.command_evidence) ? data.command_evidence : [];
        return { ...data, command_evidence: [...existing, evidence] };
      });
      return { reviewId: review.id, file: review.file, evidence };
    }),
  );
}

function resolveReviewId(
  outcome: Awaited<ReturnType<typeof loadProject>>,
  targetId: string,
): string | null {
  if (!outcome.ok) return null;
  if (REVIEW_ID_RE.test(targetId) && outcome.graph.reviews.has(targetId)) return targetId;
  if (!SPRINT_ID_RE.test(targetId)) return null;
  const sprint = outcome.graph.sprints.get(targetId);
  return sprint?.review_id ?? null;
}
