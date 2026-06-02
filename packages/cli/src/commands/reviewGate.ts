import { relative } from 'node:path';
import { loadProject, RepoKernelError, resolveReviewerGate } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { type ReviewerGateOutcome, runReviewerGate } from '../lifecycle/reviewerGate.js';
import type { CommandResult } from './validate.js';

function blocked(message: string, hint?: string): CommandResult {
  return {
    exitCode: EXIT_BLOCKED,
    stdout: '',
    stderr: hint ? `${message}\n  Hint: ${hint}\n` : `${message}\n`,
  };
}

/**
 * Load the project, resolve the configured reviewer gate, and run it against a
 * sprint whose review stub already exists. Shared by `rk review`, `rk re-review`
 * and the `rk review-create` auto-run. Returns a fully-formatted CommandResult.
 */
export async function runReviewerGateForLinkedSprint(
  cwd: string,
  sprintId: string,
  opts: { readonly json: boolean },
): Promise<CommandResult> {
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

  const gate = resolveReviewerGate(outcome.config.automation);
  if (!gate) {
    return blocked(
      'no reviewer gate configured',
      'set automation.defaultReviewer to a key under automation.reviewers (e.g. codex)',
    );
  }

  const sprint = outcome.graph.sprints.get(sprintId);
  if (!sprint) return blocked(`sprint not found: ${sprintId}`);
  if (!sprint.review_id) {
    return blocked(
      `${sprintId} has no review_id`,
      `run rk review-create --sprint ${sprintId} first`,
    );
  }
  const review = outcome.graph.reviews.get(sprint.review_id);
  if (!review) return blocked(`review ${sprint.review_id} not found`);

  const queueFile = outcome.parsed.queues.find((q) => q.lane === sprint.lane)?.file;
  const result = await runReviewerGate({
    cwd: outcome.cwd,
    reviewerName: gate.name,
    reviewerConfig: gate.config,
    config: outcome.config,
    sprint,
    review: { id: review.id, file: review.file, review_attempt: review.review_attempt },
    // Exempt only THIS sprint's own rk-managed files — lifecycle commits touch them.
    exemptFiles: [
      sprint.file,
      review.file,
      ...(queueFile !== undefined ? [queueFile] : []),
      outcome.config.paths.registry,
    ],
    configFile: relative(outcome.cwd, outcome.configPath),
  });

  return formatGateResult(result, {
    reviewerName: gate.name,
    sprintId,
    reviewId: review.id,
    json: opts.json,
  });
}

function formatGateResult(
  result: ReviewerGateOutcome,
  ctx: {
    readonly reviewerName: string;
    readonly sprintId: string;
    readonly reviewId: string;
    readonly json: boolean;
  },
): CommandResult {
  if (result.kind === 'blocked') {
    if (ctx.json) {
      return {
        exitCode: result.exitCode,
        stdout: emitJson({
          sprint_id: ctx.sprintId,
          review_id: ctx.reviewId,
          reviewer: ctx.reviewerName,
          blocked: true,
          reason: result.reason,
        }),
        stderr: '',
      };
    }
    return {
      exitCode: result.exitCode,
      stdout: '',
      stderr: `review gate blocked (${ctx.reviewerName}): ${result.reason}\n`,
    };
  }

  if (ctx.json) {
    return {
      exitCode: result.exitCode,
      stdout: emitJson({
        sprint_id: ctx.sprintId,
        review_id: ctx.reviewId,
        reviewer: ctx.reviewerName,
        verdict: result.verdict,
        findings: result.findings,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.failSoft ? { fail_soft: result.failSoft } : {}),
      }),
      stderr: '',
    };
  }

  const lines = [
    `Reviewer gate (${ctx.reviewerName}) — ${ctx.sprintId}`,
    '',
    `  Verdict:  ${result.verdict}`,
  ];
  if (result.failSoft) {
    lines.push(`  Note:     reviewer did not complete cleanly — ${result.failSoft}`);
  }
  if (result.findings.length > 0) {
    lines.push('', 'Findings:');
    for (const f of result.findings) lines.push(`  [${f.severity}] ${f.message}`);
  }
  if (result.summary) lines.push('', result.summary);
  lines.push(
    '',
    result.verdict === 'accepted'
      ? `Next: rk close ${ctx.sprintId}`
      : `Fix findings, then: rk re-review ${ctx.sprintId}`,
  );
  return { exitCode: result.exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
