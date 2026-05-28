import { mkdir, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  type Config,
  EPIC_ID_RE,
  type EpicId,
  effectiveReviewer,
  effectiveReviewRequired,
  escapeRegexLiteral,
  type Finding,
  findingAppliesToTarget,
  findNewlyUnblockedSprints,
  loadConfig,
  loadProject,
  materialPathGlobs,
  meetsThreshold,
  RepoKernelError,
  type SprintId,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { runConfiguredChecksFromConfig } from '../lifecycle/checks.js';
import { isWorktreeCheckout } from '../lifecycle/controlPaths.js';
import { classifySprintDiff } from '../lifecycle/diffClassifier.js';
import { isExternalAgentEnvironment } from '../lifecycle/executionOwnership.js';
import {
  changedFilesForSprint,
  getCurrentSha,
  getPublishState,
  isWorkingTreeClean,
  stagePathsAndCommit,
  tryRevertRange,
} from '../lifecycle/git.js';
import { ambientJournalAtomicCreate } from '../lifecycle/journal.js';
import {
  deleteSprintFrontmatterKeys,
  mutateReviewFrontmatter,
  mutateSprintFrontmatter,
  removeSlotFromQueue,
} from '../lifecycle/mutate.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import { applyWarningBaseline } from '../lifecycle/warningBaseline.js';
import {
  acquireSprintExecutionWorktree,
  findSprintWorktreePath,
  type SprintWorktreeInfo,
} from '../lifecycle/worktree.js';
import { isoNow } from '../templates/time.js';
import { reconcileTaskAliases } from './fastpath/taskAlias.js';
import { appendSlotToQueue, computeNextSlot } from './queue.js';
import type { CommandResult } from './validate.js';

// findingAppliesToSprint moved to @repokernel/core as findingAppliesToTarget
// (validator/targetScoped.ts). Keep the local alias so reading this file
// top-to-bottom still tells you what the filter does.
const findingAppliesToSprint = findingAppliesToTarget;

export async function resolveCloseCheckPath(sprintId: string, controlCwd: string): Promise<string> {
  // 1. Active run state / worktrees.json: authoritative when run-driven.
  const fromRun = await findSprintWorktreePath(sprintId, controlCwd);
  if (fromRun) return fromRun;
  // 2. Fall back to control cwd. (When the operator runs `rk close` from inside
  //    a sprint worktree, controlCwd already resolves there via --cwd / F13.)
  //    Lane is intentionally NOT consulted — a lane is not a worktree identifier.
  return controlCwd;
}

export interface StartCommandOptions {
  readonly cwd: string;
  readonly force: boolean;
  readonly enqueue: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  /**
   * Tristate worktree override. `true` forces acquisition (`always`), `false`
   * forces metadata-only (`never`), `undefined` defers to `config.start.worktree`.
   */
  readonly worktree?: boolean;
}

/**
 * Resolve whether `rk start` should acquire an isolated sprint worktree.
 *
 * `--worktree`/`--no-worktree` (opts.worktree) win over `config.start.worktree`.
 * `auto` acquires only when RepoKernel owns the environment: not already inside
 * a worktree, and not under an external agent/editor.
 */
async function resolveStartWorktree(
  opts: StartCommandOptions,
  config: Config,
  cwd: string,
): Promise<{ readonly acquire: boolean; readonly reason: string }> {
  const mode: 'auto' | 'always' | 'never' =
    opts.worktree === true ? 'always' : opts.worktree === false ? 'never' : config.start.worktree;

  if (mode === 'never') {
    return { acquire: false, reason: 'start.worktree resolved to never' };
  }
  if (await isWorktreeCheckout(cwd)) {
    return { acquire: false, reason: 'already inside a worktree' };
  }
  if (mode === 'always') {
    return { acquire: true, reason: 'start.worktree resolved to always' };
  }
  // auto
  if (isExternalAgentEnvironment()) {
    return { acquire: false, reason: 'an external agent or editor owns the environment' };
  }
  return { acquire: true, reason: 'start.worktree resolved to auto' };
}

export interface ReviewCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  /**
   * Auto-commit the review-side `.repokernel/` mutations. Defaults to true so
   * the lifecycle command owns the commit of the state it wrote. Callers that
   * batch their own commit (e.g. `rk ship`) pass false.
   */
  readonly commit?: boolean;
}

export interface CloseCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  /** When true, skip the configured `automation.checksCmd` even if set. */
  readonly skipChecks?: boolean;
  /** Internal ship path: clean tree was checked before ship-owned metadata writes. */
  readonly skipCleanCheck?: boolean;
  /**
   * When true, omit the "Next: git add ... && git commit ..." hint from the
   * non-JSON output. Set by the fastpath close wrapper, which commits the
   * close-side metadata itself after delegating to this command.
   */
  readonly omitCommitHint?: boolean;
  /**
   * Auto-commit the close-side `.repokernel/` mutations. Defaults to true so
   * the lifecycle command owns the commit of the state it wrote. Callers that
   * batch their own commit (`rk ship`, fastpath close) pass false.
   */
  readonly commit?: boolean;
}

export interface ReopenCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface CancelCommandOptions {
  readonly cwd: string;
  readonly reason?: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

// — start —

export async function runStartCommand(
  id: string,
  opts: StartCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      if (EPIC_ID_RE.test(id))
        return err(
          'EPIC_ID_IN_SPRINT_COMMAND',
          `${id} is an epic`,
          `start its sprints individually with rk start S-NNN`,
        );
      return notFound('sprint', id);
    }

    // status check
    const ALLOWED = new Set(['queued', 'reopened']);
    const FORCE_ALLOWED = new Set(['planned', 'pending']);
    const enqueueable = sprint.status === 'planned' && opts.enqueue;
    if (!ALLOWED.has(sprint.status) && !enqueueable) {
      if (opts.force && FORCE_ALLOWED.has(sprint.status)) {
        // allowed via --force — falls through with warning
      } else {
        if (sprint.status === 'planned') {
          return err(
            `INVALID_STATUS`,
            `rk start requires status queued or reopened (got: planned)`,
            `run rk queue add ${id} --lane ${sprint.lane} first, or rk start ${id} --enqueue to promote and start in one step`,
          );
        }
        return err(
          `INVALID_STATUS`,
          `rk start requires status queued or reopened (got: ${sprint.status})`,
          sprint.status === 'active'
            ? 'sprint is already active'
            : `use rk ${sprint.status === 'shipped' ? 'reopen' : 'close'} first`,
        );
      }
    }

    // gate check
    if (sprint.gate) {
      return err(
        'GATE_BLOCKED',
        `sprint has unresolved gate: ${sprint.gate}`,
        'resolve the gate before starting',
      );
    }

    // queue check
    const laneQueues = [...outcome.graph.queuesByLane.values()].flat();
    let slot = laneQueues.find((s) => s.sprint_id === id);
    if (!slot && !opts.force && !enqueueable) {
      return err(
        'SPRINT_NOT_IN_QUEUE',
        `${id} is not in any queue`,
        `rk queue add ${id} --lane ${sprint.lane}`,
      );
    }
    if (!slot && enqueueable) {
      const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
      if (!queue) {
        return err(
          'QUEUE_NOT_FOUND',
          `no queue file found for lane "${sprint.lane}"`,
          `create the queue file before using --enqueue`,
        );
      }
      const { nextSlotId, nextOrder } = computeNextSlot(queue.slots);
      slot = { id: nextSlotId, sprint_id: id, order: nextOrder };
    }

    // head of queue check
    if (slot) {
      const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
      if (queue) {
        const sortedSlots = [...queue.slots].sort((a, b) => a.order - b.order);
        const eligible = sortedSlots.find((s) => {
          const sp = outcome.graph.sprints.get(s.sprint_id);
          return sp && !['shipped', 'cancelled'].includes(sp.status);
        });
        if (eligible && eligible.sprint_id !== id) {
          const blocker = outcome.graph.sprints.get(eligible.sprint_id);
          return err(
            'NOT_HEAD_OF_QUEUE',
            `${eligible.sprint_id} is ahead of ${id} in lane ${sprint.lane} queue (order ${eligible.order})`,
            `close or skip ${eligible.sprint_id} first${blocker ? ` (status: ${blocker.status})` : ''} — rk run --dry-run shows queue position`,
          );
        }
      }
    }

    // dependency check
    for (const depId of sprint.depends_on) {
      const dep = outcome.graph.sprints.get(depId);
      if (!dep || dep.status !== 'shipped') {
        return err(
          'DEPENDENCY_NOT_SHIPPED',
          `dependency ${depId} is not shipped (status: ${dep?.status ?? 'missing'})`,
          `ship ${depId} first`,
        );
      }
    }

    // active lane check
    const activeSprints = [...outcome.graph.sprints.values()].filter(
      (s) => s.status === 'active' && s.lane === sprint.lane,
    );
    if (activeSprints.length > 0 && !outcome.config.policies.allowMultipleActivePerLane) {
      const other = activeSprints[0];
      const otherId = other?.id ?? 'that sprint';
      return err(
        'LANE_ALREADY_ACTIVE',
        `${other?.id ?? 'another sprint'} is already active in lane ${sprint.lane}`,
        `close, cancel, or review ${otherId} first (rk cancel ${otherId} if abandoned)`,
      );
    }

    if (opts.dryRun) return dryRunOk('start', { id, from: sprint.status, to: 'active' });

    // Resolve and (when applicable) acquire an isolated sprint worktree before
    // the metadata mutation, so the sprint is started inside the worktree the
    // caller will actually work in.
    const worktreeDecision = await resolveStartWorktree(opts, outcome.config, cwd);
    let executionCwd = cwd;
    let acquiredWorktree: SprintWorktreeInfo | null = null;
    if (worktreeDecision.acquire) {
      acquiredWorktree = await acquireSprintExecutionWorktree(
        sprint.epic_id as EpicId,
        id as SprintId,
        outcome.config,
        cwd,
      );
      executionCwd = acquiredWorktree.path;
    }

    const baseSha = await getCurrentSha(executionCwd);
    const mutations = { status: 'active', started_at: isoNow(), base_sha: baseSha };
    let findings: readonly Finding[] = [];
    await withLifecycleScope(
      { cwd: executionCwd, command: 'start', args: { sprintId: id } },
      async (tx) => {
        if (enqueueable && slot) {
          const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
          if (queue) {
            // Atomic + lane-locked. Slot id/order are recomputed inside the
            // lock from the current on-disk queue, ignoring the precomputed
            // snapshot — protects against duplicate Q-NNN under concurrent
            // rk start invocations on the same lane.
            await appendSlotToQueue(join(executionCwd, queue.file), id, tx.opRoot, sprint.lane);
          }
        }
        await tx.lockedMutate(`sprint-${id}`, () =>
          mutateSprintFrontmatter(join(executionCwd, sprint.file), mutations),
        );
        ({ findings } = await tx.refreshRegistry());
      },
    );
    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const forceWarn =
      opts.force && FORCE_ALLOWED.has(sprint.status)
        ? `\n${pc.yellow('  Warning')}  started from ${sprint.status} via --force; queue semantics bypassed\n`
        : '';

    const out = [
      `Started ${id}`,
      '',
      `  ${pc.bold('Sprint')}   ${id} — ${sprint.title}`,
      `  ${pc.bold('Epic')}     ${sprint.epic_id}`,
      `  ${pc.bold('Lane')}     ${sprint.lane}`,
      `  ${pc.bold('Base')}     ${baseSha.slice(0, 7)}`,
      ...(acquiredWorktree
        ? [
            `  ${pc.bold('Worktree')} ${acquiredWorktree.path}`,
            `  ${pc.bold('Branch')}   ${acquiredWorktree.branch}`,
          ]
        : []),
      `  ${pc.bold('allowed_paths')} ${formatPathList(sprint.allowed_paths)}`,
      `  ${pc.bold('denied_paths')}  ${formatPathList(sprint.denied_paths)}`,
      forceWarn,
      '',
      acquiredWorktree
        ? `Next: cd ${acquiredWorktree.path}, implement, ${pc.dim('git commit')}, then ${pc.dim(`rk review ${id}`)}`
        : `Next: implement, then ${pc.dim('git commit')} implementation, then ${pc.dim(`rk review ${id}`)}`,
    ];

    if (blocking.length > 0) {
      out.push(
        '',
        pc.yellow(`Warning: ${blocking.length} finding(s) after mutation — run rk validate`),
      );
    }

    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — review —

export async function runReviewCommand(
  id: string,
  opts: ReviewCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      if (EPIC_ID_RE.test(id))
        return err(
          'EPIC_ID_IN_SPRINT_COMMAND',
          `${id} is an epic`,
          `review sprints individually with rk review S-NNN`,
        );
      return notFound('sprint', id);
    }

    if (sprint.status !== 'active') {
      return err(
        'INVALID_STATUS',
        `rk review requires status active (got: ${sprint.status})`,
        sprint.status === 'review' ? 'sprint is already in review' : `use rk start ${id} first`,
      );
    }

    if (!sprint.base_sha) {
      return err(
        'MISSING_BASE_SHA',
        `${id} has no base_sha`,
        `run rk start ${id} to capture base SHA`,
      );
    }

    // diff check
    const changed = await changedFilesForSprint(cwd, sprint.base_sha);
    if (changed.files.length === 0) {
      return err(
        'EMPTY_DIFF',
        `no changes since base_sha ${sprint.base_sha.slice(0, 7)}`,
        'commit your implementation before running rk review',
      );
    }

    const queueFile = outcome.parsed.queues.find((q) => q.lane === sprint.lane)?.file;
    const reviewFile =
      sprint.review_id !== undefined
        ? outcome.graph.reviews.get(sprint.review_id)?.file
        : undefined;
    const classification = classifySprintDiff({
      config: outcome.config,
      sprint,
      changed,
      exemptPaths: [
        sprint.file,
        outcome.config.paths.registry,
        ...(queueFile !== undefined ? [queueFile] : []),
        ...(reviewFile !== undefined ? [reviewFile] : []),
      ],
      ...(reviewFile !== undefined ? { reviewFile } : {}),
      rkOwnedGlobs: materialPathGlobs(outcome.config),
    });
    const pathBlocker = classification.blockers[0];
    if (pathBlocker) {
      const path = pathBlocker.paths[0] ?? '(unknown path)';
      return err(
        pathBlocker.category === 'denied_path' ? 'DENIED_PATH' : 'OUT_OF_SCOPE_PATH',
        pathBlocker.category === 'denied_path'
          ? `${sprint.id} modified denied path: ${path}`
          : `${path} is outside allowed_paths for ${sprint.id}`,
        pathBlocker.next_actions.join('; '),
      );
    }

    if (opts.dryRun) {
      return dryRunOk('review', {
        id,
        changed: changed.files.length,
        from: 'active',
        to: 'review',
      });
    }

    // auto-create review if missing
    const updated: string[] = [];
    let reviewId = sprint.review_id ?? null;
    let preparedReview: { reviewPath: string; content: string } | null = null;
    if (!reviewId) {
      const cfg = await loadConfig({ cwd });
      if (!cfg.ok) return configError();
      const reviewsDir = join(cwd, cfg.config.paths.reviews);
      reviewId = await deterministicReviewId(reviewsDir, id);
      const reviewPath = join(reviewsDir, `${reviewId}.md`);
      const content = reviewStub(reviewId, id, effectiveReviewer(outcome.config.automation));
      await mkdir(reviewsDir, { recursive: true });
      preparedReview = { reviewPath, content };
    }

    let findings: readonly Finding[] = [];
    let reviewFilePath: string | null = null;
    await withLifecycleScope({ cwd, command: 'review', args: { sprintId: id } }, async (tx) => {
      if (preparedReview && reviewId) {
        await ambientJournalAtomicCreate(preparedReview.reviewPath, preparedReview.content);
        await tx.lockedMutate(`sprint-${id}`, () =>
          mutateSprintFrontmatter(join(cwd, sprint.file), { review_id: reviewId }),
        );
        updated.push(`${relative(cwd, preparedReview.reviewPath)}  (created)`);
      }

      // write diff metadata to review
      const reviewFile = await findReviewFile(cwd, reviewId as string, outcome);
      reviewFilePath = reviewFile ?? preparedReview?.reviewPath ?? null;
      if (reviewFile) {
        const pathsChecked: Record<string, boolean> = { denied_paths_clean: true };
        if (sprint.allowed_paths.length > 0) pathsChecked.allowed_paths_matched = true;
        await tx.lockedMutate(`review-${reviewId}`, () =>
          mutateReviewFrontmatter(reviewFile, {
            changed_files: changed.files,
            paths_checked: pathsChecked,
          }),
        );
        updated.push(`${relative(cwd, reviewFile)}  (diff metadata written)`);
      }

      await tx.lockedMutate(`sprint-${id}`, () =>
        mutateSprintFrontmatter(join(cwd, sprint.file), { status: 'review' }),
      );
      updated.push(`${sprint.file}  (status → review)`);

      ({ findings } = await tx.refreshRegistry());
    });

    // The lifecycle command owns the commit of the state it wrote: stage and
    // commit the review-side `.repokernel/` mutations so the next command
    // (rk close, which requires a clean tree) is not blocked by them. A
    // non-git or unreadable tree resolves as clean — auto-commit is then a
    // no-op rather than a hard failure.
    const reviewTreeClean = await isWorkingTreeClean(cwd).catch(() => true);
    if (opts.commit !== false && !reviewTreeClean) {
      const reviewCommitPaths = [join(cwd, sprint.file), join(cwd, outcome.config.paths.registry)];
      if (reviewFilePath) reviewCommitPaths.push(reviewFilePath);
      await stagePathsAndCommit(cwd, reviewCommitPaths, `chore(rk): record review for ${id}`);
    }

    // Scope blocking findings to ones that legitimately gate this sprint's
    // review. Findings about *other* queued sprints (e.g. their unshipped
    // upstream dependency, which may simply be this sprint itself) are
    // observable info, not a reason to halt this review.
    const postRefreshOutcome = await loadProject({ cwd });
    const scopedGraph = postRefreshOutcome.ok ? postRefreshOutcome.graph : outcome.graph;
    const blocking = findings
      .filter((f) => meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold))
      .filter((f) => findingAppliesToSprint(f, id, scopedGraph));

    const out = [
      `Sprint ${id} moved to review`,
      '',
      `  ${pc.bold('Base SHA')}   ${sprint.base_sha.slice(0, 7)}`,
      `  ${pc.bold('Changed')}    ${changed.files.length} file${changed.files.length !== 1 ? 's' : ''}`,
      '',
      ...changed.files.map((f) => `  ${f}`),
      '',
      'Updated:',
      ...updated.map((u) => `  ${u}`),
      '',
      `Next: set verdict: accepted in ${reviewId}.md, then ${pc.dim(`rk close ${id}`)}`,
    ];

    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — close —

interface ClosePhase {
  readonly name: 'precheck' | 'checks' | 'mutate' | 'commit';
  readonly status: 'ok' | 'skipped';
  readonly ms: number;
}

const elapsed = (since: number): number => Date.now() - since;

const formatMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

export async function runCloseCommand(
  id: string,
  opts: CloseCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const closeStart = Date.now();

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      if (EPIC_ID_RE.test(id))
        return err('EPIC_ID_IN_SPRINT_COMMAND', `${id} is an epic`, `use rk epic close ${id}`);
      return notFound('sprint', id);
    }

    const ALLOWED_FROM_REVIEW = sprint.status === 'review';
    const ALLOWED_FROM_ACTIVE = sprint.status === 'active' && !sprint.review_required;
    if (!ALLOWED_FROM_REVIEW && !ALLOWED_FROM_ACTIVE) {
      if (sprint.status === 'active' && sprint.review_required) {
        return err(
          'REVIEW_REQUIRED',
          `${id} is active and review_required: true`,
          `run rk review ${id} first`,
        );
      }
      return err(
        'INVALID_STATUS',
        `rk close requires status review (got: ${sprint.status})`,
        sprint.status === 'shipped' ? 'sprint is already shipped' : `transition to review first`,
      );
    }

    // clean tree check (honors config.git.requireCleanWorkingTreeForClose)
    if (!opts.skipCleanCheck && outcome.config.git.requireCleanWorkingTreeForClose) {
      const checkPath = await resolveCloseCheckPath(id, cwd);
      const clean = await isWorkingTreeClean(checkPath);
      if (!clean) {
        return err(
          'DIRTY_WORKING_TREE',
          `working tree at ${checkPath} has uncommitted changes`,
          'commit implementation before closing',
        );
      }
    }

    // review verdict check — single source of truth via
    // `effectiveReviewRequired`, which combines requireReviewForShipped,
    // the per-sprint review_required flag, and
    // requireReviewForShippedFromSprintId (the threshold rule that
    // closes the bypass identified in finding 12).
    const policyThreshold = outcome.config.policies.requireReviewForShippedFromSprintId;
    const reviewRequired = effectiveReviewRequired(sprint, outcome.config);
    const policyRequiresReview = reviewRequired && !sprint.review_required;
    if (reviewRequired) {
      const policyHint = policyRequiresReview
        ? ` (policy: requireReviewForShippedFromSprintId=${policyThreshold})`
        : '';
      if (!sprint.review_id) {
        return err(
          'MISSING_REVIEW',
          `${id} requires a review${policyHint} but no review_id is set`,
          `run rk review ${id} first`,
        );
      }
      const review = outcome.graph.reviews.get(sprint.review_id);
      if (!review) {
        return err(
          'REVIEW_NOT_FOUND',
          `review ${sprint.review_id} not found${policyHint}`,
          'create the review file first',
        );
      }
      if (review.verdict !== 'accepted') {
        return err(
          'REVIEW_NOT_ACCEPTED',
          `${sprint.review_id} verdict is ${review.verdict}${policyHint}`,
          'accept the review before closing',
        );
      }
    }

    if (opts.dryRun) return dryRunOk('close', { id, from: sprint.status, to: 'shipped' });

    // Phase timings collected for the close summary so a long unattended close
    // shows clear, attributable boundaries (gates vs. mutation vs. commit)
    // instead of one opaque wait.
    const phases: ClosePhase[] = [];
    const phaseStart = Date.now();
    phases.push({ name: 'precheck', status: 'ok', ms: phaseStart - closeStart });

    // Configured checks gate. The product advertises this safety gate before
    // close — wire it in for every close path (sprint, fastpath, autonomous
    // run loop). Use `--skip-checks` for emergencies.
    if (!opts.skipChecks) {
      const checks = await runConfiguredChecksFromConfig(outcome.config, cwd);
      if (checks.ran && !checks.ok) {
        return err(
          'CHECKS_FAILED',
          `configured checks failed (exit ${checks.code})`,
          'fix the failing checks, or pass --skip-checks to bypass',
        );
      }
      phases.push({
        name: 'checks',
        status: checks.ran ? 'ok' : 'skipped',
        ms: elapsed(phaseStart),
      });
    } else {
      phases.push({ name: 'checks', status: 'skipped', ms: 0 });
    }

    const endSha = await getCurrentSha(cwd);
    const closedAt = isoNow();
    const updated: string[] = [];
    const updatedPaths: string[] = [];

    const mutateStart = Date.now();
    let findings: readonly Finding[] = [];
    let aliasUpdates: Awaited<ReturnType<typeof reconcileTaskAliases>> = [];
    await withLifecycleScope({ cwd, command: 'close', args: { sprintId: id } }, async (tx) => {
      await tx.lockedMutate(`sprint-${id}`, () =>
        mutateSprintFrontmatter(join(cwd, sprint.file), {
          status: 'shipped',
          closed_at: closedAt,
          end_sha: endSha,
        }),
      );
      updated.push(sprint.file);
      updatedPaths.push(sprint.file);

      // set end_sha on review if missing
      if (sprint.review_id) {
        const review = outcome.graph.reviews.get(sprint.review_id);
        if (review?.file && !review.end_sha) {
          await tx.lockedMutate(`review-${sprint.review_id}`, () =>
            mutateReviewFrontmatter(join(cwd, review.file), { end_sha: endSha }),
          );
          updated.push(review.file);
          updatedPaths.push(review.file);
        }
      }

      // remove from queue
      const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
      if (queue) {
        const hasSlot = queue.slots.some((s) => s.sprint_id === id);
        if (hasSlot) {
          const removed = await removeSlotFromQueue(
            join(cwd, queue.file),
            id,
            tx.opRoot,
            sprint.lane,
          );
          if (removed.kind === 'removed') {
            updated.push(`${queue.file}  (removed slot, re-numbered)`);
            updatedPaths.push(queue.file);
          }
        }
      }

      ({ findings } = await tx.refreshRegistry());
      aliasUpdates = await reconcileTaskAliases(cwd, outcome.config, { sprintId: id });
    });
    phases.push({ name: 'mutate', status: 'ok', ms: elapsed(mutateStart) });
    updated.push(outcome.config.paths.registry);
    updatedPaths.push(outcome.config.paths.registry);

    for (const aliasUpdate of aliasUpdates) {
      updated.push(
        `${aliasUpdate.relativePath}  (${aliasUpdate.previousStatus} → ${aliasUpdate.nextStatus})`,
      );
      updatedPaths.push(aliasUpdate.relativePath);
    }

    // The lifecycle command owns the commit of the state it wrote: stage and
    // commit the close-side `.repokernel/` mutations so the working tree is
    // clean afterward. `--no-commit` (opts.commit === false) keeps the old
    // printed-hint behavior for callers that batch their own commit. A non-git
    // or unreadable tree resolves as clean — auto-commit is then a no-op.
    let committedSha: string | null = null;
    const commitStart = Date.now();
    const closeTreeClean = await isWorkingTreeClean(cwd).catch(() => true);
    if (opts.commit !== false && !closeTreeClean) {
      await stagePathsAndCommit(cwd, updatedPaths, `chore(rk): close ${id}`);
      committedSha = await getCurrentSha(cwd);
    }
    phases.push({
      name: 'commit',
      status: committedSha ? 'ok' : 'skipped',
      ms: elapsed(commitStart),
    });

    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    // Baseline-aware warning summary: classify P2/P3 findings into
    // already-waived (in warnings-baseline.json) vs. genuinely new, so a close
    // reports "N new, M baseline-suppressed" instead of an undifferentiated
    // count the operator has to triage by hand.
    const baseline = await applyWarningBaseline({ cwd, config: outcome.config, findings });
    const warningFindings = findings.filter((f) => f.severity === 'P2' || f.severity === 'P3');
    const baselineSuppressed = baseline.application?.active_count ?? 0;
    const newWarnings = Math.max(0, warningFindings.length - baselineSuppressed);

    const reviewLine = sprint.review_id
      ? `  ${pc.bold('Review')}   ${sprint.review_id} accepted`
      : '';
    const newlyUnblocked = findNewlyUnblockedSprints(outcome.graph, id);
    const unblockedLines: string[] = [];
    if (newlyUnblocked.length > 0) {
      unblockedLines.push('', 'Newly unblocked:');
      for (const s of newlyUnblocked) {
        const deps = s.depends_on.map((dep) => (dep === id ? `${dep} ✓` : `${dep} ✓`)).join(', ');
        unblockedLines.push(`  ${s.id}  (deps: ${deps})`);
      }
    }
    const nextHintLine =
      newlyUnblocked.length > 0
        ? `Next: ${pc.dim(`rk queue add ${newlyUnblocked[0]?.id} --lane ${newlyUnblocked[0]?.lane} && rk start ${newlyUnblocked[0]?.id}`)}`
        : `Next: ${pc.dim('rk next')}`;
    const commitHintLines = committedSha
      ? [
          '',
          pc.dim(`Committed RepoKernel state: ${committedSha.slice(0, 7)} chore(rk): close ${id}`),
          '',
          nextHintLine,
        ]
      : opts.omitCommitHint
        ? []
        : [
            '',
            pc.dim('Metadata files updated. Commit RepoKernel changes.'),
            '',
            `Next: ${pc.dim(`git add -- ${updatedPaths.map(shellQuote).join(' ')} && git commit -m ${shellQuote(`chore: close ${id}`)}`)}`,
            newlyUnblocked.length > 0
              ? `      ${pc.dim(`rk queue add ${newlyUnblocked[0]?.id} --lane ${newlyUnblocked[0]?.lane} && rk start ${newlyUnblocked[0]?.id}`)}`
              : `      ${pc.dim('rk next')}`,
          ];
    const out = [
      `Closed ${id}`,
      '',
      `  ${pc.bold('Sprint')}   ${id} — ${sprint.title}`,
      reviewLine,
      sprint.base_sha ? `  ${pc.bold('Start')}    ${sprint.base_sha.slice(0, 7)}` : '',
      `  ${pc.bold('End')}      ${endSha.slice(0, 7)}`,
      `  ${pc.bold('allowed_paths')} ${formatPathList(sprint.allowed_paths)}`,
      `  ${pc.bold('denied_paths')}  ${formatPathList(sprint.denied_paths)}`,
      '',
      'Updated:',
      ...updated.map((u) => `  ${u}`),
      ...unblockedLines,
      ...commitHintLines,
    ].filter((l) => l !== '');

    out.push('', pc.dim(`Phases: ${phases.map((p) => `${p.name} ${formatMs(p.ms)}`).join(', ')}`));
    if (warningFindings.length > 0) {
      out.push(pc.dim(`Warnings: ${newWarnings} new, ${baselineSuppressed} baseline-suppressed`));
    }
    if (blocking.length > 0) {
      out.push(
        '',
        pc.yellow(`Warning: ${blocking.length} finding(s) after mutation — run rk validate`),
      );
    }

    const publishState = await getPublishState(cwd);
    if (opts.json) {
      return {
        exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
        stdout: emitJson({
          ok: blocking.length === 0,
          data: {
            sprint_id: id,
            from: sprint.status,
            to: 'shipped',
            end_sha: endSha,
            updated: updatedPaths,
            committed_sha: committedSha,
            newly_unblocked: newlyUnblocked.map((s) => ({ id: s.id, lane: s.lane })),
            publish_state: publishState,
            phases,
            warning_summary: { new: newWarnings, baseline_suppressed: baselineSuppressed },
          },
          warnings: blocking,
          next_actions:
            publishState.state === 'not_pushed' || publishState.state === 'no_remote'
              ? ['publish branch or record local-only close intentionally']
              : [],
        }),
        stderr: '',
      };
    }

    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — reopen —

export async function runReopenCommand(
  id: string,
  opts: ReopenCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      if (EPIC_ID_RE.test(id))
        return err(
          'EPIC_ID_IN_SPRINT_COMMAND',
          `${id} is an epic`,
          `reopen sprints individually with rk reopen S-NNN`,
        );
      return notFound('sprint', id);
    }

    const ALLOWED = new Set(['review', 'shipped', 'active', 'cancelled']);
    if (!ALLOWED.has(sprint.status)) {
      return err(
        'INVALID_STATUS',
        `rk reopen requires status review, shipped, active, or cancelled (got: ${sprint.status})`,
        `${id} is ${sprint.status}`,
      );
    }

    // cancelled → planned (not reopened — no base_sha, no review to preserve)
    const targetStatus = sprint.status === 'cancelled' ? 'planned' : 'reopened';

    if (opts.dryRun) return dryRunOk('reopen', { id, from: sprint.status, to: targetStatus });

    const previousStatus = sprint.status;
    const reopenMutations: Record<string, unknown> = {
      status: targetStatus,
      end_sha: null,
      closed_at: null,
    };
    if (sprint.status === 'active') {
      reopenMutations.started_at = null;
    }
    if (targetStatus === 'planned') {
      reopenMutations.review_id = null;
      reopenMutations.started_at = null;
      reopenMutations.base_sha = null;
    }
    let findings: readonly Finding[] = [];
    await withLifecycleScope({ cwd, command: 'reopen', args: { sprintId: id } }, async (tx) => {
      await mutateSprintFrontmatter(join(cwd, sprint.file), reopenMutations);
      if (sprint.status === 'cancelled') {
        await deleteSprintFrontmatterKeys(join(cwd, sprint.file), ['cancel_reason']);
      }
      ({ findings } = await tx.refreshRegistry());
    });
    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const out = [
      `Sprint ${id} ${targetStatus}`,
      '',
      `  ${pc.bold('Previous status')}  ${previousStatus}`,
      sprint.review_id && targetStatus !== 'planned'
        ? `  ${pc.bold('review_id')}         ${sprint.review_id} (preserved)`
        : '',
      sprint.base_sha && targetStatus !== 'planned'
        ? `  ${pc.bold('base_sha')}          ${sprint.base_sha.slice(0, 7)} (preserved)`
        : '',
      '',
      `Next: ${pc.dim(`rk queue add ${id} --lane ${sprint.lane}`)} to re-enqueue`,
      `      ${pc.dim(`rk start ${id}`)} after re-queuing`,
    ].filter((l) => l !== '');

    if (blocking.length > 0) {
      out.push(
        '',
        pc.yellow(`Warning: ${blocking.length} finding(s) after mutation — run rk validate`),
      );
    }

    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — cancel —

export async function runCancelCommand(
  id: string,
  opts: CancelCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      if (EPIC_ID_RE.test(id))
        return err(
          'EPIC_ID_IN_SPRINT_COMMAND',
          `${id} is an epic`,
          `cancel sprints individually with rk cancel S-NNN`,
        );
      return notFound('sprint', id);
    }

    const TERMINAL = new Set(['shipped', 'cancelled']);
    if (TERMINAL.has(sprint.status)) {
      return err(
        'INVALID_STATUS',
        `rk cancel cannot transition a ${sprint.status} sprint`,
        sprint.status === 'cancelled'
          ? `${id} is already cancelled`
          : `${id} is shipped — use rk reopen ${id} if you need to revert`,
      );
    }

    const reason = opts.reason ?? 'manual';

    if (opts.dryRun) {
      return dryRunOk('cancel', { id, from: sprint.status, to: 'cancelled', reason });
    }

    const closedAt = isoNow();
    const updated: string[] = [];

    let findings: readonly Finding[] = [];
    await withLifecycleScope(
      { cwd, command: 'cancel', args: { sprintId: id, reason } },
      async (tx) => {
        await mutateSprintFrontmatter(join(cwd, sprint.file), {
          status: 'cancelled',
          closed_at: closedAt,
          cancel_reason: reason,
        });
        updated.push(sprint.file);

        // remove from queue if present (mirrors close)
        const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
        if (queue) {
          const hasSlot = queue.slots.some((s) => s.sprint_id === id);
          if (hasSlot) {
            const removed = await removeSlotFromQueue(
              join(cwd, queue.file),
              id,
              tx.opRoot,
              sprint.lane,
            );
            if (removed.kind === 'removed') {
              updated.push(`${queue.file}  (removed slot, re-numbered)`);
            }
          }
        }

        ({ findings } = await tx.refreshRegistry());
      },
    );
    updated.push(outcome.config.paths.registry);

    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const out = [
      `Cancelled ${id}`,
      '',
      `  ${pc.bold('Sprint')}   ${id} — ${sprint.title}`,
      `  ${pc.bold('From')}     ${sprint.status}`,
      `  ${pc.bold('Reason')}   ${reason}`,
      '',
      'Updated:',
      ...updated.map((u) => `  ${u}`),
      '',
      pc.dim('No review pipeline run. Lane is now free for the next start.'),
    ];

    if (blocking.length > 0) {
      out.push(
        '',
        pc.yellow(`Warning: ${blocking.length} finding(s) after mutation — run rk validate`),
      );
    }

    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — review verdict —

export interface ReviewVerdictCommandOptions {
  readonly cwd: string;
  readonly summary?: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export async function runReviewVerdictCommand(
  reviewId: string,
  verdict: string,
  opts: ReviewVerdictCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  const VALID_VERDICTS = ['accepted', 'changes_requested', 'rejected'];
  if (!VALID_VERDICTS.includes(verdict)) {
    return err(
      'INVALID_VERDICT',
      `invalid verdict "${verdict}"`,
      `use: accepted | changes_requested | rejected`,
    );
  }

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const review = outcome.graph.reviews.get(reviewId);
    if (!review) return notFound('review', reviewId);

    if (opts.dryRun) {
      return dryRunOk('review verdict', { reviewId, from: review.verdict, to: verdict });
    }

    const patch: Record<string, unknown> = {
      verdict,
      updated_at: isoNow(),
    };
    if (opts.summary) {
      patch.findings = [{ severity: 'LOW', message: opts.summary }];
    }

    let revertedCommit: string | undefined;
    let revertConflict = false;
    let findings: readonly Finding[] = [];
    await withLifecycleScope(
      { cwd, command: 'review-verdict', args: { reviewId, verdict } },
      async (tx) => {
        await mutateReviewFrontmatter(join(cwd, review.file), patch);

        // Auto-revert sprint commits when verdict is rejected and SHAs are available
        if (verdict === 'rejected') {
          const sprint = outcome.graph.sprints.get(review.sprint_id);
          if (sprint?.base_sha && sprint?.end_sha) {
            const revertResult = await tryRevertRange(
              cwd,
              sprint.base_sha,
              sprint.end_sha,
              `revert: sprint ${sprint.id} — review rejected`,
            );
            if (revertResult.ok) {
              revertedCommit = sprint.end_sha;
              await mutateSprintFrontmatter(join(cwd, sprint.file), { status: 'reopened' });
            } else {
              revertConflict = true;
              process.stderr.write(
                [
                  `warning: auto-revert of sprint ${sprint.id} failed (${revertResult.reason})`,
                  `  The review verdict is recorded as "rejected" but sprint commits were not reverted.`,
                  `  Resolve manually:`,
                  `    cd ${cwd}`,
                  `    git revert ${sprint.base_sha}..${sprint.end_sha}`,
                  `  Then reopen the sprint:`,
                  `    rk reopen ${sprint.id}`,
                  '',
                ].join('\n'),
              );
            }
          }
        }

        ({ findings } = await tx.refreshRegistry());
      },
    );
    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const out = [
      `Review ${reviewId} verdict set to ${verdict}`,
      '',
      `  ${pc.bold('Sprint')}   ${review.sprint_id}`,
      `  ${pc.bold('Verdict')}  ${verdict}`,
      `  ${pc.bold('Updated')}  ${isoNow()}`,
    ];

    if (revertedCommit) {
      out.push(`  ${pc.bold('Reverted')} ${revertedCommit.slice(0, 7)} — sprint reopened`);
    }
    if (revertConflict) {
      out.push(
        `  ${pc.yellow(pc.bold('Warning'))}  auto-revert failed — resolve manually (see stderr)`,
      );
    }

    if (verdict === 'accepted') {
      out.push('', `Next: ${pc.dim(`rk close ${review.sprint_id}`)}`);
    }

    if (blocking.length > 0) {
      out.push('', pc.yellow(`Warning: ${blocking.length} finding(s) — run rk validate`));
    }

    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    return runtimeErr(e);
  }
}

// — helpers —

function err(_code: string, message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${lines.join('\n')}\n` };
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}

function notFound(type: string, id: string): CommandResult {
  return err(`${type.toUpperCase()}_NOT_FOUND`, `${type} ${id} not found`);
}

function runtimeErr(e: unknown): CommandResult {
  if (e instanceof RepoKernelError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${message}\n` };
}

function dryRunOk(command: string, info: Record<string, unknown>): CommandResult {
  const lines = [`dry-run: ${command}`, ''];
  for (const [k, v] of Object.entries(info)) lines.push(`  ${k}: ${String(v)}`);
  lines.push('', 'No files written.');
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatPathList(paths: readonly string[]): string {
  return paths.length === 0 ? '(none)' : paths.join(', ');
}

async function nextId(dir: string, prefix: string): Promise<string> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const re = new RegExp(`^${prefix}-(\\d+)(?:-.+)?\\.md$`);
  const nums = files.flatMap((f) => {
    const m = re.exec(f);
    return m?.[1] !== undefined ? [parseInt(m[1], 10)] : [];
  });
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

function reviewStub(reviewId: string, sprintId: string, reviewer: string): string {
  return `---
id: ${reviewId}
sprint_id: ${sprintId}
verdict: pending
reviewer: ${JSON.stringify(reviewer)}
findings: []
changed_files: []
created_at: ${isoNow()}
---

# ${reviewId}: Review ${sprintId}
`;
}

/**
 * Build a deterministic review id from a sprint id (S-NNN → R-NNN).
 * Falls through to the legacy sequential nextId() if the deterministic id is
 * already taken on disk — guarantees uniqueness without surprises.
 */
async function deterministicReviewId(reviewsDir: string, sprintId: string): Promise<string> {
  const m = /^S-(\d+)(?:-.+)?$/.exec(sprintId);
  if (!m?.[1]) return nextId(reviewsDir, 'R');
  const candidate = `R-${m[1]}`;
  const files = await readdir(reviewsDir).catch(() => [] as string[]);
  const re = new RegExp(`^${escapeRegexLiteral(candidate)}(?:-.+)?\\.md$`);
  if (files.some((f) => re.test(f))) {
    return nextId(reviewsDir, 'R');
  }
  return candidate;
}

async function findReviewFile(
  cwd: string,
  reviewId: string,
  outcome: {
    graph: { reviews: ReadonlyMap<string, { file: string }> };
    config: { paths: { reviews: string } };
  },
): Promise<string | null> {
  const existing = outcome.graph.reviews.get(reviewId);
  if (existing) return join(cwd, existing.file);
  // newly created — find by scanning
  const reviewsDir = join(cwd, outcome.config.paths.reviews);
  const files = await readdir(reviewsDir).catch(() => [] as string[]);
  const re = new RegExp(`^${escapeRegexLiteral(reviewId)}(?:-.+)?\\.md$`);
  const match = files.find((f) => re.test(f));
  return match ? join(reviewsDir, match) : null;
}
