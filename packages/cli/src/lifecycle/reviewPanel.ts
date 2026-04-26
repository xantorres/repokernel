import { spawn } from 'node:child_process';
import type { PanelReviewQualityRule, ReviewPanelInput } from '@repokernel/core';
import { ReviewPanelOutputSchema } from '@repokernel/core';
import { aggregateVerdict } from './reviewAggregate.js';

const SENTINEL_START = 'REPOKERNEL_RESULT_START';
const SENTINEL_END = 'REPOKERNEL_RESULT_END';

const MAX_SENTINEL_BYTES = 1_048_576; // 1 MB

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

function runReviewer(cfg: ReviewerConfig, input: ReviewPanelInput): Promise<ReviewerRunResult> {
  return new Promise((resolve) => {
    const restrictedEnv: Record<string, string> = { PATH: process.env.PATH ?? '' };
    for (const key of cfg.env_passthrough) {
      const val = process.env[key];
      if (val !== undefined) restrictedEnv[key] = val;
    }

    const failureVerdict = cfg.failure_verdict;
    let stdout = '';
    let stdoutPending = '';
    let timedOut = false;

    const child = spawn(cfg.command, cfg.args, {
      cwd: input.worktree_path,
      env: restrictedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, cfg.timeoutSeconds * 1000);

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutPending += chunk.toString('utf8');
      const lines = stdoutPending.split('\n');
      stdoutPending = lines.pop() ?? '';
      for (const line of lines) stdout += `${line}\n`;
    });

    child.on('close', (code) => {
      if (stdoutPending) stdout += stdoutPending;
      clearTimeout(timer);

      if (timedOut || code !== 0) {
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
): Promise<PanelRunResult> {
  const settled = await Promise.allSettled(
    panelRule.reviewers.map((cfg) => runReviewer(cfg, input)),
  );

  const reviewers: ReviewerRunResult[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      reviewer_id: panelRule.reviewers[i]!.id,
      verdict: panelRule.reviewers[i]!.failure_verdict,
      findings: [],
      completed_at: new Date().toISOString(),
    };
  });

  const aggregate = aggregateVerdict(reviewers);

  return {
    round,
    aggregate,
    completed_at: new Date().toISOString(),
    reviewers,
  };
}
