import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoKernelError, type Run } from '@repokernel/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { claimLane, getLaneState, isLaneClaimed, releaseLane } from '../src/lifecycle/laneState.js';
import { acquireLock, withLock } from '../src/lifecycle/locks.js';
import { createRun, listRuns, loadRun, nextRunId, updateRun } from '../src/lifecycle/runState.js';

// shared temp root; cleaned after all tests
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'rk-opstate-'));
});

afterAll(async () => {
  // best-effort cleanup
  await rm(join(tmpdir()), { recursive: false }).catch(() => {});
});

async function makeOpRoot(): Promise<string> {
  const opRoot = join(tmpRoot, `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(opRoot, { recursive: true });
  return opRoot;
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'RUN-001',
    epic_id: 'E-001',
    lane: 'main',
    status: 'running',
    mode: 'assisted',
    agent: 'manual',
    worktree: '/tmp/worktree',
    branch: 'rk/E-001',
    started_at: '2026-04-25T10:00:00Z',
    ended_at: null,
    current_sprint: null,
    completed_sprints: [],
    halt_reason: null,
    limit: null,
    sprint_count: 0,
    ...overrides,
  };
}

// — locks —

describe('acquireLock / withLock', () => {
  it('acquires and releases a lock', async () => {
    const opRoot = await makeOpRoot();
    const release = await acquireLock('test', opRoot);
    await release();
    // re-acquire succeeds after release
    const release2 = await acquireLock('test', opRoot);
    await release2();
  });

  it('throws LOCK_CONFLICT when lock is already held', async () => {
    const opRoot = await makeOpRoot();
    const release = await acquireLock('conflict', opRoot);
    try {
      await expect(acquireLock('conflict', opRoot)).rejects.toThrow(RepoKernelError);
      await expect(acquireLock('conflict', opRoot)).rejects.toMatchObject({
        kind: 'IO_ERROR',
      });
    } finally {
      await release();
    }
  });

  it('withLock releases on success', async () => {
    const opRoot = await makeOpRoot();
    const result = await withLock('wl-success', opRoot, async () => 'ok');
    expect(result).toBe('ok');
    // lock is released — re-acquire must succeed
    const release = await acquireLock('wl-success', opRoot);
    await release();
  });

  it('withLock releases on error', async () => {
    const opRoot = await makeOpRoot();
    await expect(
      withLock('wl-fail', opRoot, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // lock is released
    const release = await acquireLock('wl-fail', opRoot);
    await release();
  });

  it('different names do not conflict', async () => {
    const opRoot = await makeOpRoot();
    const r1 = await acquireLock('alpha', opRoot);
    const r2 = await acquireLock('beta', opRoot);
    await r1();
    await r2();
  });
});

// — laneState —

describe('claimLane / releaseLane / getLaneState / isLaneClaimed', () => {
  it('returns null when lane is unclaimed', async () => {
    const opRoot = await makeOpRoot();
    expect(await getLaneState('main', opRoot)).toBeNull();
    expect(await isLaneClaimed('main', opRoot)).toBe(false);
  });

  it('claims a lane and retrieves ownership', async () => {
    const opRoot = await makeOpRoot();
    await claimLane('main', 'RUN-001', 'E-001', '/tmp/wt', 'rk/E-001', opRoot);
    const state = await getLaneState('main', opRoot);
    expect(state).not.toBeNull();
    expect(state?.lane).toBe('main');
    expect(state?.run_id).toBe('RUN-001');
    expect(state?.epic_id).toBe('E-001');
    expect(state?.worktree).toBe('/tmp/wt');
    expect(state?.branch).toBe('rk/E-001');
    expect(typeof state?.claimed_at).toBe('string');
    expect(await isLaneClaimed('main', opRoot)).toBe(true);
  });

  it('throws when lane is already claimed', async () => {
    const opRoot = await makeOpRoot();
    await claimLane('main', 'RUN-001', 'E-001', '/tmp/wt1', 'rk/E-001', opRoot);
    await expect(
      claimLane('main', 'RUN-002', 'E-002', '/tmp/wt2', 'rk/E-002', opRoot),
    ).rejects.toMatchObject({ kind: 'IO_ERROR' });
  });

  it('releases a claimed lane', async () => {
    const opRoot = await makeOpRoot();
    await claimLane('main', 'RUN-001', 'E-001', '/tmp/wt', 'rk/E-001', opRoot);
    await releaseLane('main', opRoot);
    expect(await getLaneState('main', opRoot)).toBeNull();
    expect(await isLaneClaimed('main', opRoot)).toBe(false);
  });

  it('release is idempotent — no error when lane already unclaimed', async () => {
    const opRoot = await makeOpRoot();
    await expect(releaseLane('main', opRoot)).resolves.toBeUndefined();
  });

  it('release with correct ownerRunId succeeds', async () => {
    const opRoot = await makeOpRoot();
    await claimLane('main', 'RUN-001', 'E-001', '/tmp/wt', 'rk/E-001', opRoot);
    await releaseLane('main', opRoot, 'RUN-001');
    expect(await getLaneState('main', opRoot)).toBeNull();
  });

  it('release with wrong ownerRunId skips deletion (ownership mismatch)', async () => {
    const opRoot = await makeOpRoot();
    await claimLane('main', 'RUN-001', 'E-001', '/tmp/wt', 'rk/E-001', opRoot);
    await releaseLane('main', opRoot, 'RUN-999'); // wrong owner
    // Lane should still be claimed by RUN-001
    expect((await getLaneState('main', opRoot))?.run_id).toBe('RUN-001');
  });

  it('different lanes are independent', async () => {
    const opRoot = await makeOpRoot();
    await claimLane('main', 'RUN-001', 'E-001', '/tmp/wt', 'rk/E-001', opRoot);
    await claimLane('release', 'RUN-002', 'E-002', '/tmp/wt2', 'rk/E-002', opRoot);
    expect((await getLaneState('main', opRoot))?.run_id).toBe('RUN-001');
    expect((await getLaneState('release', opRoot))?.run_id).toBe('RUN-002');
    await releaseLane('main', opRoot);
    expect(await getLaneState('main', opRoot)).toBeNull();
    expect((await getLaneState('release', opRoot))?.run_id).toBe('RUN-002');
  });
});

// — runState —

describe('nextRunId', () => {
  it('returns RUN-001 when no runs exist', async () => {
    const opRoot = await makeOpRoot();
    expect(await nextRunId(opRoot)).toBe('RUN-001');
  });

  it('increments past existing runs', async () => {
    const opRoot = await makeOpRoot();
    await createRun(makeRun({ id: 'RUN-001' }), opRoot);
    await createRun(makeRun({ id: 'RUN-002' }), opRoot);
    expect(await nextRunId(opRoot)).toBe('RUN-003');
  });
});

describe('createRun / loadRun / updateRun / listRuns', () => {
  it('creates and loads a run', async () => {
    const opRoot = await makeOpRoot();
    const run = makeRun();
    await createRun(run, opRoot);
    const loaded = await loadRun('RUN-001', opRoot);
    expect(loaded.id).toBe('RUN-001');
    expect(loaded.epic_id).toBe('E-001');
    expect(loaded.status).toBe('running');
    expect(loaded.sprint_count).toBe(0);
  });

  it('throws IO_ERROR for missing run', async () => {
    const opRoot = await makeOpRoot();
    await expect(loadRun('RUN-999', opRoot)).rejects.toThrow(RepoKernelError);
    await expect(loadRun('RUN-999', opRoot)).rejects.toMatchObject({ kind: 'IO_ERROR' });
  });

  it('updateRun applies patch immutably', async () => {
    const opRoot = await makeOpRoot();
    await createRun(makeRun(), opRoot);
    const updated = await updateRun(
      'RUN-001',
      { status: 'paused', halt_reason: 'awaiting_review', sprint_count: 1 },
      opRoot,
    );
    expect(updated.status).toBe('paused');
    expect(updated.halt_reason).toBe('awaiting_review');
    expect(updated.sprint_count).toBe(1);
    expect(updated.id).toBe('RUN-001'); // id unchanged
  });

  it('listRuns returns sorted runs', async () => {
    const opRoot = await makeOpRoot();
    await createRun(makeRun({ id: 'RUN-003' }), opRoot);
    await createRun(makeRun({ id: 'RUN-001' }), opRoot);
    await createRun(makeRun({ id: 'RUN-002' }), opRoot);
    const runs = await listRuns(opRoot);
    expect(runs.map((r) => r.id)).toEqual(['RUN-001', 'RUN-002', 'RUN-003']);
  });

  it('listRuns returns empty array when no runs directory', async () => {
    const opRoot = await makeOpRoot();
    const runs = await listRuns(opRoot);
    expect(runs).toEqual([]);
  });

  it('listRuns skips corrupt run files', async () => {
    const opRoot = await makeOpRoot();
    await createRun(makeRun({ id: 'RUN-001' }), opRoot);
    // write a corrupt file
    const { mkdir: mkd, writeFile } = await import('node:fs/promises');
    const runsDir = join(opRoot, 'runs');
    await mkd(runsDir, { recursive: true });
    await writeFile(join(runsDir, 'RUN-002.json'), 'not-valid-json', 'utf8');
    const runs = await listRuns(opRoot);
    expect(runs.length).toBe(1);
    expect(runs[0]!.id).toBe('RUN-001');
  });

  it('updateRun persists changes on reload', async () => {
    const opRoot = await makeOpRoot();
    await createRun(makeRun(), opRoot);
    await updateRun('RUN-001', { status: 'completed', ended_at: '2026-04-25T11:00:00Z' }, opRoot);
    const reloaded = await loadRun('RUN-001', opRoot);
    expect(reloaded.status).toBe('completed');
    expect(reloaded.ended_at).toBe('2026-04-25T11:00:00Z');
  });
});
