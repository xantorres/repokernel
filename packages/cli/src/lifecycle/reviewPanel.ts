import type { PanelReviewQualityRule, ReviewerGrant, ReviewPanelInput } from '@repokernel/core';
import { ReviewPanelOutputSchema, toErrorMessage } from '@repokernel/core';
import {
  resolveTrustedReviewer,
  SIGTERM_GRACE_MS,
  spawnPolicyEnforced,
  terminateWithGrace,
  trustCandidatesForCwd,
} from '../security/spawnPolicy.js';
import { aggregateVerdict } from './reviewAggregate.js';
import { extractSentinelPayload, MAX_PROCESS_OUTPUT_BYTES } from './sentinel.js';

const MAX_REVIEWER_OUTPUT_BYTES = Math.min(5 * 1_048_576, MAX_PROCESS_OUTPUT_BYTES);

export interface ReviewerRunResult {
  readonly reviewer_id: string;
  readonly verdict: 'GREEN' | 'YELLOW' | 'RED';
  readonly findings: Array<{
    severity: string;
    message: string;
    code?: string | undefined;
    suggestion?: string | undefined;
  }>;
  readonly completed_at: string;
  /** Present when the reviewer's `failure_verdict` was applied because the reviewer crashed, timed out, exceeded output limits, or produced unparseable sentinel output. The message is logged for operators to debug; absent when the reviewer succeeded cleanly. */
  readonly error?: string;
}

export interface PanelRunResult {
  readonly round: number;
  readonly aggregate: 'GREEN' | 'YELLOW' | 'RED';
  readonly completed_at: string;
  readonly reviewers: ReviewerRunResult[];
}

type ReviewerConfig = PanelReviewQualityRule['reviewers'][number];

function runReviewer(
  cfg: ReviewerConfig,
  grant: ReviewerGrant,
  input: ReviewPanelInput,
): Promise<ReviewerRunResult> {
  return new Promise((resolve) => {
    const failureVerdict = cfg.failure_verdict;
    let stdout = '';
    let stdoutPending = '';
    let stderr = '';
    let stderrPending = '';
    let terminationReason: 'timeout' | 'output_limit' | null = null;

    const { child, untrack } = spawnPolicyEnforced({
      command: grant.command,
      args: grant.args,
      cwd: input.worktree_path,
      envPassthrough: grant.env_passthrough,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const detached = process.platform !== 'win32';

    let grace: ReturnType<typeof terminateWithGrace> | null = null;
    const terminate = (reason: 'timeout' | 'output_limit') => {
      if (terminationReason) return;
      terminationReason = reason;
      if (child.pid) grace = terminateWithGrace({ pid: child.pid, detached }, SIGTERM_GRACE_MS);
    };

    const timer = setTimeout(() => {
      terminate('timeout');
    }, grant.timeout_seconds * 1000);

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* writer-side pipe errors are non-fatal here */
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }

    const outputTooLarge = (nextChunkBytes: number): boolean =>
      Buffer.byteLength(stdout) +
        Buffer.byteLength(stdoutPending) +
        Buffer.byteLength(stderr) +
        Buffer.byteLength(stderrPending) +
        nextChunkBytes >
      MAX_REVIEWER_OUTPUT_BYTES;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outputTooLarge(chunk.byteLength)) {
        terminate('output_limit');
        return;
      }
      stdoutPending += chunk.toString('utf8');
      const lines = stdoutPending.split('\n');
      stdoutPending = lines.pop() ?? '';
      for (const line of lines) stdout += `${line}\n`;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (outputTooLarge(chunk.byteLength)) {
        terminate('output_limit');
        return;
      }
      stderrPending += chunk.toString('utf8');
      const lines = stderrPending.split('\n');
      stderrPending = lines.pop() ?? '';
      for (const line of lines) stderr += `${line}\n`;
    });

    const failWith = (error: string) => {
      resolve({
        reviewer_id: cfg.id,
        verdict: failureVerdict,
        findings: [],
        completed_at: new Date().toISOString(),
        error,
      });
    };

    child.on('close', (code) => {
      if (stdoutPending) stdout += stdoutPending;
      if (stderrPending) stderr += stderrPending;
      clearTimeout(timer);
      grace?.cancel();
      untrack();

      if (terminationReason === 'timeout') {
        failWith(`reviewer '${cfg.id}' exceeded ${grant.timeout_seconds}s timeout`);
        return;
      }
      if (terminationReason === 'output_limit') {
        failWith(
          `reviewer '${cfg.id}' exceeded ${MAX_REVIEWER_OUTPUT_BYTES} byte combined stdout+stderr limit`,
        );
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim().slice(-512);
        failWith(`reviewer '${cfg.id}' exited ${code ?? 'unknown'}${tail ? ` — ${tail}` : ''}`);
        return;
      }

      try {
        const raw = extractSentinelPayload(stdout);
        const parsed = ReviewPanelOutputSchema.parse(raw);
        resolve({
          reviewer_id: cfg.id,
          verdict: parsed.verdict,
          findings: parsed.findings,
          completed_at: new Date().toISOString(),
        });
      } catch (err) {
        failWith(`reviewer '${cfg.id}' produced invalid sentinel: ${toErrorMessage(err)}`);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      grace?.cancel();
      untrack();
      failWith(`reviewer '${cfg.id}' could not be launched: ${toErrorMessage(err)}`);
    });
  });
}

export async function runReviewPanel(
  panelRule: PanelReviewQualityRule,
  input: ReviewPanelInput,
  round: number,
  /** Project root cwd for resolving reviewer trust grants. */
  cwd: string,
): Promise<PanelRunResult> {
  // Resolve each reviewer's trust grant independently. A missing grant for
  // one reviewer must NOT abort the whole panel — the configured
  // failure_verdict for that reviewer should apply instead, mirroring how
  // the runner below treats crashes and timeouts. Aborting the panel would
  // surprise users running multi-reviewer rules where one reviewer is
  // trusted and one isn't yet (common during onboarding).
  const candidates = await trustCandidatesForCwd(cwd);
  const fallbackCwd = candidates[1];
  const grants = await Promise.allSettled(
    panelRule.reviewers.map((cfg) => resolveTrustedReviewer(cfg.id, cwd, { fallbackCwd })),
  );

  const reviewers: ReviewerRunResult[] = await Promise.all(
    panelRule.reviewers.map(async (cfg, i): Promise<ReviewerRunResult> => {
      const g = grants[i]!;
      if (g.status === 'rejected') {
        const reason = g.reason instanceof Error ? g.reason.message : String(g.reason);
        return {
          reviewer_id: cfg.id,
          verdict: cfg.failure_verdict,
          findings: [],
          completed_at: new Date().toISOString(),
          error: reason,
        };
      }
      try {
        return await runReviewer(cfg, g.value, input);
      } catch (err) {
        return {
          reviewer_id: cfg.id,
          verdict: cfg.failure_verdict,
          findings: [],
          completed_at: new Date().toISOString(),
          error: toErrorMessage(err),
        };
      }
    }),
  );

  const aggregate = aggregateVerdict(reviewers);

  return {
    round,
    aggregate,
    completed_at: new Date().toISOString(),
    reviewers,
  };
}
