import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimSprint, listSprintClaims, releaseSprint } from '../src/lifecycle/sprintClaim.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-claim-race-'));
  tracked.push(dir);
  return dir;
}

async function opRootFor(dir: string): Promise<string> {
  const opRoot = join(dir, '.git', 'repokernel');
  await mkdir(opRoot, { recursive: true });
  return opRoot;
}

describe('sprint claim race', () => {
  it('exactly one of N concurrent claims succeeds', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    const N = 16;
    const runIds = Array.from({ length: N }, (_, i) => `RUN-${String(i + 1).padStart(3, '0')}`);

    const outcomes = await Promise.all(
      runIds.map((runId) => claimSprint({ opRoot, runId, sprintId: 'S-1' })),
    );

    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);
    for (const lose of losers) {
      if (!lose.ok) {
        expect(lose.reason).toBe('already_claimed');
        expect(runIds).toContain(lose.heldBy);
      }
    }

    const claims = await listSprintClaims(opRoot);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.sprintId).toBe('S-1');
  });

  it('a claim released by its owner is reclaimable', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    const first = await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    expect(first.ok).toBe(true);
    await releaseSprint({ opRoot, sprintId: 'S-1', runId: 'RUN-001' });
    const second = await claimSprint({ opRoot, runId: 'RUN-002', sprintId: 'S-1' });
    expect(second.ok).toBe(true);
  });

  it('claims for distinct sprints do not interfere', async () => {
    const dir = await tmp();
    const opRoot = await opRootFor(dir);
    const a = await claimSprint({ opRoot, runId: 'RUN-001', sprintId: 'S-1' });
    const b = await claimSprint({ opRoot, runId: 'RUN-002', sprintId: 'S-2' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const claims = await listSprintClaims(opRoot);
    expect(claims.map((c) => c.sprintId).sort()).toEqual(['S-1', 'S-2']);
  });
});
