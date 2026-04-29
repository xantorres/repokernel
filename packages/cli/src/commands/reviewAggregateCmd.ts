import { resolve } from 'node:path';
import type { ReviewFinding } from '@repokernel/core';
import { loadProject, RepoKernelError, ReviewFindingSchema } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { aggregateVerdict } from '../lifecycle/reviewAggregate.js';
import type { CommandResult } from './validate.js';

type PanelVerdict = 'GREEN' | 'YELLOW' | 'RED';
const VALID_VERDICTS: ReadonlySet<PanelVerdict> = new Set(['GREEN', 'YELLOW', 'RED']);
const SEVERITY_RANK: Record<PanelVerdict, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

export interface ReviewAggregateOptions {
  readonly cwd: string;
  readonly verdicts?: readonly string[];
  readonly findings?: string;
  readonly json: boolean;
  readonly failOn?: PanelVerdict;
}

function findingToVerdict(severity: ReviewFinding['severity']): PanelVerdict {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'RED';
  if (severity === 'MEDIUM') return 'YELLOW';
  return 'GREEN';
}

function err(message: string, exitCode: number = EXIT_BLOCKED): CommandResult {
  return { exitCode, stdout: '', stderr: `${message}\n` };
}

function applyFailOn(aggregate: PanelVerdict, failOn: PanelVerdict | undefined): number {
  if (failOn === undefined) return EXIT_OK;
  return SEVERITY_RANK[aggregate] >= SEVERITY_RANK[failOn] ? EXIT_BLOCKED : EXIT_OK;
}

function emitInline(
  verdicts: readonly PanelVerdict[],
  json: boolean,
  failOn: PanelVerdict | undefined,
): CommandResult {
  const aggregate = aggregateVerdict(verdicts.map((v) => ({ verdict: v })));
  const exitCode = applyFailOn(aggregate, failOn);
  if (json) {
    return {
      exitCode,
      stdout: `${JSON.stringify({ aggregate, source: 'inline', inputs: verdicts }, null, 2)}\n`,
      stderr: '',
    };
  }
  return { exitCode, stdout: `${aggregate}\n`, stderr: '' };
}

export async function runReviewAggregateCommand(
  sprintId: string | undefined,
  opts: ReviewAggregateOptions,
): Promise<CommandResult> {
  const inlineMode = opts.verdicts !== undefined;
  const sprintMode = sprintId !== undefined;
  const findingsMode = opts.findings !== undefined;

  const modeCount = [inlineMode, sprintMode, findingsMode].filter(Boolean).length;
  if (modeCount > 1) {
    return err('use exactly one mode: <sprint-id>, --verdicts, or --findings', EXIT_USAGE);
  }
  if (modeCount === 0) {
    return err('provide a sprint id, --verdicts <list>, or --findings <json>', EXIT_USAGE);
  }

  if (findingsMode) {
    let findings: ReviewFinding[];
    try {
      const raw: unknown = JSON.parse(opts.findings!);
      const parsed = ReviewFindingSchema.array().safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.message).join('; ');
        return err(`--findings: invalid schema: ${issues}`, EXIT_USAGE);
      }
      findings = parsed.data;
    } catch {
      return err('--findings: invalid JSON', EXIT_USAGE);
    }
    const verdicts = findings.map((f) => findingToVerdict(f.severity));
    const aggregate = aggregateVerdict(verdicts.map((v) => ({ verdict: v })));
    const exitCode = applyFailOn(aggregate, opts.failOn);
    if (opts.json) {
      return {
        exitCode,
        stdout: `${JSON.stringify(
          { aggregate, source: 'findings', findings_count: findings.length },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }
    return { exitCode, stdout: `${aggregate}\n`, stderr: '' };
  }

  if (inlineMode) {
    const inputs = opts.verdicts ?? [];
    if (inputs.length === 0) {
      return err('--verdicts requires at least one value', EXIT_USAGE);
    }
    const upper = inputs.map((v) => v.toUpperCase());
    const invalid = upper.filter((v) => !VALID_VERDICTS.has(v as PanelVerdict));
    if (invalid.length > 0) {
      return err(`invalid verdict(s): ${invalid.join(', ')} (use GREEN|YELLOW|RED)`, EXIT_USAGE);
    }
    return emitInline(upper as PanelVerdict[], opts.json, opts.failOn);
  }

  // sprintMode
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
      };
    }

    const sprint = outcome.graph.sprints.get(sprintId as string);
    if (!sprint) return err(`sprint not found: ${sprintId}`);
    if (!sprint.review_id) {
      return err(`${sprintId} has no review_id; run rk review ${sprintId} first`);
    }
    const review = outcome.graph.reviews.get(sprint.review_id);
    if (!review) return err(`review ${sprint.review_id} not found`);

    const runs = review.panel_runs ?? [];
    if (runs.length === 0) {
      return err(`${sprint.review_id} has no panel_runs; run rk review-sprint ${sprintId} first`);
    }

    const latest = runs[runs.length - 1]!;
    const aggregate = aggregateVerdict(latest.reviewers);
    const exitCode = applyFailOn(aggregate, opts.failOn);

    if (opts.json) {
      return {
        exitCode,
        stdout: `${JSON.stringify(
          {
            aggregate,
            source: 'sprint',
            sprint_id: sprint.id,
            review_id: review.id,
            round: latest.round,
            reviewers: latest.reviewers.map((r) => ({
              reviewer_id: r.reviewer_id,
              verdict: r.verdict,
            })),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    return { exitCode, stdout: `${aggregate}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}
