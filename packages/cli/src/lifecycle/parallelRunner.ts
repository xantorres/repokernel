import { join, relative } from 'node:path';
import type { Epic, Run, RunId, Sprint, SprintId } from '@repokernel/core';
import {
  effectiveReviewRequired,
  gateRequired,
  loadProject,
  meetsThreshold,
  runValidators,
} from '@repokernel/core';
import type { AgentRunner, SprintRunResult } from '../agents/types.js';
import { effectiveConcurrencyCap } from './dispatch.js';
import { evaluateReviewerGate } from './gateEnforce.js';
import { changedFilesForSprint, getCurrentSha, isWorkingTreeClean } from './git.js';
import { git } from './gitExec.js';
import { mutateReviewFrontmatter, mutateSprintFrontmatter, removeSlotFromQueue } from './mutate.js';
import { effectivePathPolicyForSprint, validateChangedFilesForSprint } from './pathPolicy.js';
import { claimSprint, releaseSprint } from './sprintClaim.js';
import { generateSprintPacket, writeSprintPacket, writeSummary } from './sprintPacket.js';
import { withLifecycleScope } from './transaction.js';

export interface ParallelWorkerInput {
  readonly sprint: Sprint;
  readonly epic: Epic;
  readonly run: Run;
  readonly epicWorktree: string;
  readonly sprintWorktree: string;
  readonly sprintBranch: string;
  readonly allocatedReviewId: string;
  readonly opRoot: string;
  readonly runner: AgentRunner;
  readonly controlCwd: string;
  readonly registryPath: string;
  readonly prevSummaries: readonly string[];
}

export interface ParallelWorkerSuccess {
  readonly sprint: Sprint;
  readonly result: SprintRunResult;
  readonly worktree: string;
  readonly branch: string;
  readonly reviewId: string;
}

export interface ParallelWorkerFailure {
  readonly sprint: Sprint;
  readonly error: unknown;
}

export interface ParallelRunnerResult {
  readonly completed: readonly ParallelWorkerSuccess[];
  readonly failed: readonly ParallelWorkerFailure[];
}

class ParallelWorkerResultError extends Error {
  constructor(
    readonly sprint: Sprint,
    readonly result: SprintRunResult,
  ) {
    super(`agent returned ${result.status} for ${sprint.id}: ${result.summary}`);
  }
}

export interface RunWaveOptions {
  /**
   * Project-wide concurrency cap. Defaults to the wave size, which
   * preserves the legacy behaviour where `runWaveParallel` ran every
   * worker concurrently. The dispatcher passes the configured
   * `parallel.maxConcurrentSprints` here.
   */
  readonly globalCap?: number;
  /**
   * Per-sprint-state caps; effective cap is min(global, per-state).
   * Defaults to `{}` (no per-state limits).
   */
  readonly capByState?: Readonly<Record<string, number | undefined>>;
}

/**
 * Run all sprints in a wave with bounded concurrency.
 *
 * Behaviour:
 *  - Each sprint is claimed via `claimSprint` before its agent is
 *    spawned. Two runs racing the same sprint will see exactly one
 *    `ok: true`; the loser receives `already_claimed` and is recorded
 *    as a failure (so the caller can decide whether to halt or rerun).
 *  - The wave honours `effectiveConcurrencyCap(globalCap, capByState,
 *    sprint.status)` — sprints whose effective cap is lower run in
 *    smaller batches. The combined cap for the whole wave is the
 *    minimum effective cap across the workers (the safest single
 *    parallel-window choice without reordering).
 *  - A worker's claim is released in the finally block, regardless of
 *    success/failure, so a thrown agent does not leave a stuck claim.
 */
export async function runWaveParallel(
  workers: readonly ParallelWorkerInput[],
  options: RunWaveOptions = {},
): Promise<ParallelRunnerResult> {
  const completed: ParallelWorkerSuccess[] = [];
  const failed: ParallelWorkerFailure[] = [];
  if (workers.length === 0) return { completed, failed };

  const globalCap = options.globalCap ?? workers.length;
  const capByState = options.capByState ?? {};

  // The wave-level concurrency window is the smallest effective cap
  // across the workers. Heterogeneous waves (some `active`, some
  // `review`) therefore inherit the most restrictive single state cap.
  // This is conservative — over-eager parallelism is the bug class
  // operators most often hit; under-utilisation is recoverable.
  const waveLimit = workers.reduce((acc, w) => {
    const cap = effectiveConcurrencyCap({
      globalCap,
      byState: capByState,
      state: w.sprint.status,
    });
    return Math.min(acc, cap);
  }, globalCap);

  const semaphore = Math.max(1, waveLimit);
  const queue = workers.slice();
  let active = 0;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const launchNext = async (): Promise<void> => {
    while (active < semaphore && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      active += 1;
      runWithClaim(next)
        .then((entry) => {
          if (entry.kind === 'ok') completed.push(entry.success);
          else failed.push(entry.failure);
        })
        .catch((error) => {
          // `runWithClaim` already wraps its body in try/catch and should
          // never reject. This catch is a defensive net so an unforeseen
          // throw still records a structured failure instead of leaking
          // as an unhandled rejection that aborts the wave.
          failed.push({ sprint: next.sprint, error });
        })
        .finally(() => {
          active -= 1;
          if (queue.length === 0 && active === 0) {
            resolveDone?.();
          } else {
            void launchNext();
          }
        });
    }
    if (queue.length === 0 && active === 0) resolveDone?.();
  };

  void launchNext();
  await done;
  return { completed, failed };
}

type WorkerOutcome =
  | { readonly kind: 'ok'; readonly success: ParallelWorkerSuccess }
  | { readonly kind: 'fail'; readonly failure: ParallelWorkerFailure };

async function runWithClaim(w: ParallelWorkerInput): Promise<WorkerOutcome> {
  // Outer try/catch so that filesystem errors from `claimSprint` itself
  // (lock-file I/O, EPERM, ENOSPC) and from `releaseSprint` in the finally
  // block are translated into structured worker failures instead of
  // unhandled rejections that could abort the whole wave. The caller
  // attaches `.then().finally()` to this promise — if we leak a rejection
  // here, Node surfaces it as `unhandledRejection` and the wave loop's
  // resolveDone never fires.
  try {
    const claim = await claimSprint({
      opRoot: w.opRoot,
      runId: w.run.id,
      sprintId: w.sprint.id,
    });
    if (!claim.ok) {
      return {
        kind: 'fail',
        failure: {
          sprint: w.sprint,
          error: new Error(`sprint ${w.sprint.id} already claimed by ${claim.heldBy}`),
        },
      };
    }
    let outcome: WorkerOutcome;
    try {
      const success = await runOneWorker(w);
      outcome = { kind: 'ok', success };
    } catch (error) {
      outcome = { kind: 'fail', failure: { sprint: w.sprint, error } };
    }
    // Release in a separate try so a release-time I/O failure does NOT
    // overwrite a successful worker outcome — we just record both as a
    // single failure entry below.
    try {
      await releaseSprint({ opRoot: w.opRoot, sprintId: w.sprint.id, runId: w.run.id });
    } catch (releaseError) {
      if (outcome.kind === 'ok') {
        return {
          kind: 'fail',
          failure: { sprint: w.sprint, error: releaseError },
        };
      }
      // Worker already failed; the original error is the more useful
      // signal. Drop the release error rather than masking the worker's
      // diagnosis.
    }
    return outcome;
  } catch (error) {
    // Defensive net for `claimSprint` itself throwing (filesystem error
    // before the lock could be acquired). The dispatcher records this as
    // a normal worker failure so the wave can continue.
    return { kind: 'fail', failure: { sprint: w.sprint, error } };
  }
}

async function runOneWorker(w: ParallelWorkerInput): Promise<ParallelWorkerSuccess> {
  const { sprint, epic, run, sprintWorktree, sprintBranch, allocatedReviewId, opRoot } = w;

  // 1. Start sprint metadata in sprint worktree (parallel-safe — only touches sprint file)
  await startSprintMetadataOnly(sprint, sprintWorktree);

  // 2. Generate and write sprint packet
  const packetContent = generateSprintPacket(run, sprint, epic, [...w.prevSummaries]);
  const packetPath = await writeSprintPacket(run, sprint, packetContent, opRoot);

  // 3. Invoke agent
  let result: SprintRunResult;
  try {
    result = await w.runner.runSprint({
      run_id: run.id as RunId,
      epic_id: run.epic_id,
      sprint_id: sprint.id,
      worktree: sprintWorktree,
      control_cwd: w.controlCwd,
      op_root: opRoot,
      sprint_packet_path: packetPath,
      registry_path: w.registryPath,
      mode: run.mode,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    result = { status: 'failed', summary: errMsg, changed_files: [], needs_human: false };
  }

  if (result.status === 'completed') {
    result = await validateCompletedWorker(w, result);
  }

  // 4. Write summary
  const summaryContent = buildSummary(sprint, result);
  await writeSummary(run, sprint, summaryContent, opRoot);

  if (result.status !== 'completed') {
    throw new ParallelWorkerResultError(sprint, result);
  }

  return {
    sprint,
    result,
    worktree: sprintWorktree,
    branch: sprintBranch,
    reviewId: allocatedReviewId,
  };
}

async function validateCompletedWorker(
  w: ParallelWorkerInput,
  result: SprintRunResult,
): Promise<SprintRunResult> {
  const clean = await isWorkingTreeClean(w.sprintWorktree);
  if (!clean) {
    return {
      ...result,
      status: 'failed',
      summary: 'working tree has uncommitted changes after agent run',
    };
  }

  const outcome = await loadProject({ cwd: w.sprintWorktree });
  if (!outcome.ok) {
    return { ...result, status: 'failed', summary: 'project failed to load after agent run' };
  }

  const sprint = outcome.graph.sprints.get(w.sprint.id);
  if (!sprint?.base_sha) {
    return { ...result, status: 'failed', summary: `${w.sprint.id} has no base_sha after start` };
  }

  const allChanged = await changedFilesForSprint(w.sprintWorktree, sprint.base_sha);
  // Sprint's own .md is committed by the orchestrator at start — exclude from agent output checks
  const changedFiles = allChanged.files.filter((f) => f !== sprint.file);
  if (changedFiles.length === 0) {
    return {
      ...result,
      status: 'failed',
      summary: `no committed changes since base_sha ${sprint.base_sha.slice(0, 7)}`,
      changed_files: [],
    };
  }

  const pathFailure = validateChangedFilesForSprint(
    sprint,
    changedFiles,
    [],
    effectivePathPolicyForSprint({ config: outcome.config, sprint }),
  );
  if (pathFailure) {
    return {
      ...result,
      status: 'failed',
      summary: pathFailure.message,
      changed_files: changedFiles,
    };
  }

  const findings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
  });
  const blocking = findings.filter((f) =>
    meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
  );
  if (blocking.length > 0) {
    return {
      ...result,
      status: 'failed',
      summary: `validation failed after agent: ${blocking[0]?.message ?? 'unknown'}`,
      changed_files: changedFiles,
    };
  }

  const reviewFilePath = join(
    w.epicWorktree,
    outcome.config.paths.reviews,
    `${w.allocatedReviewId}.md`,
  );
  const pathsChecked: Record<string, boolean> = { denied_paths_clean: true };
  if (sprint.allowed_paths.length > 0) pathsChecked.allowed_paths_matched = true;
  await withLifecycleScope(
    { cwd: w.epicWorktree, command: 'parallel-review-metadata', args: { sprintId: sprint.id } },
    async () => {
      await mutateReviewFrontmatter(reviewFilePath, {
        base_sha: sprint.base_sha,
        changed_files: changedFiles,
        paths_checked: pathsChecked,
        updated_at: new Date().toISOString(),
      });
    },
  );

  return { ...result, changed_files: changedFiles };
}

/**
 * Parallel-safe sprint start: mutates the sprint's own frontmatter file and commits it.
 * Does NOT touch queue files, registry, or other sprint files.
 * Sets status=active, started_at, and base_sha from the sprint worktree HEAD.
 * Commits the sprint metadata so the agent always starts from a clean working tree.
 */
export async function startSprintMetadataOnly(sprint: Sprint, worktree: string): Promise<void> {
  const sprintFile = join(worktree, sprint.file);
  const baseSha = await getHeadSha(worktree);
  await withLifecycleScope(
    { cwd: worktree, command: 'parallel-start-sprint', args: { sprintId: sprint.id } },
    async () => {
      await mutateSprintFrontmatter(sprintFile, {
        status: 'active',
        started_at: new Date().toISOString(),
        base_sha: baseSha,
      });
    },
  );
  await git(['-C', worktree, 'add', sprintFile]);
  await git(['-C', worktree, 'commit', '-m', `rk: start ${sprint.id}`]);
}

async function getHeadSha(cwd: string): Promise<string> {
  const { stdout } = await git(['-C', cwd, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

function buildSummary(sprint: Sprint, result: SprintRunResult): string {
  const lines = [
    `# ${sprint.id} — ${sprint.title}`,
    `\nStatus: ${result.status}`,
    `\n${result.summary}`,
  ];
  if (result.changed_files.length > 0) {
    lines.push(`\n\nChanged files:\n${result.changed_files.map((f) => `- ${f}`).join('\n')}`);
  }
  return lines.join('');
}

/**
 * Close a sprint in the epic worktree after its branch has been merged.
 *
 * Mutates (in epic worktree only):
 * - Sprint file: status=shipped, closed_at, end_sha
 * - Review file: end_sha (if not already set)
 * - Queue file: removes the sprint slot
 *
 * Registry refresh is NOT called here — caller refreshes once per wave after all closes.
 *
 * @param sprintId - Sprint to close
 * @param reviewId - Pre-allocated review ID for this sprint
 * @param epicWorktree - Absolute path to the epic worktree
 */
export async function closeAfterMerge(
  sprintId: SprintId,
  reviewId: string,
  epicWorktree: string,
): Promise<string[]> {
  const outcome = await loadProject({ cwd: epicWorktree });
  if (!outcome.ok) {
    throw new Error(`could not load project from epic worktree at ${epicWorktree}`);
  }

  const sprint = outcome.graph.sprints.get(sprintId);
  if (!sprint) {
    throw new Error(`sprint ${sprintId} not found in epic worktree`);
  }

  // Reviewer-gate enforcement — the parallel close path must honor the same gate
  // as runCloseCommand, not bypass it. The merged review carries the signed
  // snapshot; verify presence, signature, attempt, verdict, and freshness
  // before shipping. Fail closed: a gate-required sprint without a valid
  // snapshot is not shipped by the wave (re-run the gate, then close manually).
  const gateReview = reviewId ? outcome.graph.reviews.get(reviewId) : undefined;
  // Built-in review lane: mirror runCloseCommand — a review-required sprint must
  // carry an accepted review.verdict before it ships. The parallel path does not
  // run the review pipeline, so this (with the run-start preflight) fails closed
  // rather than shipping with a pending verdict.
  if (effectiveReviewRequired(sprint, outcome.config)) {
    if (!gateReview) {
      throw new Error(
        `${sprintId} requires review but no review is linked; close via sequential rk run`,
      );
    }
    if (gateReview.verdict !== 'accepted') {
      throw new Error(
        `${sprintId} review ${gateReview.id} verdict is ${gateReview.verdict}, not accepted`,
      );
    }
  }
  if (gateReview) {
    const gateEval = await evaluateReviewerGate({
      checkPath: epicWorktree,
      config: outcome.config,
      sprint,
      review: gateReview,
      configFile: relative(epicWorktree, outcome.configPath),
    });
    if (!gateEval.ok) {
      throw new Error(
        `reviewer gate blocked close of ${sprintId} (${gateEval.block.code}): ${gateEval.block.message}`,
      );
    }
  } else if (gateRequired(sprint, outcome.config)) {
    throw new Error(
      `reviewer gate required for ${sprintId} but no review is linked; run rk review-gate ${sprintId}`,
    );
  }

  const endSha = await getCurrentSha(epicWorktree);
  const closedAt = new Date().toISOString();
  const touched: string[] = [];

  await withLifecycleScope(
    { cwd: epicWorktree, command: 'parallel-close-after-merge', args: { sprintId } },
    async (tx) => {
      // 1. Mark sprint shipped in epic worktree
      const sprintPatch: Record<string, unknown> = {
        status: 'shipped',
        closed_at: closedAt,
        end_sha: endSha,
      };
      if (reviewId) sprintPatch.review_id = reviewId;
      await mutateSprintFrontmatter(join(epicWorktree, sprint.file), sprintPatch);
      touched.push(sprint.file);

      // 2. Set end_sha on review if missing
      const review = outcome.graph.reviews.get(reviewId);
      if (review?.file && !review.end_sha) {
        const reviewPatch: Record<string, unknown> = { end_sha: endSha };
        if (!review.base_sha && sprint.base_sha) reviewPatch.base_sha = sprint.base_sha;
        await mutateReviewFrontmatter(join(epicWorktree, review.file), reviewPatch);
        touched.push(review.file);
      }

      // 3. Remove sprint from queue
      const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
      if (queue) {
        const hasSlot = queue.slots.some((s) => s.sprint_id === sprintId);
        if (hasSlot) {
          const removed = await removeSlotFromQueue(
            join(epicWorktree, queue.file),
            sprintId,
            tx.opRoot,
            sprint.lane,
          );
          if (removed.kind === 'removed') {
            touched.push(queue.file);
          }
        }
      }
    },
  );

  return touched;
}
