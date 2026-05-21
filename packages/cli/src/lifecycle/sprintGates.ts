import { type Config, materialPathGlobs, type Sprint } from '@repokernel/core';
import { type GateCacheProfile, runConfiguredChecksFromConfigCached } from './checks.js';
import { changedFilesForSprint } from './git.js';
import { effectivePathPolicyForSprint, validateChangedFilesForSprint } from './pathPolicy.js';
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
  readonly profile?: GateCacheProfile;
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
    const checksCommand =
      opts.config.automation.checksCmd ??
      (opts.config.automation.checksPhases !== undefined ? 'automation.checksPhases' : undefined);
    if (checksCommand !== undefined) {
      const checks = await runConfiguredChecksFromConfigCached(
        opts.config,
        checkCwd,
        opts.profile ?? 'sprint',
      );
      const step = await record(
        'configured-checks',
        checksCommand,
        checks.code,
        checks.ok
          ? `configured checks passed${checks.cached === true ? ' (cached)' : ''}`
          : `configured checks failed (exit ${checks.code})`,
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

  const changed = await changedFilesForSprint(checkCwd, opts.sprint.base_sha);
  const queueFile = `${opts.config.paths.queues}/${opts.sprint.lane}.md`;
  const exemptPaths = [
    opts.sprint.file,
    opts.config.paths.registry,
    queueFile,
    ...(opts.reviewFile !== undefined ? [opts.reviewFile] : []),
  ];
  const pathFailure = validateChangedFilesForSprint(
    opts.sprint,
    changed.files,
    exemptPaths,
    effectivePathPolicyForSprint({
      config: opts.config,
      sprint: opts.sprint,
      ...(opts.reviewFile !== undefined ? { reviewFile: opts.reviewFile } : {}),
    }),
    materialPathGlobs(opts.config),
  );
  const step = await record(
    'diff-paths',
    `git diff/status union ${opts.sprint.base_sha}`,
    pathFailure ? 1 : 0,
    pathFailure
      ? pathFailure.message
      : `${changed.files.length} changed file(s) within path policy`,
  );
  return { steps, failed: step.status === 'failed' };
}
