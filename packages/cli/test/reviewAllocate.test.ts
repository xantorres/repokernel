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
      allocations: Array<{ sprintId: string; reviewId: string | null }>;
    };
    expect(obj.allocations).toHaveLength(2);
    expect(obj.allocations[0]?.reviewId).toBe('R-001');
    expect(obj.allocations[1]?.reviewId).toBe('R-002');
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

  it('non-JSON output is one row per allocation', async () => {
    const cwd = await project();
    const r = await runReviewAllocateCommand({
      cwd,
      sprintIds: ['S-001', 'S-002'],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('R-001');
    expect(r.stdout).toContain('S-001');
    expect(r.stdout).toContain('R-002');
    expect(r.stdout).toContain('S-002');
  });
});
