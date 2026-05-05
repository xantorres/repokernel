import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimSprint,
  detectStalledWorkers,
  effectiveConcurrencyCap,
  listSprintClaims,
  readSprintClaim,
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

async function opRootFor(dir: string): Promise<string> {
  const opRoot = join(dir, '.git', 'repokernel');
  await mkdir(opRoot, { recursive: true });
  return opRoot;
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

  it('clamps a 0 global cap to 1 to avoid runner deadlock', () => {
    expect(effectiveConcurrencyCap({ globalCap: 0, byState: {}, state: 'active' })).toBe(1);
  });

  it('clamps a 0 global cap to 1 even when a per-state override is positive', () => {
    expect(effectiveConcurrencyCap({ globalCap: 0, byState: { active: 3 }, state: 'active' })).toBe(
      1,
    );
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
  it('writes the claim record under the operational root', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    const result = await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    expect(result.ok).toBe(true);
    const claim = await readSprintClaim({ opRoot, sprintId: 'S-1' });
    expect(claim?.runId).toBe('RUN-001');
  });

  it('rejects a second claim from a different run id', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    const second = await claimSprint({ opRoot, runId: 'RUN-002', sprintId: 'S-1' });
    expect(second.ok).toBe(false);
    if (!second.ok && second.reason === 'already_claimed') {
      expect(second.heldBy).toBe('RUN-001');
    } else {
      throw new Error('expected already_claimed result');
    }
  });

  it('is idempotent for the same run id', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    const again = await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    expect(again.ok).toBe(true);
  });

  it('releaseSprint clears the claim', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    await releaseSprint({ opRoot, sprintId: 'S-1' });
    const claim = await readSprintClaim({ opRoot, sprintId: 'S-1' });
    expect(claim).toBeNull();
  });

  it('releaseSprint with mismatched runId is a no-op', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    await releaseSprint({ opRoot, sprintId: 'S-1', runId: 'RUN-002' });
    const claim = await readSprintClaim({ opRoot, sprintId: 'S-1' });
    expect(claim?.runId).toBe('RUN-001');
  });

  it('listSprintClaims surfaces all active claims sorted by sprint id', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-2' });
    await claimSprint({ opRoot, runId: 'RUN-002', sprintId: 'S-1' });
    const claims = await listSprintClaims(opRoot);
    expect(claims.map((c) => c.sprintId)).toEqual(['S-1', 'S-2']);
    expect(claims.find((c) => c.sprintId === 'S-2')?.runId).toBe('RUN-001');
  });

  it('listSprintClaims returns empty when no claim dir exists', async () => {
    const dir = await tmp();
    expect(await listSprintClaims(join(dir, 'no-such-root'))).toEqual([]);
  });
});
