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
import { redactSecrets } from './secretScanner.js';
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
  readonly supersedes?: string;
  readonly supersedeReason?: string;
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
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    ...(input.supersedeReason !== undefined ? { supersede_reason: input.supersedeReason } : {}),
  };
}

export async function executeCommandEvidence(input: {
  readonly cwd: string;
  readonly label: string;
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly summary?: string;
  readonly shell?: string;
}): Promise<CommandEvidence> {
  const started = Date.now();
  const stdoutHash = createHash('sha256');
  const stderrHash = createHash('sha256');
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let stderrPreview = '';

  const shell = resolveEvidenceShell(input.command, input.shell);
  const { child, untrack } = spawnPolicyPiped({
    command: shell.command,
    ...(shell.args !== undefined ? { args: shell.args } : {}),
    cwd: input.cwd,
    shell: shell.shell,
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdoutHash.update(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderrHash.update(chunk);
    if (stderrPreview.length < 2048) {
      stderrPreview += chunk.toString('utf8').slice(0, 2048 - stderrPreview.length);
    }
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
    ...(input.summary !== undefined
      ? { summary: input.summary }
      : commandNotFound(exitCode, stderrPreview)
        ? { summary: `command not found; PATH=${diagnosticPath(process.env.PATH)}` }
        : {}),
  });
}

interface EvidenceShellInvocation {
  readonly command: string;
  readonly args?: readonly string[];
  readonly shell: boolean;
}

function resolveEvidenceShell(command: string, mode = 'login'): EvidenceShellInvocation {
  if (mode === 'default' || process.platform === 'win32') return { command, shell: true };
  if (mode === 'login') {
    const loginShell = process.env.SHELL;
    if (loginShell === undefined || loginShell.trim().length === 0) {
      return { command: '/bin/sh', args: ['-c', command], shell: false };
    }
    return {
      command: loginShell,
      args: ['-lc', command],
      shell: false,
    };
  }
  const [shellCommand, ...shellArgs] = splitShellMode(mode);
  if (shellCommand === undefined) return { command, shell: true };
  return { command: shellCommand, args: [...shellArgs, command], shell: false };
}

function splitShellMode(value: string): readonly string[] {
  return value
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0);
}

function commandNotFound(exitCode: number, stderrPreview: string): boolean {
  return exitCode === 127 || /not found|command not found|not recognized/iu.test(stderrPreview);
}

function diagnosticPath(path: string | undefined): string {
  if (path === undefined || path.length === 0) return '';
  const home = process.env.HOME;
  const collapsed = home !== undefined && home.length > 0 ? path.replaceAll(home, '~') : path;
  return redactSecrets(collapsed);
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
  // Anchor the chain to the last EXECUTED entry's hash. Imported (and any
  // non-executed) entries are inert — they carry no verifiable hash and
  // must never become a chain link, otherwise a hand-inserted `imported`
  // entry with an attacker-chosen `evidence_hash` would forge the anchor
  // for the next executed entry. Append and verify must agree on this:
  // see verifyEvidenceChain.
  for (let i = existing.length - 1; i >= 0; i--) {
    const item = existing[i];
    if (
      typeof item === 'object' &&
      item !== null &&
      (item as { source?: unknown }).source === 'executed' &&
      typeof (item as { evidence_hash?: unknown }).evidence_hash === 'string'
    ) {
      return (item as { evidence_hash: string }).evidence_hash;
    }
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
      // Imported / non-executed evidence is inert: no verifiable hash, and
      // it must NOT advance `previous`. A forged `imported` entry could
      // otherwise inject an attacker-chosen anchor for the next executed
      // entry. The chain runs executed → executed; imported entries are
      // skipped entirely. `reviewSprint` separately rejects imported
      // evidence as gate-satisfying.
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
