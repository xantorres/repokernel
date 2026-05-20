import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  type CommandEvidence,
  canonicalJson,
  loadProject,
  REVIEW_ID_RE,
  RepoKernelError,
  SPRINT_ID_RE,
} from '@repokernel/core';
import { killProcessTree, SIGTERM_GRACE_MS, spawnPolicyPiped } from '../security/spawnPolicy.js';
import { withLockRetrying } from './locks.js';
import { mutateReviewFrontmatter } from './mutate.js';
import { withLifecycleScope } from './transaction.js';

export interface EvidenceInput {
  readonly label: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly status?: CommandEvidence['status'];
  readonly summary?: string;
  /**
   * Mark this evidence as transitional — captured during a window where the
   * failure is expected (e.g. a downstream dependent waiting for this very
   * sprint to ship). Transitional failures show up in the review record but
   * do NOT gate the verdict. Defaults to false (i.e. the evidence is
   * blocking) for parity with pre-1.20.0 behavior.
   */
  readonly transitional?: boolean;
  readonly source?: CommandEvidence['source'];
  readonly cwd?: string;
  readonly durationMs?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly stdoutSha256?: string;
  readonly stderrSha256?: string;
  readonly timedOut?: boolean;
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
    source: input.source ?? 'executed',
    ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
    ...(input.stdoutBytes !== undefined ? { stdout_bytes: input.stdoutBytes } : {}),
    ...(input.stderrBytes !== undefined ? { stderr_bytes: input.stderrBytes } : {}),
    ...(input.stdoutSha256 !== undefined ? { stdout_sha256: input.stdoutSha256 } : {}),
    ...(input.stderrSha256 !== undefined ? { stderr_sha256: input.stderrSha256 } : {}),
    ...(input.timedOut === true ? { timed_out: true } : {}),
    ...(input.transitional === true ? { transitional: true } : {}),
  };
}

export async function executeCommandEvidence(input: {
  readonly cwd: string;
  readonly label: string;
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly summary?: string;
}): Promise<CommandEvidence> {
  const started = Date.now();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;

  const { child, untrack } = spawnPolicyPiped({
    command: input.command,
    cwd: input.cwd,
    shell: true,
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdoutHash.update(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderrHash.update(chunk);
  });

  const detached = process.platform !== 'win32';
  let killTimer: NodeJS.Timeout | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killProcessTree({ pid: child.pid, detached }, 'SIGTERM');
    killTimer = setTimeout(() => {
      if (child.pid) killProcessTree({ pid: child.pid, detached }, 'SIGKILL');
    }, SIGTERM_GRACE_MS);
  }, Math.max(1, input.timeoutSeconds) * 1000);

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(timedOut ? (code ?? 124) : (code ?? 1)));
    child.on('error', () => resolve(1));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  untrack();

  return buildCommandEvidence({
    label: input.label,
    command: input.command,
    exitCode,
    source: 'executed',
    cwd: input.cwd,
    durationMs: Date.now() - started,
    stdoutBytes,
    stderrBytes,
    stdoutSha256: stdoutHash.digest('hex'),
    stderrSha256: stderrHash.digest('hex'),
    ...(timedOut ? { timedOut: true } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  });
}

export async function resolveReviewEvidenceTarget(
  cwdInput: string,
  targetId: string,
): Promise<{ readonly reviewId: string; readonly file: string }> {
  const cwd = resolve(cwdInput);
  const outcome = await loadProject({ cwd });
  if (!outcome.ok) {
    throw new RepoKernelError('CONFIG_INVALID', 'project failed to load; run rk validate');
  }
  const reviewId = resolveReviewId(outcome, targetId);
  if (reviewId === null) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `review not found for ${targetId}; create or link a review first`,
    );
  }
  const review = outcome.graph.reviews.get(reviewId);
  if (!review) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `review not found for ${targetId}; create or link a review first`,
    );
  }
  return { reviewId, file: review.file };
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
      let chainedEvidence = evidence;
      await mutateReviewFrontmatter(join(cwd, review.file), (data) => {
        const existing = Array.isArray(data.command_evidence) ? data.command_evidence : [];
        const previous = previousEvidenceHash(existing);
        const withPrevious: CommandEvidence = {
          ...evidence,
          previous_evidence_hash: previous,
        };
        chainedEvidence = {
          ...withPrevious,
          evidence_hash: hashEvidence(withPrevious),
        };
        return { ...data, command_evidence: [...existing, chainedEvidence] };
      });
      return { reviewId: review.id, file: review.file, evidence: chainedEvidence };
    }),
  );
}

function previousEvidenceHash(existing: readonly unknown[]): string | null {
  const last = existing[existing.length - 1];
  if (
    typeof last === 'object' &&
    last !== null &&
    'evidence_hash' in last &&
    typeof (last as { evidence_hash?: unknown }).evidence_hash === 'string'
  ) {
    return (last as { evidence_hash: string }).evidence_hash;
  }
  return null;
}

export interface EvidenceChainIssue {
  readonly index: number;
  readonly label: string;
  readonly reason: string;
}

export function verifyEvidenceChain(
  evidence: readonly CommandEvidence[],
): readonly EvidenceChainIssue[] {
  const issues: EvidenceChainIssue[] = [];
  let previous: string | null = null;
  for (const [index, item] of evidence.entries()) {
    if (item.source !== 'executed') {
      previous = typeof item.evidence_hash === 'string' ? item.evidence_hash : null;
      continue;
    }
    if (item.previous_evidence_hash !== previous) {
      issues.push({
        index,
        label: item.label,
        reason: 'previous_evidence_hash does not match the prior evidence hash',
      });
    }
    if (typeof item.evidence_hash !== 'string') {
      issues.push({
        index,
        label: item.label,
        reason: 'executed evidence is missing evidence_hash',
      });
      previous = null;
      continue;
    }
    const expected = hashEvidence(item);
    if (item.evidence_hash !== expected) {
      issues.push({ index, label: item.label, reason: 'evidence_hash does not match payload' });
    }
    previous = item.evidence_hash;
  }
  return issues;
}

function hashEvidence(evidence: CommandEvidence): string {
  const payload = { ...evidence };
  delete (payload as { evidence_hash?: string }).evidence_hash;
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
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
