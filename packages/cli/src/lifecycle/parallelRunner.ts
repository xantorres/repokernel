import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Epic, Run, RunId, Sprint, SprintId } from '@repokernel/core';
import { loadProject, meetsThreshold, runValidators } from '@repokernel/core';
import type { AgentRunner, SprintRunResult } from '../agents/types.js';
import { changedFilesSince, getCurrentSha, isWorkingTreeClean } from './git.js';
import {
  mutateReviewFrontmatter,
  mutateSprintFrontmatter,
  removeSprintFromQueue,
} from './mutate.js';
import { validateChangedFilesForSprint } from './pathPolicy.js';
import { generateSprintPacket, writeSprintPacket, writeSummary } from './sprintPacket.js';

const execFileAsync = promisify(execFile);

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

/**
 * Run all sprints in a wave concurrently using Promise.allSettled.
 * Each worker runs in its own sprint worktree, isolated from others.
 * Failed workers are collected; the caller decides whether to halt.
 */
export async function runWaveParallel(
  workers: readonly ParallelWorkerInput[],
): Promise<ParallelRunnerResult> {
  const results = await Promise.allSettled(workers.map((w) => runOneWorker(w)));

  const completed: ParallelWorkerSuccess[] = [];
  const failed: ParallelWorkerFailure[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const w = workers[i]!;
    if (r.status === 'fulfilled') {
      completed.push(r.value);
    } else {
      failed.push({ sprint: w.sprint, error: r.reason });
    }
  }

  return { completed, failed };
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

  const allChanged = await changedFilesSince(w.sprintWorktree, sprint.base_sha);
  // Sprint's own .md is committed by the orchestrator at start — exclude from agent output checks
  const changedFiles = allChanged.filter((f) => f !== sprint.file);
  if (changedFiles.length === 0) {
    return {
      ...result,
      status: 'failed',
      summary: `no committed changes since base_sha ${sprint.base_sha.slice(0, 7)}`,
      changed_files: [],
    };
  }

  const pathFailure = validateChangedFilesForSprint(sprint, changedFiles);
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
  await mutateReviewFrontmatter(reviewFilePath, {
    base_sha: sprint.base_sha,
    changed_files: changedFiles,
    paths_checked: pathsChecked,
    updated_at: new Date().toISOString(),
  });

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
  await mutateSprintFrontmatter(sprintFile, {
    status: 'active',
    started_at: new Date().toISOString(),
    base_sha: baseSha,
  });
  await execFileAsync('git', ['-C', worktree, 'add', sprintFile]);
  await execFileAsync('git', ['-C', worktree, 'commit', '-m', `rk: start ${sprint.id}`]);
}

async function getHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
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
): Promise<void> {
  const outcome = await loadProject({ cwd: epicWorktree });
  if (!outcome.ok) {
    throw new Error(`could not load project from epic worktree at ${epicWorktree}`);
  }

  const sprint = outcome.graph.sprints.get(sprintId);
  if (!sprint) {
    throw new Error(`sprint ${sprintId} not found in epic worktree`);
  }

  const endSha = await getCurrentSha(epicWorktree);
  const closedAt = new Date().toISOString();

  // 1. Mark sprint shipped in epic worktree
  const sprintPatch: Record<string, unknown> = {
    status: 'shipped',
    closed_at: closedAt,
    end_sha: endSha,
  };
  if (reviewId) sprintPatch.review_id = reviewId;
  await mutateSprintFrontmatter(join(epicWorktree, sprint.file), sprintPatch);

  // 2. Set end_sha on review if missing
  const review = outcome.graph.reviews.get(reviewId);
  if (review?.file && !review.end_sha) {
    const reviewPatch: Record<string, unknown> = { end_sha: endSha };
    if (!review.base_sha && sprint.base_sha) reviewPatch.base_sha = sprint.base_sha;
    await mutateReviewFrontmatter(join(epicWorktree, review.file), reviewPatch);
  }

  // 3. Remove sprint from queue
  const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
  if (queue) {
    const hasSlot = queue.slots.some((s) => s.sprint_id === sprintId);
    if (hasSlot) {
      await removeSprintFromQueue(join(epicWorktree, queue.file), sprintId);
    }
  }
}
