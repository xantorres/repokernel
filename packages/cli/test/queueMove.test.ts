import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runQueueMoveCommand } from '../src/commands/queue.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface Slot {
  id: string;
  sprint_id: string;
  order: number;
}

async function readFm(file: string): Promise<Record<string, unknown>> {
  return matter(await readFile(file, 'utf8')).data as Record<string, unknown>;
}

async function projectWith(
  status: string,
  opts: { mainSlots?: Slot[]; uiSlots?: Slot[] } = {},
): Promise<string> {
  const mainSlots = opts.mainSlots ?? [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }];
  const uiSlots = opts.uiSlots ?? [];
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({ id: 'S-001', title: 'Fix', epic_id: 'E-001', status, lane: 'main' }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: mainSlots }) },
    { path: 'queues/ui.md', content: fm({ lane: 'ui', slots: uiSlots }) },
  ]);
}

describe('runQueueMoveCommand', () => {
  it('moves a queued sprint to another lane, keeping status queued', async () => {
    const cwd = await projectWith('queued');
    const r = await runQueueMoveCommand('S-001', {
      cwd,
      from: 'main',
      to: 'ui',
      force: false,
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Moved S-001 from queue/main to queue/ui');
    expect(r.stdout).toContain('rk start S-001');

    const sprint = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(sprint.lane).toBe('ui');
    expect(sprint.status).toBe('queued');

    const mainSlots = (await readFm(join(cwd, 'queues/main.md'))).slots as Slot[];
    const uiSlots = (await readFm(join(cwd, 'queues/ui.md'))).slots as Slot[];
    expect(mainSlots.some((s) => s.sprint_id === 'S-001')).toBe(false);
    expect(uiSlots.some((s) => s.sprint_id === 'S-001')).toBe(true);
  });

  it('emits JSON with a suggested next command', async () => {
    const cwd = await projectWith('queued');
    const r = await runQueueMoveCommand('S-001', {
      cwd,
      from: 'main',
      to: 'ui',
      force: false,
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      moved: boolean;
      from: string;
      to: string;
      status: string;
      next: string;
    };
    expect(obj).toMatchObject({ moved: true, from: 'main', to: 'ui', status: 'queued' });
    expect(obj.next).toBe('rk start S-001');
  });

  it('rejects a move to the same lane', async () => {
    const cwd = await projectWith('queued');
    const r = await runQueueMoveCommand('S-001', {
      cwd,
      from: 'main',
      to: 'main',
      force: false,
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('nothing to move');
  });

  it('rejects when the sprint is not in the source queue', async () => {
    const cwd = await projectWith('queued', { mainSlots: [] });
    const r = await runQueueMoveCommand('S-001', {
      cwd,
      from: 'main',
      to: 'ui',
      force: false,
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not in queue/main');
  });

  it('rejects when the target lane has no queue file', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Fix',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    const r = await runQueueMoveCommand('S-001', {
      cwd,
      from: 'main',
      to: 'ui',
      force: false,
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('no queue file found for lane "ui"');
  });

  it('refuses to move an active sprint', async () => {
    const cwd = await projectWith('active');
    const r = await runQueueMoveCommand('S-001', {
      cwd,
      from: 'main',
      to: 'ui',
      force: false,
      json: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('cannot move a sprint with status active');
  });
});
