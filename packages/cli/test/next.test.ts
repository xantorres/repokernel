import { afterAll, describe, expect, it } from 'vitest';
import { runNextCommand } from '../src/commands/next.js';
import { runStatusCommand } from '../src/commands/status.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const SHIPPED_S001 = fm({
  id: 'S-001',
  title: 's',
  epic_id: 'E-001',
  status: 'shipped',
  lane: 'main',
  started_at: '2026-04-25T10:00:00Z',
  closed_at: '2026-04-25T11:00:00Z',
  base_sha: 'a1b2c3d',
  end_sha: 'b2c3d4e',
  review_id: 'R-001',
});

const ACTIVE_S002 = fm({
  id: 'S-002',
  title: 's',
  epic_id: 'E-001',
  status: 'active',
  lane: 'main',
  started_at: '2026-04-25T12:00:00Z',
  base_sha: 'a1b2c3d',
});

const QUEUED_S003 = fm({
  id: 'S-003',
  title: 's',
  epic_id: 'E-001',
  status: 'queued',
  lane: 'main',
  depends_on: ['S-001'],
});

const REVIEW_R001 = fm({
  id: 'R-001',
  sprint_id: 'S-001',
  verdict: 'accepted',
  reviewer: 'someone',
  created_at: '2026-04-25T11:30:00Z',
});

async function runnableProject() {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'e',
        status: 'active',
        sprints: ['S-001', 'S-002', 'S-003'],
      }),
    },
    { path: 'sprints/S-001.md', content: SHIPPED_S001 },
    { path: 'sprints/S-002.md', content: ACTIVE_S002 },
    { path: 'sprints/S-003.md', content: QUEUED_S003 },
    { path: 'reviews/R-001.md', content: REVIEW_R001 },
    {
      path: 'queues/main.md',
      content: fm({
        lane: 'main',
        slots: [
          { id: 'Q-002', sprint_id: 'S-002', order: 0 },
          { id: 'Q-003', sprint_id: 'S-003', order: 1 },
        ],
      }),
    },
  ]);
}

describe('runNextCommand', () => {
  it('returns the active sprint with priority over queued work', async () => {
    const cwd = await runnableProject();
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj['result']).toBe('runnable');
    expect(obj['sprintId']).toBe('S-002');
  });

  it('returns blocked when a P1 finding exists', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-999',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(1);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj['result']).toBe('blocked');
    expect((obj['blockers'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('returns none on a clean empty queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(1);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj['result']).toBe('none');
  });
});

describe('runStatusCommand', () => {
  it('summarizes a clean project', async () => {
    const cwd = await runnableProject();
    const r = await runStatusCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect((obj['counts'] as { sprints: number }).sprints).toBe(3);
    expect((obj['counts'] as { active: number }).active).toBe(1);
    expect((obj['next'] as { sprintId: string | null }).sprintId).toBe('S-002');
    expect(obj['blocked']).toBe(false);
  });
});
