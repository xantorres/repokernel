import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RepoKernelError } from '@repokernel/core';
import { laneStateRoot } from './controlPaths.js';
import { ambientJournalDelete, ambientJournalWrite } from './journal.js';
import { withLock } from './locks.js';

export interface LaneOwnership {
  readonly lane: string;
  readonly run_id: string;
  readonly epic_id: string;
  readonly worktree: string;
  readonly branch: string;
  readonly claimed_at: string;
}

function laneFile(opRoot: string, lane: string): string {
  return join(laneStateRoot(opRoot), `${lane}.json`);
}

export async function claimLane(
  lane: string,
  runId: string,
  epicId: string,
  worktree: string,
  branch: string,
  opRoot: string,
  opts: { readonly replace?: boolean } = {},
): Promise<void> {
  const dir = laneStateRoot(opRoot);
  await mkdir(dir, { recursive: true });
  await withLock(`lane-${lane}`, opRoot, async () => {
    const existing = await getLaneState(lane, opRoot);
    if (existing && !opts.replace) {
      throw new RepoKernelError(
        'IO_ERROR',
        `lane ${lane} already claimed by run ${existing.run_id} (epic ${existing.epic_id})`,
      );
    }
    const ownership: LaneOwnership = {
      lane,
      run_id: runId,
      epic_id: epicId,
      worktree,
      branch,
      claimed_at: new Date().toISOString(),
    };
    await ambientJournalWrite(laneFile(opRoot, lane), JSON.stringify(ownership, null, 2));
  });
}

export async function releaseLane(
  lane: string,
  opRoot: string,
  ownerRunId?: string,
): Promise<void> {
  // Take the same per-lane lock claimLane uses, then re-read the
  // ownership file under the lock. Without the lock, a check-then-unlink
  // can race with a concurrent claim by another run: ownership read says
  // lane is unowned (or owned by ourselves), then claimLane on the new
  // owner publishes the ownership, then unlink stomps the new owner's
  // claim. With the lock, claim and release serialize and the run-id
  // check is authoritative at the moment of unlink.
  await withLock(`lane-${lane}`, opRoot, async () => {
    if (ownerRunId !== undefined) {
      const state = await getLaneState(lane, opRoot);
      if (state && state.run_id !== ownerRunId) {
        // Lane owned by a different run — skip release to avoid stomping it.
        process.stderr.write(
          `warning: skipping lane release for ${lane}: owned by ${state.run_id}, not ${ownerRunId}\n`,
        );
        return;
      }
    }
    await ambientJournalDelete(laneFile(opRoot, lane));
  });
}

export async function getLaneState(lane: string, opRoot: string): Promise<LaneOwnership | null> {
  try {
    const raw = await readFile(laneFile(opRoot, lane), 'utf8');
    return JSON.parse(raw) as LaneOwnership;
  } catch {
    return null;
  }
}

export async function isLaneClaimed(lane: string, opRoot: string): Promise<boolean> {
  const state = await getLaneState(lane, opRoot);
  return state !== null;
}
