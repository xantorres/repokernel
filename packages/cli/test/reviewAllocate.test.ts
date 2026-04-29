import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runReviewAllocateCommand } from '../src/commands/reviewAllocate.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'demo',
        status: 'active',
        sprints: ['S-001', 'S-002'],
      }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 's1',
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
      }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({
        id: 'S-002',
        title: 's2',
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

describe('runReviewAllocateCommand', () => {
  it('rejects empty sprint list', async () => {
    const cwd = await project();
    const r = await runReviewAllocateCommand({ cwd, sprintIds: [], json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--sprint <id> is required');
  });

  it('rejects malformed sprint ids (e.g. epic id passed by mistake)', async () => {
    const cwd = await project();
    const r = await runReviewAllocateCommand({
      cwd,
      sprintIds: ['E-001', 'not-a-sprint'],
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid sprint id');
  });

  it('allocates fresh review IDs and writes stub files', async () => {
    const cwd = await project();
    const r = await runReviewAllocateCommand({
      cwd,
      sprintIds: ['S-001', 'S-002'],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      allocations: Array<{ sprintId: string; reviewId: string | null; reused: boolean }>;
    };
    expect(obj.allocations).toHaveLength(2);
    expect(obj.allocations[0]?.reviewId).toBe('R-001');
    expect(obj.allocations[0]?.reused).toBe(false);
    expect(obj.allocations[1]?.reviewId).toBe('R-002');
    expect(obj.allocations[1]?.reused).toBe(false);
    const stub1 = await readFile(join(cwd, 'reviews/R-001.md'), 'utf8');
    expect(matter(stub1).data.sprint_id).toBe('S-001');
    const stub2 = await readFile(join(cwd, 'reviews/R-002.md'), 'utf8');
    expect(matter(stub2).data.sprint_id).toBe('S-002');
  });

  it('two sequential calls produce non-overlapping IDs', async () => {
    const cwd = await project();
    const r1 = await runReviewAllocateCommand({
      cwd,
      sprintIds: ['S-001'],
      json: true,
    });
    const r2 = await runReviewAllocateCommand({
      cwd,
      sprintIds: ['S-002'],
      json: true,
    });
    const o1 = JSON.parse(r1.stdout) as {
      allocations: Array<{ reviewId: string | null }>;
    };
    const o2 = JSON.parse(r2.stdout) as {
      allocations: Array<{ reviewId: string | null }>;
    };
    expect(o1.allocations[0]?.reviewId).toBe('R-001');
    expect(o2.allocations[0]?.reviewId).toBe('R-002');
  });

  it('concurrent calls do not collide (counter file under lock)', async () => {
    const cwd = await project();
    const [r1, r2] = await Promise.all([
      runReviewAllocateCommand({ cwd, sprintIds: ['S-001'], json: true }),
      runReviewAllocateCommand({ cwd, sprintIds: ['S-002'], json: true }),
    ]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    const o1 = JSON.parse(r1.stdout) as {
      allocations: Array<{ reviewId: string | null }>;
    };
    const o2 = JSON.parse(r2.stdout) as {
      allocations: Array<{ reviewId: string | null }>;
    };
    const ids = new Set([o1.allocations[0]?.reviewId, o2.allocations[0]?.reviewId]);
    // Both must be non-null and distinct.
    expect(ids.size).toBe(2);
    expect([...ids]).not.toContain(undefined);
    expect([...ids]).not.toContain(null);
  });

  it('N=10 concurrent single-sprint allocations produce 10 unique IDs', async () => {
    // Create a project with 10 unique sprint IDs so idempotency doesn't trigger.
    const N = 10;
    const sprintIds = Array.from({ length: N }, (_, i) => `S-${String(i + 1).padStart(3, '0')}`);
    const fixtures: Array<{ path: string; content: string }> = [
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'big epic', status: 'active', sprints: sprintIds }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ];
    for (const id of sprintIds) {
      fixtures.push({
        path: `sprints/${id}.md`,
        content: fm({
          id,
          title: `sprint ${id}`,
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      });
    }
    const cwd = await makeFixture(fixtures);

    const results = await Promise.all(
      sprintIds.map((sid) => runReviewAllocateCommand({ cwd, sprintIds: [sid], json: true })),
    );

    const allIds: (string | null)[] = [];
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      const obj = JSON.parse(r.stdout) as { allocations: Array<{ reviewId: string | null }> };
      allIds.push(obj.allocations[0]?.reviewId ?? null);
    }

    // All 10 IDs must be non-null.
    expect(allIds.every((id) => id !== null)).toBe(true);
    // All 10 IDs must be distinct (no collision under concurrent lock).
    expect(new Set(allIds).size).toBe(N);
  }, 15_000);

  it('repeated allocate for same sprint is idempotent — reuses pending stub, no counter advance', async () => {
    const cwd = await project();
    const r1 = await runReviewAllocateCommand({ cwd, sprintIds: ['S-001'], json: true });
    const o1 = JSON.parse(r1.stdout) as {
      allocations: Array<{ reviewId: string | null; reused: boolean }>;
    };
    expect(o1.allocations[0]?.reviewId).toBe('R-001');
    expect(o1.allocations[0]?.reused).toBe(false);

    const r2 = await runReviewAllocateCommand({ cwd, sprintIds: ['S-001'], json: true });
    const o2 = JSON.parse(r2.stdout) as {
      allocations: Array<{ reviewId: string | null; reused: boolean }>;
    };
    expect(o2.allocations[0]?.reviewId).toBe('R-001');
    expect(o2.allocations[0]?.reused).toBe(true);

    // Counter must not have advanced — next fresh sprint takes R-002, not R-003
    const r3 = await runReviewAllocateCommand({ cwd, sprintIds: ['S-002'], json: true });
    const o3 = JSON.parse(r3.stdout) as {
      allocations: Array<{ reviewId: string | null; reused: boolean }>;
    };
    expect(o3.allocations[0]?.reviewId).toBe('R-002');
    expect(o3.allocations[0]?.reused).toBe(false);
  });

  it('non-JSON output marks reused rows', async () => {
    const cwd = await project();
    await runReviewAllocateCommand({ cwd, sprintIds: ['S-001'], json: true });
    const r = await runReviewAllocateCommand({
      cwd,
      sprintIds: ['S-001', 'S-002'],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/R-001\s+S-001\s+\(reused\)/);
    expect(r.stdout).toMatch(/R-002\s+S-002(?!\s+\(reused\))/);
  });
});
