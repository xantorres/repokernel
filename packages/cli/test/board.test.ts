import { afterAll, describe, expect, it } from 'vitest';
import { runBoardCommand } from '../src/commands/board.js';
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
        sprints: ['S-001', 'S-002', 'S-003'],
      }),
    },
    {
      path: 'epics/E-002.md',
      content: fm({ id: 'E-002', title: 'Queue Import', status: 'planned', sprints: ['S-004'] }),
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
        depends_on: [],
      }),
    },
    {
      path: 'sprints/S-003.md',
      content: fm({
        id: 'S-003',
        title: 'Build graph',
        status: 'queued',
        epic_id: 'E-001',
        lane: 'main',
        depends_on: [],
      }),
    },
    {
      path: 'sprints/S-004.md',
      content: fm({
        id: 'S-004',
        title: 'Import queue data',
        status: 'planned',
        epic_id: 'E-002',
        lane: 'infra',
        depends_on: [],
      }),
    },
    { path: 'lanes/main.md', content: fm({ name: 'main' }) },
    { path: 'lanes/infra.md', content: fm({ name: 'infra' }) },
    {
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-003', order: 0 }] }),
    },
    { path: 'queues/infra.md', content: fm({ lane: 'infra', slots: [] }) },
  ];
}

describe('runBoardCommand', () => {
  it('renders all 5 status column headers', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, showCancelled: false, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('PLANNED');
    expect(out).toContain('QUEUED');
    expect(out).toContain('ACTIVE');
    expect(out).toContain('REVIEW');
    expect(out).toContain('SHIPPED');
  });

  it('does not include CANCELLED column by default', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, showCancelled: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).not.toContain('CANCELLED');
  });

  it('includes CANCELLED column with --show-cancelled', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, showCancelled: true, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('CANCELLED');
  });

  it('places sprint in correct column', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, showCancelled: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-001');
    expect(out).toContain('S-002');
    expect(out).toContain('S-003');
    expect(out).toContain('S-004');
  });

  it('filters by epic', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, epic: 'E-001', showCancelled: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-001');
    expect(out).toContain('S-002');
    expect(out).toContain('S-003');
    expect(out).not.toContain('S-004');
  });

  it('filters by lane', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, lane: 'infra', showCancelled: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-004');
    expect(out).not.toContain('S-001');
    expect(out).not.toContain('S-002');
  });

  it('emits JSON with columns object', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, showCancelled: false, json: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('columns');
    expect(data.columns).toHaveProperty('active');
    expect(data.columns).toHaveProperty('shipped');
    expect(data.columns).toHaveProperty('queued');
    expect(data.columns.active.length).toBeGreaterThan(0);
  });

  it('emits JSON filters field', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runBoardCommand({ cwd, epic: 'E-001', showCancelled: false, json: true });
    const data = JSON.parse(result.stdout);
    expect(data.filters.epic).toBe('E-001');
    expect(data.filters.lane).toBeNull();
  });

  it('shows (empty) placeholder when all columns empty', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runBoardCommand({ cwd, showCancelled: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('(empty)');
  });
});
