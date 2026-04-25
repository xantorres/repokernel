import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { laneStateRoot } from './controlPaths.js';

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
): Promise<void> {
  const dir = laneStateRoot(opRoot);
  await mkdir(dir, { recursive: true });
  const ownership: LaneOwnership = {
    lane,
    run_id: runId,
    epic_id: epicId,
    worktree,
    branch,
    claimed_at: new Date().toISOString(),
  };
  await writeFile(laneFile(opRoot, lane), JSON.stringify(ownership, null, 2), 'utf8');
}

export async function releaseLane(lane: string, opRoot: string): Promise<void> {
  try {
    await unlink(laneFile(opRoot, lane));
  } catch {
    // already gone
  }
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
