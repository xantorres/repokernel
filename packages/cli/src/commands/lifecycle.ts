import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  EPIC_ID_RE,
  effectiveReviewRequired,
  type Finding,
  findNewlyUnblockedSprints,
  type Graph,
  loadConfig,
  loadProject,
  meetsThreshold,
  RepoKernelError,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { runConfiguredChecks } from '../lifecycle/checks.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import {
  changedFilesSince,
  getCurrentSha,
  isWorkingTreeClean,
  tryRevertRange,
} from '../lifecycle/git.js';
import {
  mutateReviewFrontmatter,
  mutateSprintFrontmatter,
  removeSprintFromQueue,
} from '../lifecycle/mutate.js';
import { validateChangedFilesForSprint } from '../lifecycle/pathPolicy.js';
import { refreshRegistry } from '../lifecycle/registry.js';
import { findSprintWorktreePath } from '../lifecycle/worktree.js';
import { isoNow } from '../templates/time.js';
import { appendSlotToQueue, computeNextSlot } from './queue.js';
import type { CommandResult } from './validate.js';

/**
 * Decide whether a finding should gate the lifecycle command targeting `sprintId`.
 *
 * Returns true when the finding is about this sprint, its review, or a queue
 * slot that points at it. Global findings (no entityType / no entityId) also
 * apply — they typically describe parser or config failures that affect all
 * operations.
 *
 * Notably returns FALSE for findings about other sprints — e.g. a queued
 * downstream sprint blocked by an unshipped dependency that happens to be
 * the sprint under review. Those are observable but not blockers for this
 * sprint's transition.
 */
function findingAppliesToSprint(finding: Finding, sprintId: string, graph: Graph): boolean {
  if (!finding.entityType || !finding.entityId) return true;

  if (finding.entityType === 'sprint') return finding.entityId === sprintId;

  if (finding.entityType === 'review') {
    const review = graph.reviews.get(finding.entityId);
    return review ? review.sprint_id === sprintId : true;
  }

  if (finding.entityType === 'queue') {
    for (const slots of graph.queuesByLane.values()) {
      const slot = slots.find((s) => s.id === finding.entityId);
      if (slot) return slot.sprint_id === sprintId;
    }
    return true;
  }

  if (finding.entityType === 'epic') {
    const sprint = graph.sprints.get(sprintId);
    return sprint ? sprint.epic_id === finding.entityId : true;
  }

  return true;
}

async function resolveCloseCheckPath(sprintId: string, controlCwd: string): Promise<string> {
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
}

export interface ReviewCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface CloseCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
  /** When true, skip the configured `automation.checksCmd` even if set. */
  readonly skipChecks?: boolean;
  /**
   * When true, omit the "Next: git add ... && git commit ..." hint from the
   * non-JSON output. Set by the fastpath close wrapper, which commits the
   * close-side metadata itself after delegating to this command.
   */
  readonly omitCommitHint?: boolean;
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
            `${eligible.sprint_id} is ahead in queue (order ${eligible.order})`,
            `close or skip ${eligible.sprint_id} first${blocker ? ` (status: ${blocker.status})` : ''}`,
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

    if (enqueueable && slot) {
      const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
      if (queue) {
        // Atomic + lane-locked. Slot id/order are recomputed inside the
        // lock from the current on-disk queue, ignoring the precomputed
        // snapshot — protects against duplicate Q-NNN under concurrent
        // rk start invocations on the same lane.
        const opRoot = await operationalRootBestEffort(cwd);
        await appendSlotToQueue(join(cwd, queue.file), id, opRoot, sprint.lane);
      }
    }

    const baseSha = await getCurrentSha(cwd);
    const mutations = { status: 'active', started_at: isoNow(), base_sha: baseSha };
    await mutateSprintFrontmatter(join(cwd, sprint.file), mutations);

    const { findings } = await refreshRegistry(cwd);
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
      forceWarn,
      '',
      `Next: implement, then ${pc.dim('git commit')} implementation, then ${pc.dim(`rk review ${id}`)}`,
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
    const changed = await changedFilesSince(cwd, sprint.base_sha);
    if (changed.length === 0) {
      return err(
        'EMPTY_DIFF',
        `no changes since base_sha ${sprint.base_sha.slice(0, 7)}`,
        'commit your implementation before running rk review',
      );
    }

    const planStatePaths = [
      outcome.config.paths.sprints,
      outcome.config.paths.reviews,
      outcome.config.paths.queues,
      outcome.config.paths.registry,
    ];
    const pathFailure = validateChangedFilesForSprint(sprint, changed, planStatePaths);
    if (pathFailure) return err(pathFailure.code, pathFailure.message, pathFailure.suggestion);

    if (opts.dryRun) {
      return dryRunOk('review', { id, changed: changed.length, from: 'active', to: 'review' });
    }

    // auto-create review if missing
    const updated: string[] = [];
    let reviewId = sprint.review_id ?? null;
    if (!reviewId) {
      const cfg = await loadConfig({ cwd });
      if (!cfg.ok) return configError();
      const reviewsDir = join(cwd, cfg.config.paths.reviews);
      reviewId = await deterministicReviewId(reviewsDir, id);
      const reviewPath = join(reviewsDir, `${reviewId}.md`);
      const content = reviewStub(reviewId, id);
      await import('node:fs/promises').then((fs) =>
        fs
          .mkdir(reviewsDir, { recursive: true })
          .then(() => fs.writeFile(reviewPath, content, 'utf8')),
      );
      await mutateSprintFrontmatter(join(cwd, sprint.file), { review_id: reviewId });
      updated.push(`${relative(cwd, reviewPath)}  (created)`);
    }

    // write diff metadata to review
    const reviewFile = await findReviewFile(cwd, reviewId, outcome);
    if (reviewFile) {
      const pathsChecked: Record<string, boolean> = { denied_paths_clean: true };
      if (sprint.allowed_paths.length > 0) pathsChecked.allowed_paths_matched = true;
      await mutateReviewFrontmatter(reviewFile, {
        changed_files: changed,
        paths_checked: pathsChecked,
      });
      updated.push(`${relative(cwd, reviewFile)}  (diff metadata written)`);
    }

    await mutateSprintFrontmatter(join(cwd, sprint.file), { status: 'review' });
    updated.push(`${sprint.file}  (status → review)`);

    const { findings } = await refreshRegistry(cwd);
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
      `  ${pc.bold('Changed')}    ${changed.length} file${changed.length !== 1 ? 's' : ''}`,
      '',
      ...changed.map((f) => `  ${f}`),
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

export async function runCloseCommand(
  id: string,
  opts: CloseCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

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
    if (outcome.config.git.requireCleanWorkingTreeForClose) {
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

    // Configured checks gate. The product advertises this safety gate before
    // close — wire it in for every close path (sprint, fastpath, autonomous
    // run loop). Use `--skip-checks` for emergencies.
    if (!opts.skipChecks) {
      const checks = await runConfiguredChecks(outcome.config.automation.checksCmd, cwd);
      if (checks.ran && !checks.ok) {
        return err(
          'CHECKS_FAILED',
          `configured checks failed (exit ${checks.code})`,
          'fix the failing checks, or pass --skip-checks to bypass',
        );
      }
    }

    const endSha = await getCurrentSha(cwd);
    const closedAt = isoNow();
    const updated: string[] = [];
    const updatedPaths: string[] = [];

    await mutateSprintFrontmatter(join(cwd, sprint.file), {
      status: 'shipped',
      closed_at: closedAt,
      end_sha: endSha,
    });
    updated.push(sprint.file);
    updatedPaths.push(sprint.file);

    // set end_sha on review if missing
    if (sprint.review_id) {
      const review = outcome.graph.reviews.get(sprint.review_id);
      if (review?.file && !review.end_sha) {
        await mutateReviewFrontmatter(join(cwd, review.file), { end_sha: endSha });
        updated.push(review.file);
        updatedPaths.push(review.file);
      }
    }

    // remove from queue
    const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
    if (queue) {
      const hasSlot = queue.slots.some((s) => s.sprint_id === id);
      if (hasSlot) {
        await removeSprintFromQueue(join(cwd, queue.file), id);
        updated.push(`${queue.file}  (removed slot, re-numbered)`);
        updatedPaths.push(queue.file);
      }
    }

    const { findings } = await refreshRegistry(cwd);
    updated.push(outcome.config.paths.registry);
    updatedPaths.push(outcome.config.paths.registry);

    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

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
    const commitHintLines = opts.omitCommitHint
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
      '',
      'Updated:',
      ...updated.map((u) => `  ${u}`),
      ...unblockedLines,
      ...commitHintLines,
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

    const ALLOWED = new Set(['review', 'shipped', 'active']);
    if (!ALLOWED.has(sprint.status)) {
      return err(
        'INVALID_STATUS',
        `rk reopen requires status review, shipped, or active (got: ${sprint.status})`,
        sprint.status === 'cancelled'
          ? 'cancelled sprints cannot be reopened in v0 (use --from-cancelled when available)'
          : `${id} is ${sprint.status}`,
      );
    }

    if (opts.dryRun) return dryRunOk('reopen', { id, from: sprint.status, to: 'reopened' });

    const previousStatus = sprint.status;
    const reopenMutations: Record<string, unknown> = {
      status: 'reopened',
      end_sha: null,
      closed_at: null,
    };
    if (sprint.status === 'active') {
      reopenMutations.started_at = null;
    }
    await mutateSprintFrontmatter(join(cwd, sprint.file), reopenMutations);
    const { findings } = await refreshRegistry(cwd);
    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const out = [
      `Sprint ${id} reopened`,
      '',
      `  ${pc.bold('Previous status')}  ${previousStatus}`,
      sprint.review_id ? `  ${pc.bold('review_id')}         ${sprint.review_id} (preserved)` : '',
      sprint.base_sha
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
        await removeSprintFromQueue(join(cwd, queue.file), id);
        updated.push(`${queue.file}  (removed slot, re-numbered)`);
      }
    }

    const { findings } = await refreshRegistry(cwd);
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

    await mutateReviewFrontmatter(join(cwd, review.file), patch);

    // Auto-revert sprint commits when verdict is rejected and SHAs are available
    let revertedCommit: string | undefined;
    let revertConflict = false;
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

    const { findings } = await refreshRegistry(cwd);
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

function reviewStub(reviewId: string, sprintId: string): string {
  return `---
id: ${reviewId}
sprint_id: ${sprintId}
verdict: pending
reviewer: agent
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
  const re = new RegExp(`^${candidate}(?:-.+)?\\.md$`);
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
  const re = new RegExp(`^${reviewId}(?:-.+)?\\.md$`);
  const match = files.find((f) => re.test(f));
  return match ? join(reviewsDir, match) : null;
}
