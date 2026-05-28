import { afterAll, describe, expect, it } from 'vitest';
import { runWaveParallelCommand } from '../src/commands/waveParallel.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

describe('rk wave plan --json diagnostics', () => {
  it('includes overlap matrix, hotspots, and predicted conflict pairs', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Parallel plan',
          status: 'active',
          sprints: ['S-001', 'S-002', 'S-003'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'web broad',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['apps/web/**'],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'web file',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['apps/web/page.tsx'],
        }),
      },
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 'server',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['apps/server/**'],
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

    const result = await runWaveParallelCommand({ cwd, json: true, maxPerLane: 6, maxTotal: 6 });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      diagnostics: {
        overlap_matrix: unknown[];
        hotspots: Array<{ path: string; sprint_ids: string[] }>;
        predicted_conflicts: Array<{ sprint_ids: string[]; path: string }>;
      };
    };
    expect(parsed.diagnostics.overlap_matrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ a: 'S-001', b: 'S-002', overlaps: true }),
        expect.objectContaining({ a: 'S-001', b: 'S-003', overlaps: false }),
      ]),
    );
    expect(parsed.diagnostics.hotspots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'apps/web', sprint_ids: ['S-001', 'S-002'] }),
      ]),
    );
    expect(parsed.diagnostics.predicted_conflicts).toEqual([
      { sprint_ids: ['S-001', 'S-002'], path: 'apps/web' },
    ]);
  });

  it('uses dot for repo-wide overlap instead of an empty hotspot path', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Wide overlap',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'wide',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: [],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'scoped',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          allowed_paths: ['src/**'],
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [
            { id: 'Q-001', sprint_id: 'S-001', order: 0 },
            { id: 'Q-002', sprint_id: 'S-002', order: 1 },
          ],
        }),
      },
    ]);

    const result = await runWaveParallelCommand({ cwd, json: true, maxPerLane: 6, maxTotal: 6 });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      diagnostics: {
        hotspots: Array<{ path: string; sprint_ids: string[] }>;
        predicted_conflicts: Array<{ sprint_ids: string[]; path: string }>;
      };
    };
    expect(parsed.diagnostics.hotspots).toContainEqual({
      path: '.',
      sprint_ids: ['S-001', 'S-002'],
    });
    expect(parsed.diagnostics.predicted_conflicts).toContainEqual({
      sprint_ids: ['S-001', 'S-002'],
      path: '.',
    });
  });
});
