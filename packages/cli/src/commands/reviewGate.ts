import { relative, resolve } from 'node:path';
import { loadProject, RepoKernelError, SPRINT_ID_RE } from '@repokernel/core';
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
 * Load the project, resolve the gate from the linked review's reviewer, and run
 * it against a sprint whose review stub already exists. Shared by `rk review`,
 * `rk review-create --gate`, and `rk review-gate`. Returns a CommandResult.
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

  // Refuse to run the gate against a review that targets a different sprint —
  // it would overwrite that review's snapshot (poisoning the legitimate file).
  if (review.sprint_id !== sprint.id) {
    return blocked(
      `review ${review.id} targets sprint ${review.sprint_id}, not ${sprint.id}`,
      `link a review for ${sprint.id} (rk review-create --sprint ${sprint.id})`,
    );
  }

  // Resolve the gate from the LINKED review's reviewer, not the project default —
  // `review-create --reviewer <name>` may have stamped a specific reviewer, and
  // the gate must run the reviewer the review was actually created for.
  const reviewerConfig = outcome.config.automation.reviewers?.[review.reviewer];
  if (!reviewerConfig) {
    return blocked(
      `review ${review.id} reviewer "${review.reviewer}" has no gate under automation.reviewers`,
      `add automation.reviewers.${review.reviewer}, or stamp a configured reviewer`,
    );
  }

  const queueFile = outcome.parsed.queues.find((q) => q.lane === sprint.lane)?.file;
  const result = await runReviewerGate({
    cwd: outcome.cwd,
    reviewerName: review.reviewer,
    reviewerConfig,
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
    reviewerName: review.reviewer,
    sprintId,
    reviewId: review.id,
    json: opts.json,
  });
}

/**
 * `rk review-gate <sprint-id>` — re-run the configured reviewer gate against a
 * sprint that already has a linked review. The explicit retry path after a
 * blocked gate (auth/trust/scope) or an `rk re-review` reset, since `re-review`
 * itself does not rerun the gate.
 */
export async function runReviewGateCommand(
  sprintId: string,
  opts: { readonly cwd: string; readonly json: boolean },
): Promise<CommandResult> {
  if (!SPRINT_ID_RE.test(sprintId)) {
    return blocked(`invalid sprint id "${sprintId}" (expected S-NNN)`);
  }
  return runReviewerGateForLinkedSprint(resolve(opts.cwd), sprintId, { json: opts.json });
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
        // `verdict` is the GATE verdict (one of two close lanes), NOT a
        // close-ready signal. Surface it unambiguously and spell out the next
        // step so automation does not treat `accepted` as "ready to close".
        gate_verdict: result.verdict,
        verdict: result.verdict,
        reviewer_gate_recorded: true,
        findings: result.findings,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.failSoft ? { fail_soft: result.failSoft } : {}),
        next_actions:
          result.verdict === 'accepted'
            ? [`rk review-sprint ${ctx.sprintId}`, `rk close ${ctx.sprintId}`]
            : [`rk review-gate ${ctx.sprintId}`],
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
      ? `Next: rk review-sprint ${ctx.sprintId} (built-in lane), then rk close ${ctx.sprintId}`
      : `Fix findings, commit, then re-run the gate: rk review-gate ${ctx.sprintId}`,
  );
  return { exitCode: result.exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
