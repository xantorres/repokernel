import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runQueueAddCommand, runQueueRemoveCommand } from '../src/commands/queue.js';
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

describe('runQueueRemoveCommand', () => {
  it('removes queued sprint from queue and transitions status to planned', async () => {
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

    const r = await runQueueRemoveCommand('S-001', { cwd, lane: 'main', json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Removed S-001 from queue/main');
    expect(r.stdout).toContain('queued → planned');

    const sprintData = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(sprintData.status).toBe('planned');

    const queueData = await readFm(join(cwd, 'queues/main.md'));
    const slots = queueData.slots as Array<{ sprint_id: string }>;
    expect(slots).toHaveLength(0);
  });

  it('re-orders remaining slots after removal', async () => {
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
        content: fm({ id: 'S-003', title: 'C', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          { id: 'Q-002', sprint_id: 'S-002', order: 1 },
          { id: 'Q-003', sprint_id: 'S-003', order: 2 },
        ]),
      },
    ]);

    const r = await runQueueRemoveCommand('S-002', { cwd, lane: 'main', json: false });
    expect(r.exitCode).toBe(0);

    const queueData = await readFm(join(cwd, 'queues/main.md'));
    const slots = queueData.slots as Array<{ sprint_id: string; order: number }>;
    expect(slots).toHaveLength(2);
    expect(slots.find((s) => s.sprint_id === 'S-002')).toBeUndefined();
    expect(slots.map((s) => s.order)).toEqual([0, 1]);
  });

  it('fails when sprint not in queue', async () => {
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

    const r = await runQueueRemoveCommand('S-001', { cwd, lane: 'main', json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not in queue/main');
    expect(r.stderr).toContain('rk queue add');
  });

  it('emits JSON with removed:true and newStatus', async () => {
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

    const r = await runQueueRemoveCommand('S-001', { cwd, lane: 'main', json: true });
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(payload.id).toBe('S-001');
    expect(payload.lane).toBe('main');
    expect(payload.removed).toBe(true);
    expect(payload.newStatus).toBe('planned');
    expect(payload.slot).toBe('Q-001');
  });
});

describe('appendSlotToQueue (atomic + locked)', () => {
  it('reload + slot computation happen inside the lane lock — concurrent appends never duplicate Q-NNN', async () => {
    const { mkdir, writeFile, readFile: rf } = await import('node:fs/promises');
    const { join: pj } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { mkdtemp } = await import('node:fs/promises');
    const matterMod = (await import('gray-matter')).default;
    const { appendSlotToQueue } = await import('../src/commands/queue.js');

    const cwd = await mkdtemp(pj(tmpdir(), 'rk-queue-race-'));
    const queueFile = pj(cwd, 'main.md');
    const opRoot = pj(cwd, '.op');
    await mkdir(opRoot, { recursive: true });
    await writeFile(
      queueFile,
      matterMod.stringify('# main queue\n', { lane: 'main', slots: [] }),
      'utf8',
    );

    // Two concurrent appends for distinct sprints. Without a lane lock,
    // both would observe slots.length === 0 and both would compute Q-001.
    // With the lock, the second writer sees the first's slot and assigns
    // Q-002.
    const [r1, r2] = await Promise.all([
      appendSlotToQueue(queueFile, 'S-001', opRoot, 'main'),
      appendSlotToQueue(queueFile, 'S-002', opRoot, 'main'),
    ]);
    expect(r1.kind).toBe('added');
    expect(r2.kind).toBe('added');
    if (r1.kind === 'added' && r2.kind === 'added') {
      const ids = new Set([r1.slot.id, r2.slot.id]);
      expect(ids.size).toBe(2);
      expect([...ids].every((id) => /^Q-\d{3}$/.test(id))).toBe(true);
      expect(r1.slot.order).not.toBe(r2.slot.order);
    }

    const persisted = matterMod(await rf(queueFile, 'utf8')).data as {
      slots: Array<{ id: string; sprint_id: string; order: number }>;
    };
    expect(persisted.slots).toHaveLength(2);
    const slotIds = new Set(persisted.slots.map((s) => s.id));
    expect(slotIds.size).toBe(2);
  });

  it('returns kind=already and preserves the existing queue when sprint already enqueued', async () => {
    const { mkdir, writeFile, readFile: rf } = await import('node:fs/promises');
    const { join: pj } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { mkdtemp } = await import('node:fs/promises');
    const matterMod = (await import('gray-matter')).default;
    const { appendSlotToQueue } = await import('../src/commands/queue.js');

    const cwd = await mkdtemp(pj(tmpdir(), 'rk-queue-already-'));
    const queueFile = pj(cwd, 'main.md');
    const opRoot = pj(cwd, '.op');
    await mkdir(opRoot, { recursive: true });
    await writeFile(
      queueFile,
      matterMod.stringify('# main queue\n', {
        lane: 'main',
        slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
      }),
      'utf8',
    );
    const before = await rf(queueFile, 'utf8');

    const r = await appendSlotToQueue(queueFile, 'S-001', opRoot, 'main');
    expect(r.kind).toBe('already');
    if (r.kind === 'already') {
      expect(r.existing.id).toBe('Q-001');
    }

    // Queue file content untouched on the no-op path.
    const after = await rf(queueFile, 'utf8');
    expect(after).toBe(before);
  });
});
