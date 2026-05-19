import { join, resolve } from 'node:path';
import {
  type Config,
  loadConfig,
  loadProject,
  materialPaths,
  RepoKernelError,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../../exitCodes.js';
import { stagePathsAndCommit } from '../../lifecycle/git.js';
import { git } from '../../lifecycle/gitExec.js';
import { mutateReviewFrontmatter } from '../../lifecycle/mutate.js';
import { withLifecycleScope } from '../../lifecycle/transaction.js';
import { releaseWorktree, worktreeBranch, worktreePath } from '../../lifecycle/worktree.js';
import { runCloseCommand } from '../lifecycle.js';
import type { CommandResult } from '../validate.js';
import {
  findOnlyTaskInStatus,
  readTaskAlias,
  reconcileTaskAlias,
  writeTaskAliasUpdate,
} from './taskAlias.js';
import { normalizeTaskId } from './taskId.js';
import type { TaskAlias } from './types.js';

export interface CloseTaskOptions {
  readonly cwd: string;
  /** Optional explicit T-NNN. When omitted, RK auto-picks the unique task in review. */
  readonly taskId?: string;
  /** Pass-through to underlying runCloseCommand. */
  readonly dryRun?: boolean;
  /** Pass-through to underlying runCloseCommand. */
  readonly json?: boolean;
}

/**
 * Close a fastpath task. Hard rules:
 *   1. Sprint MUST be in `review` status (i.e. checks passed during the run).
 *   2. If a review file exists with verdict 'pending', auto-accept it. The
 *      fastpath convention is that arriving in `review` means checks passed,
 *      so explicit accepted-review ceremony is unnecessary noise.
 *   3. Delegate to runCloseCommand for the canonical close pipeline (queue
 *      removal, sprint→shipped, end_sha capture, registry refresh).
 *   4. Release the epic worktree once close succeeds.
 *   5. Update the alias to status='shipped' with closed_at.
 */
export async function runCloseTaskCommand(opts: CloseTaskOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  const cfg = await loadConfig({ cwd });
  if (!cfg.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml not found; run rk init first\n',
    };
  }
  const config = cfg.config;

  const aliasOrErr = await resolveAlias(cwd, config, opts.taskId, 'review');
  if (!aliasOrErr.ok) return aliasOrErr.error;
  let alias = aliasOrErr.alias;
  const reconciled = await reconcileTaskAlias(cwd, config, alias).catch(() => null);
  if (reconciled) alias = reconciled.alias;

  // Refuse to close while the alias still says 'active' — checks have not
  // passed in the worktree (or the run never reached the review pause).
  if (alias.status === 'shipped') {
    if (reconciled) {
      return {
        exitCode: EXIT_OK,
        stdout: `${pc.bold(`Closed ${alias.id}`)} — ${alias.title}\n\nTask alias reconciled from linked sprint ${alias.sprint_id}.\n`,
        stderr: '',
      };
    }
    return blocked(`${alias.id} is already shipped`);
  }
  if (alias.status === 'cancelled') {
    return blocked(`${alias.id} was discarded — cannot close`);
  }
  if (alias.status === 'active') {
    return blocked(
      `${alias.id} has no review-ready work — checks have not passed yet`,
      `retry the run: rk run ${alias.id}`,
    );
  }
  // alias.status === 'review' — proceed.

  // Step 1: dry-run delegates straight through without merging anything.
  if (opts.dryRun === true) {
    const dryResult = await runCloseCommand(alias.sprint_id, {
      cwd,
      dryRun: true,
      json: opts.json ?? false,
    });
    return {
      exitCode: dryResult.exitCode,
      stdout: reframe(dryResult.stdout, alias),
      stderr: dryResult.stderr,
    };
  }

  // Step 1.5: drift guard. The alias `review_sha` is the worktree-branch HEAD
  // captured by `rk run` at the moment checks last passed. If the branch has
  // moved since (manual commit in the worktree, agent re-run not surfaced
  // through the alias, etc.), the merge would carry unverified work into
  // main. Refuse and tell the user to re-run.
  if (alias.review_sha) {
    const currentSha = await readBranchHead(cwd, config, alias.epic_id);
    if (currentSha && currentSha !== alias.review_sha) {
      return blocked(
        `${alias.id} cannot close — worktree branch advanced since last passing checks (was ${alias.review_sha.slice(0, 12)}, now ${currentSha.slice(0, 12)})`,
        `re-run checks: rk run ${alias.id}`,
      );
    }
  }

  // Step 2: merge the worktree branch into main. The run pipeline pauses at
  // 'review' inside the worktree, so its sprint mutations + agent commits
  // need to be folded back into main before the canonical close runs (close
  // expects to see the sprint in review on the main checkout).
  try {
    await mergeWorktreeBranch(cwd, config, alias.epic_id);
  } catch (cause) {
    return runtimeErr(cause);
  }

  // Step 3: re-load main, find the (now-merged) review and auto-accept it.
  const outcome = await loadProject({ cwd });
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'project failed to load after merge; run rk validate\n',
    };
  }
  const sprint = outcome.graph.sprints.get(alias.sprint_id);
  if (!sprint) {
    return blocked(`sprint ${alias.sprint_id} not found after merge (alias ${alias.id} is stale)`);
  }
  if (sprint.status !== 'review') {
    return blocked(
      `${alias.id} cannot close — sprint ${alias.sprint_id} is in ${sprint.status} after merge`,
      'unexpected merge result; inspect the worktree branch manually',
    );
  }

  if (sprint.review_id) {
    const review = outcome.graph.reviews.get(sprint.review_id);
    if (review && review.verdict !== 'accepted') {
      try {
        await withLifecycleScope(
          {
            cwd,
            command: 'fastpath-close-review',
            args: { taskId: alias.id, reviewId: review.id },
          },
          async () => {
            await mutateReviewFrontmatter(join(cwd, review.file), { verdict: 'accepted' });
          },
        );
        // Commit the auto-accept so main is clean before runCloseCommand's
        // dirty-tree guard fires.
        await stagePathsAndCommit(
          cwd,
          [review.file],
          `chore(rk): auto-accept ${review.id} for ${alias.id}`,
        );
      } catch (cause) {
        return runtimeErr(cause);
      }
    }
  }

  // Step 4: delegate to the canonical close pipeline (sprint→shipped,
  // queue cleanup, end_sha capture, registry refresh). Suppress the
  // "Next: git add ... && git commit" hint because step 5 below commits
  // the close-side metadata itself; surfacing the hint after the commit
  // already ran is misleading guidance.
  const closeResult = await runCloseCommand(alias.sprint_id, {
    cwd,
    dryRun: false,
    json: opts.json ?? false,
    omitCommitHint: true,
  });

  if (closeResult.exitCode !== EXIT_OK) {
    return {
      ...closeResult,
      stdout: reframe(closeResult.stdout, alias),
    };
  }

  // Step 5: commit the close-side metadata mutations so the repo is clean.
  // runCloseCommand updates sprint→shipped, queue (slot removed), the review
  // file (end_sha capture), and the registry; users would otherwise have to
  // commit those by hand.
  try {
    const queue = outcome.parsed.queues.find((q) => q.lane === sprint.lane);
    const review = sprint.review_id ? outcome.graph.reviews.get(sprint.review_id) : undefined;
    const closePaths = [sprint.file, config.paths.registry];
    if (queue) closePaths.push(queue.file);
    if (review?.file) closePaths.push(review.file);
    await stagePathsAndCommit(cwd, closePaths, `chore(rk): close ${alias.id}`);
  } catch (cause) {
    return runtimeErr(cause);
  }

  // Step 6: release the epic worktree (best-effort).
  await releaseEpicWorktreeBestEffort(cwd, config, alias.epic_id);

  // Step 7: update the alias to its terminal shipped state and commit.
  const updated: TaskAlias = {
    ...alias,
    status: 'shipped',
    closed_at: new Date().toISOString(),
  };
  await withLifecycleScope(
    { cwd, command: 'fastpath-close-alias', args: { taskId: alias.id } },
    async () => {
      await writeTaskAliasUpdate(cwd, config, updated);
    },
  );
  try {
    const aliasFile = join(config.paths.generated, 'tasks', `${alias.id}.json`);
    await stagePathsAndCommit(cwd, [aliasFile], `chore(rk): mark ${alias.id} shipped`);
  } catch {
    // Non-fatal: alias file is on disk; user can commit later.
  }

  const stdout = `${pc.bold(`Closed ${alias.id}`)} — ${alias.title}\n\n${reframe(
    closeResult.stdout,
    alias,
  )}`;
  return {
    exitCode: EXIT_OK,
    stdout,
    stderr: closeResult.stderr,
  };
}

/**
 * Merge the epic worktree's branch back into the current branch on main.
 *
 * Uses `git merge --no-ff` so the merge commit always exists (matches
 * mergeWaveBranches semantics in lifecycle/merge.ts). On conflict the merge
 * is aborted; the caller surfaces the failure to the user.
 *
 * The assisted-mode pause leaves uncommitted RK metadata in the worktree
 * (sprint→review mutation, review file creation). We commit those into the
 * worktree branch before merging so the merge brings them along.
 */
async function readBranchHead(cwd: string, config: Config, epicId: string): Promise<string | null> {
  const branch = worktreeBranch(epicId as `E-${string}`, config);
  try {
    const { stdout } = await git(['-C', cwd, 'rev-parse', `refs/heads/${branch}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function mergeWorktreeBranch(cwd: string, config: Config, epicId: string): Promise<void> {
  const branch = worktreeBranch(epicId as `E-${string}`, config);
  const wtRoot = worktreePath(epicId as `E-${string}`, config, cwd);

  // Verify the branch exists; nothing to merge if it doesn't.
  try {
    await git(['-C', cwd, 'rev-parse', '--verify', `refs/heads/${branch}`]);
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `worktree branch ${branch} not found — was the run interrupted before producing changes?`,
      cause,
    );
  }

  // Commit any RK metadata still dirty in the worktree (the assisted pause
  // leaves them that way). We restrict the stage set to the paths RepoKernel
  // owns under the active config (see materialPaths.worktreeStaged) so we
  // never accidentally commit non-RK content the agent might have left
  // untracked, while still honouring custom config layouts.
  await commitWorktreeRkMetadata(wtRoot, config);

  try {
    await git([
      '-C',
      cwd,
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `merge ${branch} (rk fastpath close)`,
      branch,
    ]);
  } catch (cause) {
    // Roll back any in-progress merge to leave main in a clean state.
    await git(['-C', cwd, 'merge', '--abort']).catch(() => null);
    throw new RepoKernelError(
      'IO_ERROR',
      `merge of ${branch} into the current branch failed (likely conflicts) — resolve manually and retry`,
      cause,
    );
  }
}

/**
 * Stage and commit any RK-managed files that are dirty in `wtRoot` so that the
 * close-merge folds them back into main.
 *
 * Exported for direct unit tests — see `closeTaskCustomPaths.test.ts`. The
 * stage set is derived from `materialPaths(config).worktreeStaged` so custom
 * config layouts (`paths.sprints: docs/sprints`, etc.) are honoured.
 */
export async function commitWorktreeRkMetadata(wtRoot: string, config: Config): Promise<void> {
  // Status --porcelain restricted to RK-managed paths derived from config so
  // that custom layouts (e.g. paths.sprints = "docs/sprints") are honoured
  // instead of silently skipped — the previous implementation hardcoded
  // ".repokernel" and dropped sprint/review/queue mutations on non-default
  // layouts, leaving the merge to bring stale state into main.
  const stageRoots = materialPaths(config).worktreeStaged;
  let statusOutput: string;
  try {
    const { stdout } = await git(['-C', wtRoot, 'status', '--porcelain', '--', ...stageRoots]);
    statusOutput = stdout;
  } catch {
    return; // worktree gone? caller handles via the rev-parse check above.
  }
  const dirtyPaths = statusOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(2).trim()) // drop XY status prefix
    .filter((p) => p.length > 0);

  if (dirtyPaths.length === 0) return;

  try {
    await git(['-C', wtRoot, 'add', '--', ...dirtyPaths]);
    await git(['-C', wtRoot, 'commit', '--allow-empty', '-m', 'chore(rk): record review state']);
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      'could not commit worktree review state before merge',
      cause,
    );
  }
}

interface ResolveOk {
  readonly ok: true;
  readonly alias: TaskAlias;
}
interface ResolveErr {
  readonly ok: false;
  readonly error: CommandResult;
}

export async function resolveAlias(
  cwd: string,
  config: Config,
  taskIdInput: string | undefined,
  preferredStatus: TaskAlias['status'],
): Promise<ResolveOk | ResolveErr> {
  if (taskIdInput) {
    const normalized = normalizeTaskId(taskIdInput);
    if (!normalized) {
      return { ok: false, error: blocked(`invalid task id "${taskIdInput}" (expected T-NNN)`) };
    }
    const alias = await readTaskAlias(cwd, config, normalized);
    if (!alias) {
      return { ok: false, error: blocked(`task ${normalized} not found`) };
    }
    return { ok: true, alias };
  }

  const sole = await findOnlyTaskInStatus(cwd, config, preferredStatus);
  if (sole) return { ok: true, alias: sole };

  return {
    ok: false,
    error: blocked(
      `no task id provided and no unique task in ${preferredStatus} status to default to`,
      `pass an explicit T-NNN, e.g. rk close T-001`,
    ),
  };
}

async function releaseEpicWorktreeBestEffort(
  cwd: string,
  config: Config,
  epicId: string,
): Promise<void> {
  try {
    await releaseWorktree(epicId as `E-${string}`, config, cwd);
  } catch {
    // Releasing is non-critical for fastpath UX. The worktree may be
    // released later via `rk lane release` if it lingers.
  }
}

function reframe(text: string, alias: TaskAlias): string {
  if (text.length === 0) return text;
  // Same word-bounded substitution as the render module so file paths survive.
  const re = new RegExp(`(?<![/\\w])${escapeRegex(alias.sprint_id)}(?![\\w/])`, 'g');
  return text.replace(re, alias.id);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blocked(message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${lines.join('\n')}\n` };
}

function runtimeErr(cause: unknown): CommandResult {
  if (cause instanceof RepoKernelError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${cause.message}\n` };
  }
  const msg = cause instanceof Error ? cause.message : String(cause);
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${msg}\n` };
}
