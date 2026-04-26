import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runQueueAddCommand } from '../src/commands/queue.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function epicFile(sprintIds: string[]) {
  return fm({ id: 'E-001', title: 'Test Epic', status: 'active', sprints: sprintIds });
}

function queueFile(slots: Array<{ id: string; sprint_id: string; order: number }>) {
  return fm({ lane: 'main', slots });
}

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

describe('runQueueAddCommand', () => {
  it('planned → queued, adds slot, updates status', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runQueueAddCommand('S-001', { cwd, lane: 'main', force: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added S-001 to queue main');
    expect(r.stdout).toContain('planned → queued');

    const sprintData = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(sprintData.status).toBe('queued');

    const queueData = await readFm(join(cwd, 'queues/main.md'));
    const slots = queueData.slots as Array<{ id: string; sprint_id: string; order: number }>;
    expect(slots).toHaveLength(1);
    expect(slots[0]?.sprint_id).toBe('S-001');
    expect(slots[0]?.id).toBe('Q-001');
    expect(slots[0]?.order).toBe(0);
  });

  it('reopened → queued, adds slot', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'reopened',
          lane: 'main',
          base_sha: 'a1b2c3d',
          started_at: '2026-04-25T10:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runQueueAddCommand('S-001', { cwd, lane: 'main', force: false, json: false });
    // exit 0 or 1 (may have validator findings for reopened sprint without a shipped state)
    expect(r.exitCode).toBeLessThanOrEqual(1);
    expect(r.stdout).toContain('Added S-001 to queue main');
    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('queued');
  });

  it('assigns next slot id and order when queue already has slots', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002', 'S-003']) },
      {
        path: 'sprints/S-001.md',
        content: fm({ id: 'S-001', title: 'A', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({ id: 'S-002', title: 'B', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      {
        path: 'sprints/S-003.md',
        content: fm({ id: 'S-003', title: 'C', epic_id: 'E-001', status: 'planned', lane: 'main' }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          { id: 'Q-002', sprint_id: 'S-002', order: 1 },
        ]),
      },
    ]);

    const r = await runQueueAddCommand('S-003', { cwd, lane: 'main', force: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Q-003');

    const queueData = await readFm(join(cwd, 'queues/main.md'));
    const slots = queueData.slots as Array<{ id: string; sprint_id: string; order: number }>;
    expect(slots).toHaveLength(3);
    const newSlot = slots.find((s) => s.sprint_id === 'S-003');
    expect(newSlot?.id).toBe('Q-003');
    expect(newSlot?.order).toBe(2);
  });

  it('fails for pending sprint without --force', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'pending',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runQueueAddCommand('S-001', { cwd, lane: 'main', force: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('status pending');
    expect(r.stderr).toContain('--force');
  });

  it('allows pending with --force', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'pending',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runQueueAddCommand('S-001', { cwd, lane: 'main', force: true, json: false });
    // 0 or 1 (may have validator findings for pending status)
    expect(r.exitCode).toBeLessThanOrEqual(1);
    expect(r.stdout).toContain('Added S-001 to queue main');
  });

  it('hard-stops for shipped sprint', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          closed_at: '2026-04-25T12:00:00Z',
          end_sha: 'a1b2c3d',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'b2c3d4e',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runQueueAddCommand('S-001', { cwd, lane: 'main', force: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('cannot queue a sprint with status shipped');
  });

  it('fails when sprint already in the queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
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

    const r = await runQueueAddCommand('S-001', { cwd, lane: 'main', force: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('already in queue for lane');
  });
});
