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
    expect(obj.result).toBe('runnable');
    expect(obj.sprintId).toBe('S-002');
  });

  it('--json includes queue[] with per-slot reason[]', async () => {
    const cwd = await runnableProject();
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      queue: Array<{ sprintId: string; runnable: boolean; reason: string[] }>;
    };
    expect(Array.isArray(obj.queue)).toBe(true);
    // S-002 is active → runnable, empty reason
    const s002 = obj.queue.find((e) => e.sprintId === 'S-002');
    expect(s002).toBeDefined();
    expect(s002?.runnable).toBe(true);
    expect(s002?.reason).toEqual([]);
    // S-003 depends on S-001 (shipped) → runnable (dep met), but let's at minimum verify shape
    const s003 = obj.queue.find((e) => e.sprintId === 'S-003');
    expect(s003).toBeDefined();
    expect(Array.isArray(s003?.reason)).toBe(true);
  });

  it('renders satisfying text for a runnable sprint', async () => {
    const cwd = await runnableProject();
    const r = await runNextCommand({ cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Next runnable sprint');
    expect(r.stdout).toContain('S-002: s');
    expect(r.stdout).toContain('Why this sprint:');
    expect(r.stdout).toContain('Allowed paths:');
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
    expect(obj.result).toBe('blocked');
    expect((obj.blockers as unknown[]).length).toBeGreaterThan(0);
  });

  it('explains queue-slot blocked reasons in text output', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'e',
          status: 'active',
          sprints: ['S-001', 'S-003'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'dep',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'sprints/S-003.md', content: QUEUED_S003 },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-003', sprint_id: 'S-003', order: 0 }],
        }),
      },
    ]);
    const r = await runNextCommand({ cwd, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('No runnable sprint');
    expect(r.stdout).toContain('Queue');
    expect(r.stdout).toContain('Reason: depends on S-001');
  });

  it('blocks instead of starting queued work when a lane has multiple active sprints', async () => {
    const cwd = await makeFixture([
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
      { path: 'sprints/S-001.md', content: ACTIVE_S002.replaceAll('S-002', 'S-001') },
      { path: 'sprints/S-002.md', content: ACTIVE_S002 },
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 's',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [
            { id: 'Q-001', sprint_id: 'S-001', order: 0 },
            { id: 'Q-002', sprint_id: 'S-002', order: 1 },
            { id: 'Q-003', sprint_id: 'S-003', order: 2 },
          ],
        }),
      },
    ]);
    const r = await runNextCommand({ cwd, json: true });
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(r.exitCode).toBe(1);
    expect(obj.result).toBe('blocked');
    expect(JSON.stringify(obj.blockers)).toContain('MULTIPLE_ACTIVE_SPRINTS_IN_LANE');
  });

  it('returns none on a clean empty queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(1);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj.result).toBe('none');
  });
});

describe('runStatusCommand', () => {
  it('summarizes a clean project', async () => {
    const cwd = await runnableProject();
    const r = await runStatusCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect((obj.counts as { sprints: number }).sprints).toBe(3);
    expect((obj.counts as { active: number }).active).toBe(1);
    expect((obj.next as { sprintId: string | null }).sprintId).toBe('S-002');
    expect(obj.blocked).toBe(false);
  });

  it('renders the project summary text used by the default command', async () => {
    const cwd = await runnableProject();
    const r = await runStatusCommand({ cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('RepoKernel');
    expect(r.stdout).toContain('State:   valid');
    expect(r.stdout).toContain('Next work:');
    expect(r.stdout).toContain('S-002: s');
  });

  it('exits 1 when the status report is blocked', async () => {
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
    const r = await runStatusCommand({ cwd, json: true });
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(r.exitCode).toBe(1);
    expect(obj.blocked).toBe(true);
  });

  it('--brief emits a one-line summary on a clean project', async () => {
    const cwd = await runnableProject();
    const r = await runStatusCommand({ cwd, json: false, brief: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^RK \| /);
    expect(r.stdout).toContain('S-002');
    expect(r.stdout).toContain('lanes');
  });

  it('--brief --json emits the brief shape', async () => {
    const cwd = await runnableProject();
    const r = await runStatusCommand({ cwd, json: true, brief: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj).toHaveProperty('active_epic');
    expect(obj).toHaveProperty('next_sprint');
    expect(obj).toHaveProperty('lanes_free');
    expect(obj).toHaveProperty('lanes_total');
    expect(obj).toHaveProperty('initialized');
    expect(obj.initialized).toBe(true);
    expect(obj.next_sprint).toBe('S-002');
  });

  it('--brief on an uninitialized project does not throw', async () => {
    const cwd = await makeFixture([]);
    const r = await runStatusCommand({ cwd, json: false, brief: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('not initialized');
  });
});
