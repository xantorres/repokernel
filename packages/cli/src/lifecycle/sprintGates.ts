import { isAbsolute, relative } from 'node:path';
import { type Config, materialPathGlobs, type Sprint } from '@repokernel/core';
import { type GateCacheProfile, runConfiguredChecksFromConfigCached } from './checks.js';
import { classifySprintDiff, type SprintBlocker } from './diffClassifier.js';
import { changedFilesForSprint, changedLineCountForSprint } from './git.js';
import { appendReviewEvidence, buildCommandEvidence } from './reviewEvidence.js';
import { findSprintWorktreePath } from './worktree.js';

export interface SprintGateStep {
  readonly label: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly exitCode: number | null;
  readonly summary: string;
  readonly blockers?: readonly SprintBlocker[];
  readonly warnings?: readonly SprintBlocker[];
}

export interface SprintGateResult {
  readonly steps: readonly SprintGateStep[];
  readonly failed: boolean;
  readonly blockers: readonly SprintBlocker[];
  readonly warnings: readonly SprintBlocker[];
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
    extra?: {
      readonly blockers?: readonly SprintBlocker[];
      readonly warnings?: readonly SprintBlocker[];
    },
  ): Promise<SprintGateStep> => {
    const finalStatus =
      status ?? (exitCode === 0 ? 'passed' : exitCode === null ? 'skipped' : 'failed');
    const step = {
      label,
      status: finalStatus,
      exitCode,
      summary,
      ...(extra?.blockers !== undefined ? { blockers: extra.blockers } : {}),
      ...(extra?.warnings !== undefined ? { warnings: extra.warnings } : {}),
    };
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
      const checkBlockers = checks.ok
        ? []
        : classifyConfiguredCheckFailure({
            config: opts.config,
            sprint: opts.sprint,
            output: checks.output ?? '',
            roots: [checkCwd, opts.cwd],
            ...(opts.reviewFile !== undefined ? { reviewFile: opts.reviewFile } : {}),
          });
      const step = await record(
        'configured-checks',
        checksCommand,
        checks.code,
        checks.ok
          ? `configured checks passed${checks.cached === true ? ' (cached)' : ''}`
          : `configured checks failed (exit ${checks.code})`,
        undefined,
        checks.ok
          ? undefined
          : {
              blockers: checkBlockers,
            },
      );
      if (step.status === 'failed') {
        return { steps, failed: true, blockers: step.blockers ?? [], warnings: [] };
      }
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
    return { steps, failed: true, blockers: [], warnings: [] };
  }

  const changed = await changedFilesForSprint(checkCwd, opts.sprint.base_sha);
  const fileBudgetStep = await enforceFileBudget(record, opts.sprint, changed.files.length);
  if (fileBudgetStep?.status === 'failed')
    return { steps, failed: true, blockers: [], warnings: [] };

  const lineBudgetStep = await enforceLineBudget(record, checkCwd, opts.sprint);
  if (lineBudgetStep?.status === 'failed')
    return { steps, failed: true, blockers: [], warnings: [] };

  const queueFile = `${opts.config.paths.queues}/${opts.sprint.lane}.md`;
  const exemptPaths = [
    opts.sprint.file,
    opts.config.paths.registry,
    queueFile,
    ...(opts.reviewFile !== undefined ? [opts.reviewFile] : []),
  ];
  const classification = classifySprintDiff({
    config: opts.config,
    sprint: opts.sprint,
    changed,
    exemptPaths,
    ...(opts.reviewFile !== undefined ? { reviewFile: opts.reviewFile } : {}),
    rkOwnedGlobs: materialPathGlobs(opts.config),
  });
  const pathBlocker = classification.blockers[0];
  const step = await record(
    'diff-paths',
    `git diff/status union ${opts.sprint.base_sha}`,
    pathBlocker ? 1 : 0,
    pathBlocker
      ? `${pathBlocker.paths[0] ?? '(unknown path)'} is outside allowed_paths for ${opts.sprint.id}`
      : classification.warnings.length > 0
        ? `${changed.files.length} changed file(s) within path policy; ${classification.warnings[0]?.paths.length ?? 0} external dirty file(s) reported`
        : `${changed.files.length} changed file(s) within path policy`,
    undefined,
    { blockers: classification.blockers, warnings: classification.warnings },
  );
  return {
    steps,
    failed: step.status === 'failed',
    blockers: classification.blockers,
    warnings: classification.warnings,
  };
}

function classifyConfiguredCheckFailure(opts: {
  readonly config: Config;
  readonly sprint: Sprint;
  readonly output: string;
  readonly roots: readonly string[];
  readonly reviewFile?: string;
}): readonly SprintBlocker[] {
  const paths = extractRepoRelativePaths(opts.output, opts.roots);
  if (paths.length === 0) return [environmentBlocker(opts.sprint.id, [])];

  const classification = classifySprintDiff({
    config: opts.config,
    sprint: opts.sprint,
    changed: {
      files: paths,
      committed: paths,
      staged: [],
      unstaged: [],
      untracked: [],
    },
    exemptPaths: [
      opts.sprint.file,
      opts.config.paths.registry,
      `${opts.config.paths.queues}/${opts.sprint.lane}.md`,
      ...(opts.reviewFile !== undefined ? [opts.reviewFile] : []),
    ],
    ...(opts.reviewFile !== undefined ? { reviewFile: opts.reviewFile } : {}),
    rkOwnedGlobs: materialPathGlobs(opts.config),
  });
  const inScopePaths = classification.entries
    .filter((entry) => entry.category === 'in_scope')
    .map((entry) => entry.path);
  const generatedOrOwnedPaths = classification.entries
    .filter((entry) => entry.category === 'generated' || entry.category === 'rk_owned')
    .map((entry) => entry.path);
  const blockers: SprintBlocker[] = classification.blockers.map((blocker) =>
    withFocusedRecovery(blocker, opts.sprint.id),
  );
  if (inScopePaths.length > 0) {
    blockers.push({
      category: 'in_scope',
      scope: 'sprint',
      paths: inScopePaths,
      owner: 'sprint',
      next_actions: [
        `rk inspect ${opts.sprint.id}`,
        `rk gates ${opts.sprint.id} --profile focused --explain`,
      ],
    });
  }
  return blockers.length > 0
    ? blockers
    : [environmentBlocker(opts.sprint.id, generatedOrOwnedPaths)];
}

function environmentBlocker(sprintId: string, paths: readonly string[]): SprintBlocker {
  return {
    category: 'environment',
    scope: 'environment',
    paths,
    owner: 'environment',
    next_actions: [
      `rk gates ${sprintId} --profile focused --explain`,
      `rk blockers ${sprintId} --json`,
    ],
  };
}

function extractRepoRelativePaths(output: string, roots: readonly string[]): readonly string[] {
  const paths = new Set<string>();
  const pathLike =
    /(?:^|[\s('"`])((?:[A-Za-z]:)?\/[^\s:'")]+|\.{1,2}\/[^\s:'")]+|[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+|[A-Za-z0-9_.@-]+\.(?:json|ya?ml|md|scss|css|html|toml|lock|rs|go|py|sh|[cm]?[jt]sx?))(?::\d+)?(?::\d+)?/gu;
  let match = pathLike.exec(output);
  while (match !== null) {
    const candidate = normalizeCandidatePath(match[1] ?? '', roots);
    if (candidate !== null) paths.add(candidate);
    match = pathLike.exec(output);
  }
  return [...paths];
}

function withFocusedRecovery(blocker: SprintBlocker, sprintId: string): SprintBlocker {
  return {
    ...blocker,
    next_actions: [
      ...new Set([...blocker.next_actions, `rk gates ${sprintId} --profile focused --explain`]),
    ],
  };
}

function normalizeCandidatePath(candidate: string, roots: readonly string[]): string | null {
  const trimmed = candidate.replace(/[.,;)\]}]+$/u, '').replaceAll('\\', '/');
  if (trimmed.length === 0 || /^[a-z]+:\/\//iu.test(trimmed)) return null;
  if (isAbsolute(trimmed)) {
    for (const root of roots) {
      const rel = relative(root, trimmed).replaceAll('\\', '/');
      if (rel.length > 0 && !rel.startsWith('../') && rel !== '..') return rel;
    }
    return null;
  }
  const rel = trimmed.replace(/^\.\//u, '');
  if (rel.startsWith('../') || rel === '..') return null;
  return rel;
}

async function enforceFileBudget(
  record: (
    label: string,
    command: string | undefined,
    exitCode: number | null,
    summary: string,
    status?: SprintGateStep['status'],
  ) => Promise<SprintGateStep>,
  sprint: Sprint,
  changedFileCount: number,
): Promise<SprintGateStep | null> {
  const maxFiles = sprint.budget?.max_files;
  if (maxFiles === undefined) return null;
  return record(
    'budget-files',
    undefined,
    changedFileCount <= maxFiles ? 0 : 1,
    changedFileCount <= maxFiles
      ? `budget max_files passed (${changedFileCount}/${maxFiles})`
      : `budget max_files exceeded (${changedFileCount}/${maxFiles})`,
  );
}

async function enforceLineBudget(
  record: (
    label: string,
    command: string | undefined,
    exitCode: number | null,
    summary: string,
    status?: SprintGateStep['status'],
  ) => Promise<SprintGateStep>,
  cwd: string,
  sprint: Sprint,
): Promise<SprintGateStep | null> {
  const maxLoc = sprint.budget?.max_loc;
  if (maxLoc === undefined) return null;
  const changedLines = await changedLineCountForSprint(cwd, sprint.base_sha ?? '');
  return record(
    'budget-loc',
    `git diff --numstat ${sprint.base_sha}`,
    changedLines <= maxLoc ? 0 : 1,
    changedLines <= maxLoc
      ? `budget max_loc passed (${changedLines}/${maxLoc})`
      : `budget max_loc exceeded (${changedLines}/${maxLoc})`,
  );
}
