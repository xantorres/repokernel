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
    const obj = (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data;
    expect(obj.result).toBe('runnable');
    expect(obj.sprint_id).toBe('S-002');
  });

  it('--json includes queue[] with per-slot reason[]', async () => {
    const cwd = await runnableProject();
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = (
      JSON.parse(r.stdout) as {
        data: { queue: Array<{ sprintId: string; runnable: boolean; reason: string[] }> };
      }
    ).data;
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

  it('--json emits active_epic_progress: null when no epic is active', async () => {
    // All epics done — no active epic to summarise. The field must be present
    // and explicitly null so consumers don't have to distinguish missing key
    // from null.
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'e', status: 'done', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 's',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-04-25T10:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const r = await runNextCommand({ cwd, json: true });
    const obj = (JSON.parse(r.stdout) as { error: { details: { active_epic_progress: unknown } } })
      .error.details;
    expect(obj.active_epic_progress).toBeNull();
  });

  it('--json includes active_epic_progress, last_closed, and queue_depth', async () => {
    const cwd = await runnableProject();
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = (
      JSON.parse(r.stdout) as {
        data: {
          active_epic_progress?: {
            epicId: string;
            shipped: number;
            total: number;
            remaining_ids: string[];
            in_flight: string[];
          };
          last_closed?: { sprintId: string; closedAt: string } | null;
          queue_depth?: { lane: string; slots: number; queued: number; active: number };
        };
      }
    ).data;

    expect(obj.active_epic_progress).toEqual({
      epicId: 'E-001',
      shipped: 1,
      total: 3,
      // Queued counts as not-yet-started (remaining), not in-flight.
      // S-002 is active → in_flight; S-003 is queued → remaining.
      in_flight: ['S-002'],
      remaining_ids: ['S-003'],
    });

    expect(obj.last_closed).toEqual({
      sprintId: 'S-001',
      closedAt: '2026-04-25T11:00:00Z',
    });

    expect(obj.queue_depth).toEqual({
      lane: 'main',
      slots: 2,
      queued: 1,
      active: 1,
    });
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
    const obj = JSON.parse(r.stdout) as { error: { details: Record<string, unknown> } };
    const details = obj.error.details;
    expect(details.result).toBe('blocked');
    expect((details.blockers as unknown[]).length).toBeGreaterThan(0);
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
    expect(r.stdout).toContain('Reason: unmet dependencies: S-001');
  });

  it('does not suggest an unqueued planned sprint whose upstream was cancelled', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'e',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'cancelled upstream',
          epic_id: 'E-001',
          status: 'cancelled',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'downstream',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          depends_on: ['S-001'],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runNextCommand({ cwd, json: true });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      error: { details: { result: string; sprint_id: string | null; newly_unblocked: string[] } };
    };
    expect(parsed.error.details).toMatchObject({
      result: 'none',
      sprint_id: null,
      newly_unblocked: [],
    });
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
    const obj = JSON.parse(r.stdout) as { error: { details: Record<string, unknown> } };
    const details = obj.error.details;
    expect(r.exitCode).toBe(1);
    expect(details.result).toBe('blocked');
    expect(JSON.stringify(details.blockers)).toContain('MULTIPLE_ACTIVE_SPRINTS_IN_LANE');
  });

  it('returns none on a clean empty queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(1);
    const obj = JSON.parse(r.stdout) as { error: { details: Record<string, unknown> } };
    expect(obj.error.details.result).toBe('none');
  });

  it('--include-planned returns an unblocked planned sprint when no queued sprint is runnable', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'e',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'planned but unblocked',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const r = await runNextCommand({ cwd, json: true, includePlanned: true });
    expect(r.exitCode).toBe(0);
    const obj = (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data;
    expect(obj.result).toBe('planned');
    expect(obj.sprint_id).toBe('S-001');
    expect(obj.epic_id).toBe('E-001');
  });

  it('returns an unblocked planned sprint by default when no queued sprint is runnable', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'e',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'planned but unblocked',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const r = await runNextCommand({ cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = (JSON.parse(r.stdout) as { data: Record<string, unknown> }).data;
    expect(obj.result).toBe('planned');
    expect(obj.action).toEqual({
      command: 'rk queue add S-001 --lane main',
      reason: 'unblocked planned sprint is not queued',
    });
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
    expect(r.stdout).toMatch(/^RK status \| /);
    expect(r.stdout).toContain('S-002');
    expect(r.stdout).toContain('lanes');
  });

  it('--brief --json emits the brief shape', async () => {
    const cwd = await runnableProject();
    const r = await runStatusCommand({ cwd, json: true, brief: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj).toHaveProperty('activeEpicId');
    expect(obj).toHaveProperty('nextSprintId');
    expect(obj).toHaveProperty('lanesFree');
    expect(obj).toHaveProperty('lanesTotal');
    expect(obj).toHaveProperty('initialized');
    expect(obj.initialized).toBe(true);
    expect(obj.nextSprintId).toBe('S-002');
  });

  it('--brief on an uninitialized project does not throw', async () => {
    const cwd = await makeFixture([]);
    const r = await runStatusCommand({ cwd, json: false, brief: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('not initialized');
  });
});
