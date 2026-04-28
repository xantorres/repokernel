import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SprintId } from '@repokernel/core';

const execFileAsync = promisify(execFile);

export interface SprintBranchEntry {
  readonly sprintId: SprintId;
  readonly branch: string;
  readonly worktree: string;
}

export interface MergeResult {
  readonly success: boolean;
  /** Sprint IDs successfully merged into the epic branch. */
  readonly merged: readonly SprintId[];
  /** Set when a conflict stopped the wave. Remaining branches are preserved. */
  readonly firstConflict?: {
    readonly sprintId: SprintId;
    readonly conflictingFiles: readonly string[];
  };
}

/**
 * Merge sprint branches into the epic worktree branch, in deterministic sprint-ID order.
 *
 * Behavior:
 * - Captures the epic branch tip before any merge.
 * - Uses `git merge --no-ff` per sprint branch.
 * - On first conflict: aborts the in-progress merge AND resets the epic
 *   worktree to the pre-wave tip, so the wave is fully atomic. The returned
 *   `merged` list is empty in this case — by the time the caller reads it,
 *   nothing from this wave is actually in the epic branch.
 * - Unmerged sprint branches are preserved intact for human inspection.
 */
export async function mergeWaveBranches(
  epicWorktree: string,
  sprints: readonly SprintBranchEntry[],
): Promise<MergeResult> {
  // Deterministic order: sort by sprint ID
  const ordered = [...sprints].sort((a, b) => a.sprintId.localeCompare(b.sprintId));

  const preWaveTip = await readHead(epicWorktree);

  const merged: SprintId[] = [];

  for (const entry of ordered) {
    const conflictingFiles = await attemptMerge(epicWorktree, entry.branch);

    if (conflictingFiles !== null) {
      await abortMerge(epicWorktree);
      if (preWaveTip !== null) {
        await resetHard(epicWorktree, preWaveTip);
      }
      return {
        success: false,
        merged: [],
        firstConflict: { sprintId: entry.sprintId, conflictingFiles },
      };
    }

    merged.push(entry.sprintId);
  }

  return { success: true, merged };
}

async function readHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function resetHard(cwd: string, sha: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', cwd, 'reset', '--hard', sha]);
  } catch {
    // If reset fails the working tree may be in an unusual state. Leave it
    // for human inspection rather than masking the original conflict error.
  }
}

/**
 * Attempt a single `--no-ff` merge.
 * Returns null on success, or the list of conflicting files on conflict.
 */
async function attemptMerge(
  epicWorktree: string,
  branch: string,
): Promise<readonly string[] | null> {
  try {
    await execFileAsync('git', [
      '-C',
      epicWorktree,
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `merge ${branch} into epic branch`,
      branch,
    ]);
    return null; // success
  } catch (cause) {
    // Only report as a merge conflict when Git left unmerged paths behind.
    // Other failures (missing branch, dirty index, hook failure, etc.) should
    // bubble as operational errors instead of masquerading as conflicts.
    const files = await listConflictingFiles(epicWorktree);
    if (files.length === 0) throw cause;
    return files;
  }
}

async function abortMerge(epicWorktree: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', epicWorktree, 'merge', '--abort']);
  } catch {
    // If abort fails (e.g., no merge in progress), ignore
  }
}

async function listConflictingFiles(cwd: string): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      cwd,
      'diff',
      '--name-only',
      '--diff-filter=U',
    ]);
    return stdout
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}
