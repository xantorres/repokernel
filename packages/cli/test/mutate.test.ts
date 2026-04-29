import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mutateEpicFrontmatter, mutateSprintFrontmatter } from '../src/lifecycle/mutate.js';
import { cleanupAllFixtures, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

describe('mutateSprintFrontmatter — write-time enum guard', () => {
  it('rejects a non-enum sprint status before touching the file', async () => {
    const fixture = await makeFixture([
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'S-001',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    const file = join(fixture, 'sprints/S-001.md');
    const before = await readFile(file, 'utf8');

    await expect(mutateSprintFrontmatter(file, { status: 'pending-but-typoed' })).rejects.toThrow(
      /invalid sprint status/,
    );

    const after = await readFile(file, 'utf8');
    expect(after).toBe(before);
  });

  it('accepts a valid enum value (active)', async () => {
    const fixture = await makeFixture([
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'S-001',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    const file = join(fixture, 'sprints/S-001.md');
    await mutateSprintFrontmatter(file, { status: 'active' });
    const after = await readFile(file, 'utf8');
    expect(after).toMatch(/status: active/);
  });

  it('does not run the guard when status is absent from the patch', async () => {
    const fixture = await makeFixture([
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'S-001',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
    ]);
    const file = join(fixture, 'sprints/S-001.md');
    await mutateSprintFrontmatter(file, { started_at: '2026-04-29T10:00:00Z' });
    const after = await readFile(file, 'utf8');
    expect(after).toMatch(/started_at: '2026-04-29T10:00:00Z'/);
    expect(after).toMatch(/status: planned/);
  });
});

describe('mutateEpicFrontmatter — write-time enum guard', () => {
  it('rejects a non-enum epic status before touching the file', async () => {
    const fixture = await makeFixture([
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E-001', status: 'active', sprints: [] }),
      },
    ]);
    const file = join(fixture, 'epics/E-001.md');
    const before = await readFile(file, 'utf8');

    await expect(mutateEpicFrontmatter(file, { status: 'closed' })).rejects.toThrow(
      /invalid epic status/,
    );

    const after = await readFile(file, 'utf8');
    expect(after).toBe(before);
  });

  it('accepts a valid enum value (done)', async () => {
    const fixture = await makeFixture([
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'E-001', status: 'active', sprints: [] }),
      },
    ]);
    const file = join(fixture, 'epics/E-001.md');
    await mutateEpicFrontmatter(file, { status: 'done' });
    const after = await readFile(file, 'utf8');
    expect(after).toMatch(/status: done/);
  });
});
