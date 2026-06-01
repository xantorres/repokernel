import { resolve } from 'node:path';
import {
  type Config,
  loadProject,
  materialPathGlobs,
  RepoKernelError,
  type Sprint,
} from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { classifySprintDiff, uncommittedInScopePaths } from '../lifecycle/diffClassifier.js';
import {
  changedFilesForSprint,
  getPublishState,
  isWorkingTreeClean,
  type PublishStateReport,
} from '../lifecycle/git.js';
import {
  appendReviewEvidence,
  buildCommandEvidence,
  executeCommandEvidence,
} from '../lifecycle/reviewEvidence.js';
import { runPreCloseSprintGates } from '../lifecycle/sprintGates.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import { resolveCloseCheckPath, runCloseCommand, runReviewCommand } from './lifecycle.js';
import { runRegistryCommand } from './registry.js';
import { runReviewSprintCommand } from './reviewSprint.js';
import { type CommandResult, runValidateCommand } from './validate.js';

export interface ShipCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly skipChecks?: boolean;
  readonly evidenceCommand?: string;
  readonly evidenceLabel?: string;
  readonly evidenceTimeoutSeconds?: number;
  /**
   * Auto-commit the ship's `.repokernel/` mutations. Defaults to true. The
   * review step is always batched into the final close commit; this flag
   * governs whether that close commit is created.
   */
  readonly commit?: boolean;
  /** Skip the pre-ship dirty-tree gate entirely. Out-of-scope dirt is ignored regardless. */
  readonly allowDirty?: boolean;
}

interface ShipStep {
  readonly label: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly exitCode: number | null;
  readonly summary: string;
}

class ShipApplyFailure extends Error {
  constructor(readonly result: CommandResult) {
    super('ship apply failed');
  }
}

/**
 * Scope the pre-ship cleanliness gate to the sprint's own paths: only uncommitted
 * work inside allowed_paths must be committed before shipping. Out-of-scope dirt is
 * irrelevant to whether this sprint is safe to close. Falls back to a whole-tree
 * check when the sprint has no base_sha to classify against.
 */
async function uncommittedInScopeDirt(
  checkPath: string,
  sprint: Sprint,
  config: Config,
  reviewFile: string | undefined,
): Promise<string | null> {
  if (!sprint.base_sha) {
    const clean = await isWorkingTreeClean(checkPath);
    return clean ? null : `working tree at ${checkPath} has uncommitted changes`;
  }
  const changed = await changedFilesForSprint(checkPath, sprint.base_sha);
  const exemptPaths = [
    sprint.file,
    config.paths.registry,
    `${config.paths.queues}/${sprint.lane}.md`,
    ...(reviewFile !== undefined ? [reviewFile] : []),
  ];
  const classification = classifySprintDiff({
    config,
    sprint,
    changed,
    exemptPaths,
    rkOwnedGlobs: materialPathGlobs(config),
  });
  const dirty = uncommittedInScopePaths(classification);
  if (dirty.length === 0) return null;
  return `working tree at ${checkPath} has uncommitted in-scope changes (${dirty.join(', ')}); commit them or pass --allow-dirty to ship anyway`;
}

export async function runShipCommand(
  sprintId: string,
  opts: ShipCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const initial = await loadProject({ cwd });
    if (!initial.ok) return configError();
    const sprint = initial.graph.sprints.get(sprintId);
    if (!sprint) {
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `sprint not found: ${sprintId}\n` };
    }

    const steps: ShipStep[] = [];

    if (sprint.status !== 'active' && sprint.status !== 'review') {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr: `rk ship requires sprint status active or review (got: ${sprint.status})\n`,
      };
    }

    if (!opts.allowDirty && initial.config.git.requireCleanWorkingTreeForClose) {
      const checkPath = await resolveCloseCheckPath(sprintId, cwd);
      const reviewFile = sprint.review_id
        ? initial.graph.reviews.get(sprint.review_id)?.file
        : undefined;
      const dirt = await uncommittedInScopeDirt(checkPath, sprint, initial.config, reviewFile);
      if (dirt) {
        return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${dirt}\n` };
      }
    }

    if (opts.dryRun) {
      const dryRunSteps = previewSteps(sprint.status, opts.evidenceCommand);
      if (sprint.status === 'active') {
        const review = await runReviewCommand(sprintId, { cwd, dryRun: true, json: true });
        if (review.exitCode !== 0) {
          return formatResult(
            sprintId,
            sprint,
            [step('review', review.exitCode, review.stderr.trim())],
            opts.json,
            review.exitCode,
          );
        }
      } else {
        const review = sprint.review_id ? initial.graph.reviews.get(sprint.review_id) : undefined;
        const preClose = await runPreCloseSprintGates({
          cwd,
          config: initial.config,
          sprint,
          ...(review?.file !== undefined ? { reviewFile: review.file } : {}),
          configuredChecks: 'omit',
          recordEvidence: false,
        });
        if (preClose.failed) {
          return formatResult(
            sprintId,
            sprint,
            [
              {
                label: 'review',
                status: 'skipped',
                exitCode: null,
                summary: 'sprint already in review',
              },
              ...preClose.steps,
            ],
            opts.json,
            EXIT_BLOCKED,
          );
        }
      }
      return formatResult(sprintId, sprint, dryRunSteps, opts.json, EXIT_OK);
    }

    if (sprint.status === 'active') {
      const reviewPreflight = await runReviewCommand(sprintId, { cwd, dryRun: true, json: true });
      if (reviewPreflight.exitCode !== 0) {
        return formatResult(
          sprintId,
          sprint,
          [step('review', reviewPreflight.exitCode, reviewPreflight.stderr.trim())],
          opts.json,
          reviewPreflight.exitCode,
        );
      }
    }

    const currentReview = sprint.review_id
      ? initial.graph.reviews.get(sprint.review_id)
      : undefined;
    if (currentReview?.verdict === 'changes_requested' || currentReview?.verdict === 'rejected') {
      steps.push({
        label: 'accepted-verdict',
        status: 'failed',
        exitCode: 1,
        summary: `review verdict is ${currentReview.verdict}`,
      });
      return formatResult(sprintId, sprint, steps, opts.json, EXIT_BLOCKED);
    }
    if (
      opts.evidenceCommand !== undefined &&
      currentReview?.verdict !== 'accepted' &&
      initial.config.review.auto.when !== 'gates_green'
    ) {
      steps.push({
        label: 'auto-review-policy',
        status: 'failed',
        exitCode: 1,
        summary: 'review.auto.when must be gates_green for evidence-based auto close',
      });
      return formatResult(sprintId, sprint, steps, opts.json, EXIT_BLOCKED);
    }

    const preClose = await runPreCloseSprintGates({
      cwd,
      config: initial.config,
      sprint,
      ...(currentReview?.file !== undefined ? { reviewFile: currentReview.file } : {}),
      configuredChecks: opts.skipChecks === true ? 'skip' : 'run',
      recordEvidence: false,
    });
    steps.push(...preClose.steps);
    if (preClose.failed) return formatResult(sprintId, sprint, steps, opts.json, EXIT_BLOCKED);

    const validate = await runValidateCommand({ cwd, json: true, failOn: 'P1' });
    steps.push(
      step(
        'validate',
        validate.exitCode,
        validate.exitCode === 0 ? 'validation passed' : 'validation failed',
      ),
    );
    if (validate.exitCode !== 0)
      return formatResult(sprintId, sprint, steps, opts.json, validate.exitCode);

    const registry = await runRegistryCommand({
      cwd,
      write: false,
      check: true,
      explain: true,
      json: true,
    });
    steps.push(
      step(
        'registry-check',
        registry.exitCode,
        registry.exitCode === 0 ? 'registry --check passed' : 'registry drift detected',
      ),
    );
    if (registry.exitCode !== 0)
      return formatResult(sprintId, sprint, steps, opts.json, registry.exitCode);

    let appliedReviewId: string | null = null;
    const applyResult = await withLifecycleScope(
      { cwd, command: 'ship', args: { sprintId } },
      async () => {
        if (sprint.status === 'active') {
          // commit: false — the review-side mutations are folded into the
          // single close commit below so `rk ship` produces one clean commit.
          const review = await runReviewCommand(sprintId, {
            cwd,
            dryRun: false,
            json: true,
            commit: false,
          });
          steps.push(
            step(
              'review',
              review.exitCode,
              review.exitCode === 0 ? 'sprint moved to review' : review.stderr.trim(),
            ),
          );
          if (review.exitCode !== 0) {
            failApply(formatResult(sprintId, sprint, steps, opts.json, review.exitCode));
          }
        } else {
          steps.push({
            label: 'review',
            status: 'skipped',
            exitCode: null,
            summary: 'sprint already in review',
          });
        }

        const withReview = await loadProject({ cwd });
        if (!withReview.ok) failApply(configError());
        const reviewSprint = withReview.graph.sprints.get(sprintId);
        const reviewId = reviewSprint?.review_id ?? null;
        if (!reviewId) {
          failApply({
            exitCode: EXIT_BLOCKED,
            stdout: '',
            stderr: `${sprintId} has no review_id\n`,
          });
        }
        appliedReviewId = reviewId;

        if (opts.evidenceCommand !== undefined) {
          const evidence = await executeCommandEvidence({
            cwd,
            label: opts.evidenceLabel ?? 'evidence-cmd',
            command: opts.evidenceCommand,
            timeoutSeconds:
              opts.evidenceTimeoutSeconds ?? initial.config.automation.checksTimeoutSeconds,
          });
          await appendReviewEvidence(cwd, reviewId, evidence);
          steps.push({
            label: evidence.label,
            status: evidence.status,
            exitCode: evidence.exit_code ?? null,
            summary:
              evidence.status === 'passed'
                ? 'evidence command passed'
                : `evidence command failed${evidence.exit_code !== undefined ? ` (exit ${evidence.exit_code})` : ''}`,
          });
          if (evidence.status !== 'passed') {
            failApply(formatResult(sprintId, sprint, steps, opts.json, EXIT_BLOCKED));
          }
        }

        const reviewEval = await runReviewSprintCommand(sprintId, {
          cwd,
          dryRun: false,
          json: true,
        });
        steps.push(
          step(
            'review-sprint',
            reviewEval.exitCode,
            reviewEval.exitCode === 0 ? 'review-sprint completed' : reviewEval.stderr.trim(),
          ),
        );
        await appendReviewEvidence(
          cwd,
          reviewId,
          buildCommandEvidence({
            label: 'review-sprint',
            command: `rk review-sprint ${sprintId} --json`,
            exitCode: reviewEval.exitCode,
            summary: reviewEval.exitCode === 0 ? 'review-sprint completed' : 'review-sprint failed',
          }),
        );
        for (const gateStep of preClose.steps) {
          await appendReviewEvidence(
            cwd,
            reviewId,
            buildCommandEvidence({
              label: gateStep.label,
              exitCode: gateStep.exitCode,
              status: gateStep.status,
              summary: gateStep.summary,
            }),
          );
        }
        await appendReviewEvidence(
          cwd,
          reviewId,
          buildCommandEvidence({
            label: 'validate',
            command: 'rk validate --fail-on P0,P1 --json',
            exitCode: validate.exitCode,
            summary: validate.exitCode === 0 ? 'validation passed' : 'validation failed',
          }),
        );
        await appendReviewEvidence(
          cwd,
          reviewId,
          buildCommandEvidence({
            label: 'registry-check',
            command: 'rk registry --check --explain --json',
            exitCode: registry.exitCode,
            summary:
              registry.exitCode === 0 ? 'registry --check passed' : 'registry drift detected',
          }),
        );
        if (reviewEval.exitCode !== 0) {
          failApply(formatResult(sprintId, sprint, steps, opts.json, reviewEval.exitCode));
        }

        const afterReview = await loadProject({ cwd });
        if (!afterReview.ok) failApply(configError());
        const reviewedSprint = afterReview.graph.sprints.get(sprintId);
        const review = reviewedSprint?.review_id
          ? afterReview.graph.reviews.get(reviewedSprint.review_id)
          : undefined;
        if (review?.verdict !== 'accepted') {
          steps.push({
            label: 'accepted-verdict',
            status: 'failed',
            exitCode: 1,
            summary: `review verdict is ${review?.verdict ?? 'missing'}`,
          });
          failApply(formatResult(sprintId, sprint, steps, opts.json, EXIT_BLOCKED));
        }
        steps.push({
          label: 'accepted-verdict',
          status: 'passed',
          exitCode: 0,
          summary: 'review accepted',
        });

        if (!reviewedSprint) {
          failApply({
            exitCode: EXIT_BLOCKED,
            stdout: '',
            stderr: `sprint not found: ${sprintId}\n`,
          });
        }

        const close = await runCloseCommand(sprintId, {
          cwd,
          dryRun: false,
          json: true,
          skipChecks: true,
          skipCleanCheck: true,
          // The close commit batches every RK mutation ship made (review
          // file, sprint, queue, registry, aliases). `--no-commit` skips it.
          commit: opts.commit !== false,
        });
        steps.push(
          step(
            'close',
            close.exitCode,
            close.exitCode === 0 ? 'sprint closed' : close.stderr.trim(),
          ),
        );
        if (close.exitCode !== 0) {
          failApply(formatResult(sprintId, sprint, steps, opts.json, close.exitCode));
        }

        return null;
      },
    );
    if (applyResult) return applyResult;
    if (!appliedReviewId) {
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${sprintId} has no review_id\n` };
    }

    const postValidate = await runValidateCommand({ cwd, json: true, failOn: 'P1' });
    steps.push(
      step(
        'validate-post-close',
        postValidate.exitCode,
        postValidate.exitCode === 0
          ? 'post-close validation passed'
          : 'post-close validation failed',
      ),
    );
    if (postValidate.exitCode !== 0)
      return formatResult(sprintId, sprint, steps, opts.json, postValidate.exitCode);

    const postRegistry = await runRegistryCommand({
      cwd,
      write: false,
      check: true,
      explain: true,
      json: true,
    });
    steps.push(
      step(
        'registry-check-post-close',
        postRegistry.exitCode,
        postRegistry.exitCode === 0
          ? 'post-close registry --check passed'
          : 'post-close registry drift detected',
      ),
    );
    return formatResult(
      sprintId,
      sprint,
      steps,
      opts.json,
      postRegistry.exitCode,
      await getPublishState(cwd),
    );
  } catch (cause) {
    if (cause instanceof ShipApplyFailure) return cause.result;
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function failApply(result: CommandResult): never {
  throw new ShipApplyFailure(result);
}

function step(label: string, exitCode: number, summary: string): ShipStep {
  return { label, status: exitCode === 0 ? 'passed' : 'failed', exitCode, summary };
}

function previewSteps(status: string, evidenceCommand?: string): ShipStep[] {
  const steps: ShipStep[] = [
    {
      label: 'review',
      status: status === 'review' ? 'skipped' : 'passed',
      exitCode: null,
      summary: status === 'review' ? 'already in review' : 'would move active sprint to review',
    },
    {
      label: 'configured-checks',
      status: 'passed',
      exitCode: null,
      summary: 'would run configured checks when present',
    },
    {
      label: 'diff-paths',
      status: 'passed',
      exitCode: null,
      summary: 'would verify changed files against path policy',
    },
    {
      label: 'review-sprint',
      status: 'passed',
      exitCode: null,
      summary: 'would run review-sprint',
    },
    { label: 'close', status: 'passed', exitCode: null, summary: 'would close sprint' },
    { label: 'validate', status: 'passed', exitCode: null, summary: 'would validate project' },
    {
      label: 'registry-check',
      status: 'passed',
      exitCode: null,
      summary: 'would check registry drift',
    },
  ];
  if (evidenceCommand !== undefined) {
    steps.splice(4, 0, {
      label: 'evidence-cmd',
      status: 'passed',
      exitCode: null,
      summary: `would run evidence command: ${evidenceCommand}`,
    });
  }
  return steps;
}

function formatResult(
  sprintId: string,
  sprint: { allowed_paths: readonly string[]; denied_paths: readonly string[] },
  steps: readonly ShipStep[],
  json: boolean,
  exitCode: number,
  publishState?: PublishStateReport,
): CommandResult {
  if (json) {
    return {
      exitCode,
      stdout: emitJson({
        ok: exitCode === 0,
        data: {
          sprint_id: sprintId,
          steps,
          publish_state: publishState ?? { state: 'unknown', remotes: [] },
        },
        warnings: [],
        next_actions: [],
      }),
      stderr: '',
    };
  }
  const lines = [
    `Ship ${sprintId}`,
    '',
    `allowed_paths: ${formatPaths(sprint.allowed_paths)}`,
    `denied_paths: ${formatPaths(sprint.denied_paths)}`,
    '',
    ...steps.map((s) => `${s.status.padEnd(7)} ${s.label} — ${s.summary}`),
  ];
  return { exitCode, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function formatPaths(paths: readonly string[]): string {
  return paths.length === 0 ? '(none)' : paths.join(', ');
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}
