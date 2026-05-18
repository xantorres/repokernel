import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCloseTaskCommand } from '../src/commands/fastpath/closeTask.js';
import type { TaskAlias } from '../src/commands/fastpath/types.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function alias(overrides: Partial<TaskAlias> = {}): TaskAlias {
  return {
    id: 'T-001',
    epic_id: 'E-001',
    sprint_id: 'S-001',
    source: 'inline',
    title: 'Stale alias task',
    created_at: '2026-04-29T00:00:00.000Z',
    closed_at: null,
    status: 'active',
    ...overrides,
  } as TaskAlias;
}

describe('fastpath alias reconciliation', () => {
  it('rk close T-NNN reconciles an active alias whose linked sprint already shipped', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Synthetic fastpath epic',
          status: 'done',
          sprints: ['S-001'],
          closed_at: '2026-04-29T12:30:00.000Z',
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Synthetic fastpath sprint',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          review_required: false,
          closed_at: '2026-04-29T12:00:00.000Z',
          end_sha: 'b'.repeat(40),
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
      {
        path: '.repokernel/tasks/T-001.json',
        content: `${JSON.stringify(alias({ status: 'active' }), null, 2)}\n`,
      },
    ]);

    const result = await runCloseTaskCommand({ cwd, taskId: 'T-001' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Closed T-001');
    expect(result.stdout).toContain('reconciled');

    const updated = JSON.parse(
      await readFile(join(cwd, '.repokernel/tasks/T-001.json'), 'utf8'),
    ) as TaskAlias;
    expect(updated.status).toBe('shipped');
    expect(updated.closed_at).toBe('2026-04-29T12:00:00.000Z');
  });
});
