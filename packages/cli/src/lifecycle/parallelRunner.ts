import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Epic, Run, RunId, Sprint, SprintId } from '@repokernel/core';
import { loadProject } from '@repokernel/core';
import type { AgentRunner, SprintRunResult } from '../agents/types.js';
import { getCurrentSha } from './git.js';
import {
  mutateReviewFrontmatter,
  mutateSprintFrontmatter,
  removeSprintFromQueue,
} from './mutate.js';
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

  // 4. Write summary
  const summaryContent = buildSummary(sprint, result);
  await writeSummary(run, sprint, summaryContent, opRoot);

  return {
    sprint,
    result,
    worktree: sprintWorktree,
    branch: sprintBranch,
    reviewId: allocatedReviewId,
  };
}

/**
 * Parallel-safe sprint start: only mutates the sprint's own frontmatter file.
 * Does NOT touch queue files, registry, or other sprint files.
 * Sets status=active, started_at, and base_sha from the sprint worktree HEAD.
 */
export async function startSprintMetadataOnly(sprint: Sprint, worktree: string): Promise<void> {
  const sprintFile = join(worktree, sprint.file);
  const baseSha = await getHeadSha(worktree);
  await mutateSprintFrontmatter(sprintFile, {
    status: 'active',
    started_at: new Date().toISOString(),
    base_sha: baseSha,
  });
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
  await mutateSprintFrontmatter(join(epicWorktree, sprint.file), {
    status: 'shipped',
    closed_at: closedAt,
    end_sha: endSha,
  });

  // 2. Set end_sha on review if missing
  const review = outcome.graph.reviews.get(reviewId);
  if (review?.file && !review.end_sha) {
    await mutateReviewFrontmatter(join(epicWorktree, review.file), { end_sha: endSha });
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
