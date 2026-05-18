import type { Config, Sprint } from '@repokernel/core';
import { runConfiguredChecksFromConfig } from './checks.js';
import { changedFilesSince } from './git.js';
import { validateChangedFilesForSprint } from './pathPolicy.js';
import { appendReviewEvidence, buildCommandEvidence } from './reviewEvidence.js';
import { findSprintWorktreePath } from './worktree.js';

export interface SprintGateStep {
  readonly label: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly exitCode: number | null;
  readonly summary: string;
}

export interface SprintGateResult {
  readonly steps: readonly SprintGateStep[];
  readonly failed: boolean;
}

export interface SprintGateOptions {
  readonly cwd: string;
  readonly config: Config;
  readonly sprint: Sprint;
  readonly reviewFile?: string;
  readonly configuredChecks: 'run' | 'skip' | 'omit';
  readonly recordEvidence: boolean;
}

export async function runPreCloseSprintGates(opts: SprintGateOptions): Promise<SprintGateResult> {
  const steps: SprintGateStep[] = [];
  const evidenceTarget = opts.recordEvidence && opts.sprint.review_id ? opts.sprint.id : null;
  const checkCwd = (await findSprintWorktreePath(opts.sprint.id, opts.cwd)) ?? opts.cwd;

  const record = async (
    label: string,
    command: string | undefined,
    exitCode: number | null,
    summary: string,
    status?: SprintGateStep['status'],
  ): Promise<SprintGateStep> => {
    const finalStatus =
      status ?? (exitCode === 0 ? 'passed' : exitCode === null ? 'skipped' : 'failed');
    const step = { label, status: finalStatus, exitCode, summary };
    steps.push(step);
    if (evidenceTarget) {
      await appendReviewEvidence(
        opts.cwd,
        evidenceTarget,
        buildCommandEvidence({
          label,
          ...(command !== undefined ? { command } : {}),
          exitCode,
          status: finalStatus,
          summary,
        }),
      );
    }
    return step;
  };

  if (opts.configuredChecks === 'skip') {
    await record(
      'configured-checks',
      undefined,
      null,
      'configured checks skipped by request',
      'skipped',
    );
  } else if (opts.configuredChecks === 'run') {
    if (opts.config.automation.checksCmd) {
      const checks = await runConfiguredChecksFromConfig(opts.config, checkCwd);
      const step = await record(
        'configured-checks',
        opts.config.automation.checksCmd,
        checks.code,
        checks.ok ? 'configured checks passed' : `configured checks failed (exit ${checks.code})`,
      );
      if (step.status === 'failed') return { steps, failed: true };
    } else {
      await record(
        'configured-checks',
        undefined,
        null,
        'automation.checksCmd is not configured',
        'skipped',
      );
    }
  }

  if (!opts.sprint.base_sha) {
    await record(
      'diff-paths',
      undefined,
      1,
      'sprint has no base_sha; path policy cannot be verified',
    );
    return { steps, failed: true };
  }

  const changed = await changedFilesSince(checkCwd, opts.sprint.base_sha);
  const exemptPaths = [
    opts.sprint.file,
    ...(opts.reviewFile !== undefined ? [opts.reviewFile] : []),
  ];
  const pathFailure = validateChangedFilesForSprint(opts.sprint, changed, exemptPaths);
  const step = await record(
    'diff-paths',
    `git diff --name-only ${opts.sprint.base_sha}`,
    pathFailure ? 1 : 0,
    pathFailure ? pathFailure.message : `${changed.length} changed file(s) within path policy`,
  );
  return { steps, failed: step.status === 'failed' };
}
