import { afterAll, describe, expect, it } from 'vitest';
import { runInspectCommand } from '../src/commands/inspect.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface InspectJson {
  readonly schemaVersion: number;
  readonly entityType: 'sprint' | 'epic' | 'review' | 'queue' | 'lane';
  readonly entity: Record<string, unknown>;
  readonly derived?: Record<string, unknown>;
}

describe('runInspectCommand --json — derived links', () => {
  it('sprint: derived block resolves depends_on, review, and epic', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Epic A',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'first sprint',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-04-29T12:00:00Z',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'depends on S-001 with review',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          depends_on: ['S-001'],
          review_required: true,
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-002',
          verdict: 'pending',
          reviewer: 'someone',
          created_at: '2026-04-29T13:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runInspectCommand({ cwd, id: 'S-002', json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as InspectJson;
    expect(parsed.entityType).toBe('sprint');
    expect(parsed.derived, 'derived block missing on sprint inspect').toBeDefined();

    const derived = parsed.derived as {
      depends_on_resolved?: { id: string; status: string }[];
      review_resolved?: { id: string; verdict: string };
      epic_resolved?: { id: string; status: string };
    };
    expect(derived.depends_on_resolved).toEqual([{ id: 'S-001', status: 'shipped' }]);
    expect(derived.review_resolved).toEqual({ id: 'R-001', verdict: 'pending' });
    expect(derived.epic_resolved).toEqual({ id: 'E-001', status: 'active' });
  });

  it('epic: derived block summarises sprint progress', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-002.md',
        content: fm({
          id: 'E-002',
          title: 'Epic B',
          status: 'active',
          sprints: ['S-010', 'S-011', 'S-012'],
        }),
      },
      {
        path: 'sprints/S-010.md',
        content: fm({
          id: 'S-010',
          title: 's',
          epic_id: 'E-002',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-04-29T11:00:00Z',
        }),
      },
      {
        path: 'sprints/S-011.md',
        content: fm({
          id: 'S-011',
          title: 's',
          epic_id: 'E-002',
          status: 'active',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-012.md',
        content: fm({
          id: 'S-012',
          title: 's',
          epic_id: 'E-002',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runInspectCommand({ cwd, id: 'E-002', json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as InspectJson;
    expect(parsed.entityType).toBe('epic');

    const derived = parsed.derived as {
      sprints_progress?: {
        total: number;
        shipped: number;
        cancelled: number;
        in_flight: string[];
        remaining: string[];
      };
    };
    expect(derived.sprints_progress).toBeDefined();
    expect(derived.sprints_progress?.total).toBe(3);
    expect(derived.sprints_progress?.shipped).toBe(1);
    expect(derived.sprints_progress?.cancelled).toBe(0);
    expect(derived.sprints_progress?.in_flight).toEqual(['S-011']);
    expect(derived.sprints_progress?.remaining).toEqual(['S-012']);
  });

  it('review: derived block resolves linked sprint', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-003.md',
        content: fm({ id: 'E-003', title: 't', status: 'active', sprints: ['S-020'] }),
      },
      {
        path: 'sprints/S-020.md',
        content: fm({
          id: 'S-020',
          title: 's',
          epic_id: 'E-003',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-020',
        }),
      },
      {
        path: 'reviews/R-020.md',
        content: fm({
          id: 'R-020',
          sprint_id: 'S-020',
          verdict: 'changes_requested',
          reviewer: 'r',
          created_at: '2026-04-29T13:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runInspectCommand({ cwd, id: 'R-020', json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as InspectJson;
    expect(parsed.entityType).toBe('review');
    const derived = parsed.derived as {
      sprint_resolved?: { id: string; status: string; epic_id: string };
    };
    expect(derived.sprint_resolved).toEqual({
      id: 'S-020',
      status: 'review',
      epic_id: 'E-003',
    });
  });
});
