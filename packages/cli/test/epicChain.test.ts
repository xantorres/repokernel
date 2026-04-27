import { afterAll, describe, expect, it } from 'vitest';
import { runChainPreviewCommand } from '../src/commands/chain.js';
import { runEpicMapCommand } from '../src/commands/epic.js';
import { cleanupAllFixtures, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function configYaml(chainingEnabled = false): string {
  return `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
chaining:
  enabled: ${chainingEnabled}
  maxSprintsPerRun: 3
`;
}

function epicFile(sprintIds: string[]) {
  return fm({ id: 'E-001', title: 'Core Validator', status: 'active', sprints: sprintIds });
}

function queueFile(slots: Array<{ id: string; sprint_id: string; order: number }>) {
  return fm({ lane: 'main', slots });
}

// — chain preview —

describe('runChainPreviewCommand', () => {
  it('shows disabled notice and preview when chaining is off', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(false) },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse config',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Parse sprints',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          { id: 'Q-002', sprint_id: 'S-002', order: 1 },
        ]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      limit: 5,
      ignoreDisabled: false,
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Chaining is disabled');
    expect(r.stdout).toContain('Preview');
    expect(r.stdout).toContain('Enable:');
    expect(r.stdout).toContain('S-001');
  });

  it('planned sprints are not eligible — shown as ineligible', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(true) },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Queued sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Planned sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      limit: 5,
      ignoreDisabled: false,
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('S-002  '); // S-002 not in eligible list
    // S-002 is planned and not in the queue, so it won't appear in the chain output
    expect(r.stdout).toContain('S-001');
    expect(r.stdout).toContain('eligible');
  });

  it('shows planned sprint as ineligible in --ignore-disabled mode', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(false) },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Queued sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Planned sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          // S-002 is planned, NOT in queue — so it won't appear in queuesByLane
        ]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      limit: 5,
      ignoreDisabled: true,
      json: false,
    });
    expect(r.exitCode).toBe(0);
    // preview with --ignore-disabled
    expect(r.stdout).toContain('preview with --ignore-disabled');
    expect(r.stdout).toContain('S-001');
    expect(r.stdout).toContain('Chain eligible:');
  });

  it('JSON output contains eligible, chain, ineligible, gate fields', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(true) },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      limit: 5,
      ignoreDisabled: false,
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(obj.eligible).toBe(true);
    expect(Array.isArray(obj.chain)).toBe(true);
    expect(Array.isArray(obj.ineligible)).toBe(true);
    expect('gate' in obj).toBe(true);
  });
});

// — epic map —

describe('runEpicMapCommand', () => {
  it('renders statuses, blocking notes, and planned not-eligible note', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002', 'S-003', 'S-004']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Shipped sprint',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T11:00:00Z',
          base_sha: 'aabbccd',
          end_sha: 'bbccdd1',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Active sprint',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          depends_on: ['S-001'],
          started_at: '2026-04-25T11:00:00Z',
          base_sha: 'ccdd00a',
        }),
      },
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 'Queued sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          depends_on: ['S-002'],
        }),
      },
      {
        path: 'sprints/S-004.md',
        content: fm({
          id: 'S-004',
          title: 'Planned sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-001', sprint_id: 'S-002', order: 0 },
          { id: 'Q-002', sprint_id: 'S-003', order: 1 },
        ]),
      },
    ]);

    const r = await runEpicMapCommand('E-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    // shipped sprint
    expect(r.stdout).toContain('■');
    expect(r.stdout).toContain('S-001');
    // active sprint with current marker
    expect(r.stdout).toContain('▶');
    expect(r.stdout).toContain('← current');
    // queued sprint blocked by active
    expect(r.stdout).toContain('S-003');
    expect(r.stdout).toContain('blocked by S-002');
    // planned sprint with not-eligible note
    expect(r.stdout).toContain('S-004');
    expect(r.stdout).toContain('not eligible');
    // summary line
    expect(r.stdout).toContain('1 shipped');
    expect(r.stdout).toContain('1 active');
  });

  it('JSON output contains sprint objects and summary', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
    ]);

    const r = await runEpicMapCommand('E-001', { cwd, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      id: string;
      sprints: Array<{ id: string; status: string }>;
      summary: Record<string, number>;
    };
    expect(obj.id).toBe('E-001');
    expect(obj.sprints).toHaveLength(1);
    expect(obj.sprints[0]?.id).toBe('S-001');
    expect(obj.summary.queued).toBe(1);
  });
});

// — planned sprints in chain preview —

describe('chain preview planned sprints', () => {
  it('text output shows "Planned (not yet queued)" section when --epic and planned sprint exists', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(true) },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Queued sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Planned sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 1 }]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      epic: 'E-001',
      limit: 10,
      ignoreDisabled: false,
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Planned (not yet queued)');
    expect(r.stdout).toContain('S-002');
    expect(r.stdout).toContain('rk queue add S-002');
  });

  it('JSON output includes planned_for_epic array when --epic given', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(true) },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Queued sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Planned sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 1 }]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      epic: 'E-001',
      limit: 10,
      ignoreDisabled: false,
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { planned_for_epic: Array<{ id: string; status: string }> };
    expect(obj.planned_for_epic).toHaveLength(1);
    expect(obj.planned_for_epic[0]?.id).toBe('S-002');
    expect(obj.planned_for_epic[0]?.status).toBe('planned');
  });

  it('planned_for_epic is empty when --epic not given', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(true) },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Queued sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Planned sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 1 }]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      limit: 10,
      ignoreDisabled: false,
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { planned_for_epic: unknown[] };
    expect(obj.planned_for_epic).toHaveLength(0);
  });

  it('disabled output also shows planned_for_epic section', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: configYaml(false) },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Queued sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Planned sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 1 }]),
      },
    ]);

    const r = await runChainPreviewCommand({
      cwd,
      lane: 'main',
      epic: 'E-001',
      limit: 10,
      ignoreDisabled: false,
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Planned (not yet queued)');
    expect(r.stdout).toContain('S-002');
  });
});
