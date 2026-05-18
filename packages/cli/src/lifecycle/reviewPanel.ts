import type { PanelReviewQualityRule, ReviewerGrant, ReviewPanelInput } from '@repokernel/core';
import { ReviewPanelOutputSchema } from '@repokernel/core';
import { resolveTrustedReviewer, spawnPolicyEnforced } from '../security/spawnPolicy.js';
import { aggregateVerdict } from './reviewAggregate.js';

const SENTINEL_START = 'REPOKERNEL_RESULT_START';
const SENTINEL_END = 'REPOKERNEL_RESULT_END';

const MAX_SENTINEL_BYTES = 1_048_576; // 1 MB
const MAX_REVIEWER_OUTPUT_BYTES = 5 * 1_048_576; // 5 MB
const SIGTERM_GRACE_MS = 5_000;

function extractSentinelJson(stdout: string): unknown {
  const start = stdout.indexOf(SENTINEL_START);
  const end = stdout.indexOf(SENTINEL_END, start);
  if (start === -1 || end === -1) throw new Error('missing sentinel markers in reviewer stdout');
  const raw = stdout.slice(start + SENTINEL_START.length, end).trim();
  if (raw.length > MAX_SENTINEL_BYTES) throw new Error('sentinel payload exceeds 1 MB limit');
  return JSON.parse(raw);
}

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

    let killTimer: NodeJS.Timeout | null = null;
    const killProcessTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        // Already exited.
      }
    };
    const terminate = (reason: 'timeout' | 'output_limit') => {
      if (terminationReason) return;
      terminationReason = reason;
      killProcessTree('SIGTERM');
      killTimer = setTimeout(() => {
        killProcessTree('SIGKILL');
      }, SIGTERM_GRACE_MS);
    };

    const timer = setTimeout(() => {
      terminate('timeout');
    }, grant.timeout_seconds * 1000);

    // The reviewer can exit before we finish writing the input (timeout-driven
    // SIGTERM, spawn failure, or just a fast bail). Swallow the resulting
    // EPIPE on stdin so it never surfaces as an unhandled exception — the
    // failure path is already covered by `child.on('error')` and the close
    // handler's non-zero-exit branch.
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* writer-side pipe errors are non-fatal here */
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }

    // Combined cap mirrors ExternalRunner — a reviewer that floods 4MB of
    // stdout AND 4MB of stderr should still trip the limit.
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

    child.on('close', (code) => {
      if (stdoutPending) stdout += stdoutPending;
      if (stderrPending) stderr += stderrPending;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      untrack();

      if (terminationReason || code !== 0) {
        resolve({
          reviewer_id: cfg.id,
          verdict: failureVerdict,
          findings: [],
          completed_at: new Date().toISOString(),
        });
        return;
      }

      try {
        const raw = extractSentinelJson(stdout);
        const parsed = ReviewPanelOutputSchema.parse(raw);
        resolve({
          reviewer_id: cfg.id,
          verdict: parsed.verdict,
          findings: parsed.findings,
          completed_at: new Date().toISOString(),
        });
      } catch {
        resolve({
          reviewer_id: cfg.id,
          verdict: failureVerdict,
          findings: [],
          completed_at: new Date().toISOString(),
        });
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      untrack();
      resolve({
        reviewer_id: cfg.id,
        verdict: failureVerdict,
        findings: [],
        completed_at: new Date().toISOString(),
      });
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
  const grants = await Promise.allSettled(
    panelRule.reviewers.map((cfg) => resolveTrustedReviewer(cfg.id, cwd)),
  );

  const reviewers: ReviewerRunResult[] = await Promise.all(
    panelRule.reviewers.map(async (cfg, i): Promise<ReviewerRunResult> => {
      const g = grants[i]!;
      if (g.status === 'rejected') {
        return {
          reviewer_id: cfg.id,
          verdict: cfg.failure_verdict,
          findings: [],
          completed_at: new Date().toISOString(),
        };
      }
      try {
        return await runReviewer(cfg, g.value, input);
      } catch {
        return {
          reviewer_id: cfg.id,
          verdict: cfg.failure_verdict,
          findings: [],
          completed_at: new Date().toISOString(),
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
