import { afterAll, describe, expect, it } from 'vitest';
import {
  runLsEpicsCommand,
  runLsLanesCommand,
  runLsReviewsCommand,
  runLsSprintsCommand,
} from '../src/commands/ls.js';
import { stripAnsi } from '../src/format/table.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function baseFixture() {
  return [
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'Core Validator',
        status: 'active',
        sprints: ['S-001', 'S-002'],
      }),
    },
    {
      path: 'epics/E-002.md',
      content: fm({
        id: 'E-002',
        title: 'Backlog Importer',
        status: 'planned',
        sprints: ['S-003'],
      }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Config loader',
        status: 'shipped',
        epic_id: 'E-001',
        lane: 'main',
        depends_on: [],
      }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({
        id: 'S-002',
        title: 'Parse sprints',
        status: 'active',
        epic_id: 'E-001',
        lane: 'main',
        depends_on: ['S-001'],
      }),
    },
    {
      path: 'sprints/S-003.md',
      content: fm({
        id: 'S-003',
        title: 'Import backlog',
        status: 'queued',
        epic_id: 'E-002',
        lane: 'infra',
        depends_on: [],
      }),
    },
    {
      path: 'reviews/R-001.md',
      content: fm({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'accepted',
        reviewer: 'alice',
        created_at: '2024-01-01T00:00:00Z',
        findings: [],
      }),
    },
    {
      path: 'reviews/R-002.md',
      content: fm({
        id: 'R-002',
        sprint_id: 'S-002',
        verdict: 'pending',
        reviewer: 'agent',
        created_at: '2024-01-02T00:00:00Z',
        findings: [],
      }),
    },
    { path: 'lanes/main.md', content: fm({ name: 'main', claimed_by: 'alice' }) },
    { path: 'lanes/infra.md', content: fm({ name: 'infra' }) },
    {
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-002', order: 0 }] }),
    },
    {
      path: 'queues/infra.md',
      content: fm({ lane: 'infra', slots: [{ id: 'Q-001', sprint_id: 'S-003', order: 0 }] }),
    },
  ];
}

// — rk ls epics —

describe('runLsEpicsCommand', () => {
  it('lists all epics with progress', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('E-001');
    expect(out).toContain('Core Validator');
    expect(out).toContain('E-002');
    expect(out).toContain('Backlog Importer');
  });

  it('filters by status', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, status: 'active', json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('E-001');
    expect(out).not.toContain('E-002');
  });

  it('shows empty state gracefully', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runLsEpicsCommand({ cwd, status: 'done', json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(no epics)');
  });

  it('emits JSON with sprintCounts', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, json: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('epics');
    expect(Array.isArray(data.epics)).toBe(true);
    const e1 = data.epics.find((e: { id: string }) => e.id === 'E-001');
    expect(e1).toBeDefined();
    expect(e1.sprintCounts).toHaveProperty('shipped');
  });

  it('shows progress bar in text output', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    // E-001 has 1 shipped out of 2
    expect(out).toContain('1/2');
  });
});

// — rk ls sprints —

describe('runLsSprintsCommand', () => {
  it('lists all sprints', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, withDeps: false, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-001');
    expect(out).toContain('S-002');
    expect(out).toContain('S-003');
  });

  it('filters by epic', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, epic: 'E-001', withDeps: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-001');
    expect(out).toContain('S-002');
    expect(out).not.toContain('S-003');
  });

  it('filters by status', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({
      cwd,
      status: 'active',
      withDeps: false,
      json: false,
    });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-002');
    expect(out).not.toContain('S-001');
    expect(out).not.toContain('S-003');
  });

  it('filters by lane', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, lane: 'infra', withDeps: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-003');
    expect(out).not.toContain('S-001');
  });

  it('shows deps column when --with-deps', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, withDeps: true, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('DEPS');
    expect(out).toContain('S-001'); // S-002 depends on S-001
  });

  it('emits JSON with sprint array', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, withDeps: false, json: true });
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('sprints');
    expect(data.sprints.length).toBe(3);
  });

  it('combines epic + lane filters', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({
      cwd,
      epic: 'E-001',
      lane: 'infra',
      withDeps: false,
      json: false,
    });
    // E-001 sprints are on 'main', not 'infra'
    expect(result.stdout).toContain('(no sprints)');
  });
});

// — rk ls reviews —

describe('runLsReviewsCommand', () => {
  it('lists all reviews', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('R-001');
    expect(out).toContain('R-002');
  });

  it('filters by verdict', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, verdict: 'pending', json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('R-002');
    expect(out).not.toContain('R-001');
  });

  it('filters by sprint', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, sprint: 'S-001', json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('R-001');
    expect(out).not.toContain('R-002');
  });

  it('emits JSON with findings_count', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, json: true });
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('reviews');
    expect(data.reviews[0]).toHaveProperty('findings_count');
  });

  it('shows empty state when no reviews match filter', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, verdict: 'rejected', json: false });
    expect(result.stdout).toContain('(no reviews)');
  });
});

// — rk ls lanes —

describe('runLsLanesCommand', () => {
  it('lists all lanes', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('main');
    expect(out).toContain('infra');
  });

  it('shows claimed status for lane with claimed_by', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('alice');
    expect(out).toContain('claimed');
  });

  it('shows free status for unclaimed lane', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    // infra lane has no claimed_by
    expect(out).toContain('free');
  });

  it('emits JSON with lane array', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: true });
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('lanes');
    expect(data.lanes.length).toBe(2);
    const main = data.lanes.find((l: { name: string }) => l.name === 'main');
    expect(main.claimed_by).toBe('alice');
    expect(main.queueDepth).toBe(1);
  });

  it('shows empty state when no lanes exist', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runLsLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(no lanes)');
  });
});
