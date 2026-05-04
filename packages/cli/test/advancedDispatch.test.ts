import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimSprint,
  detectStalledWorkers,
  effectiveConcurrencyCap,
  releaseSprint,
} from '../src/lifecycle/runState.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-disp-'));
  tracked.push(dir);
  return dir;
}

async function writeSprint(dir: string, id: string): Promise<{ file: string; opRoot: string }> {
  const sprintsDir = join(dir, 'sprints');
  await mkdir(sprintsDir, { recursive: true });
  const file = join(sprintsDir, `${id}.md`);
  await writeFile(
    file,
    matter.stringify('## Body\n', {
      id,
      title: 'sprint',
      epic_id: 'E-001',
      status: 'planned',
      lane: 'core',
    }),
    'utf8',
  );
  const opRoot = join(dir, '.git', 'repokernel');
  await mkdir(opRoot, { recursive: true });
  return { file, opRoot };
}

describe('effectiveConcurrencyCap', () => {
  it('returns the global cap when no per-state override exists', () => {
    expect(effectiveConcurrencyCap({ globalCap: 4, byState: {}, state: 'active' })).toBe(4);
  });

  it('clamps to the per-state value when smaller than the global cap', () => {
    expect(effectiveConcurrencyCap({ globalCap: 4, byState: { review: 1 }, state: 'review' })).toBe(
      1,
    );
  });

  it('never raises above the global cap', () => {
    expect(
      effectiveConcurrencyCap({ globalCap: 4, byState: { review: 99 }, state: 'review' }),
    ).toBe(4);
  });
});

describe('detectStalledWorkers', () => {
  it('returns an empty list when threshold is zero', () => {
    expect(detectStalledWorkers([{ sprintId: 'S-1', lastActivityAt: 0 }], Date.now(), 0)).toEqual(
      [],
    );
  });

  it('flags workers whose last activity is older than the threshold', () => {
    const now = 10_000;
    const stalled = detectStalledWorkers(
      [
        { sprintId: 'S-1', lastActivityAt: 9_500 },
        { sprintId: 'S-2', lastActivityAt: 4_000 },
      ],
      now,
      1_000,
    );
    expect(stalled.map((w) => w.sprintId)).toEqual(['S-2']);
  });
});

describe('claimSprint / releaseSprint', () => {
  it('writes the run id when no claim exists', async () => {
    const dir = await tmp();
    const { file, opRoot } = await writeSprint(dir, 'S-1');
    const result = await claimSprint({ file, opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    expect(result.ok).toBe(true);
    const parsed = matter(await readFile(file, 'utf8'));
    expect((parsed.data as { claimed_by_run_id: string }).claimed_by_run_id).toBe('RUN-001');
  });

  it('rejects a second claim from a different run id', async () => {
    const dir = await tmp();
    const { file, opRoot } = await writeSprint(dir, 'S-1');
    await claimSprint({ file, opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    const second = await claimSprint({ file, opRoot, runId: 'RUN-002', sprintId: 'S-1' });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === 'already_claimed') {
      expect(second.heldBy).toBe('RUN-001');
    } else {
      throw new Error('expected already_claimed result');
    }
  });

  it('is idempotent for the same run id', async () => {
    const dir = await tmp();
    const { file, opRoot } = await writeSprint(dir, 'S-1');
    await claimSprint({ file, opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    const again = await claimSprint({ file, opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    expect(again.ok).toBe(true);
  });

  it('releaseSprint clears the claim', async () => {
    const dir = await tmp();
    const { file, opRoot } = await writeSprint(dir, 'S-1');
    await claimSprint({ file, opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    await releaseSprint({ file, opRoot, sprintId: 'S-1' });
    const parsed = matter(await readFile(file, 'utf8'));
    expect((parsed.data as Record<string, unknown>).claimed_by_run_id).toBeUndefined();
  });
});
