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
  it('keeps default sprint inspect compact and prints the full body with --full', async () => {
    const longBody = `# S-030: contract

## Objective

This body marker should only appear in full inspect output, and it is long enough to prove the body is not being shortened.

## Notes

${'full-body-marker '.repeat(80)}
`;
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-030.md',
        content: fm({ id: 'E-030', title: 'Epic', status: 'active', sprints: ['S-030'] }),
      },
      {
        path: 'sprints/S-030.md',
        content: fm(
          {
            id: 'S-030',
            title: 'inspect full',
            epic_id: 'E-030',
            status: 'planned',
            lane: 'main',
          },
          longBody,
        ),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const compact = await runInspectCommand({ cwd, id: 'S-030' });
    const full = await runInspectCommand({ cwd, id: 'S-030', full: true });
    const json = await runInspectCommand({ cwd, id: 'S-030', json: true, full: true });

    expect(compact.exitCode).toBe(0);
    expect(compact.stdout).not.toContain('full-body-marker');
    expect(full.exitCode).toBe(0);
    expect(full.stdout).toContain('## Objective');
    expect(full.stdout).toContain('full-body-marker '.repeat(80).trim());
    expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: 1, entityType: 'sprint' });
  });

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

  it('epic: derived.sprints_progress partitions exactly like rk next active_epic_progress', async () => {
    // Active | review = in_flight; queued | planned | pending | reopened = remaining_ids;
    // shipped counts; cancelled drops out of both lists.
    // Same partition as buildActiveEpicProgress in commands/next.ts so a
    // consumer can swap surfaces without re-bucketing.
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-002.md',
        content: fm({
          id: 'E-002',
          title: 'Epic B',
          status: 'active',
          sprints: ['S-010', 'S-011', 'S-012', 'S-013', 'S-014'],
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
      {
        // queued sprint — must land in remaining_ids, not in_flight.
        path: 'sprints/S-013.md',
        content: fm({
          id: 'S-013',
          title: 'queued',
          epic_id: 'E-002',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        // cancelled sprint — must drop out of total-counted progress entirely.
        path: 'sprints/S-014.md',
        content: fm({
          id: 'S-014',
          title: 'cancelled',
          epic_id: 'E-002',
          status: 'cancelled',
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
        remaining_ids: string[];
      };
    };
    expect(derived.sprints_progress).toBeDefined();
    expect(derived.sprints_progress?.total).toBe(5);
    expect(derived.sprints_progress?.shipped).toBe(1);
    expect(derived.sprints_progress?.cancelled).toBe(1);
    expect(derived.sprints_progress?.in_flight).toEqual(['S-011']);
    expect(derived.sprints_progress?.remaining_ids).toEqual(['S-012', 'S-013']);
  });

  it('review: derived.sprint_resolved emits a missing sentinel when sprint is gone', async () => {
    // A review references S-021 but the sprint file is absent. We surface a
    // `missing` sentinel to mirror deriveSprint's review_resolved missing
    // sentinel pattern, so consumers don't need to special-case `null`.
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-004.md',
        content: fm({ id: 'E-004', title: 't', status: 'active', sprints: [] }),
      },
      {
        path: 'reviews/R-021.md',
        content: fm({
          id: 'R-021',
          sprint_id: 'S-021',
          verdict: 'pending',
          reviewer: 'r',
          created_at: '2026-04-29T13:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runInspectCommand({ cwd, id: 'R-021', json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as InspectJson;
    const derived = parsed.derived as {
      sprint_resolved?: { id: string; status: string; epic_id: string };
    };
    expect(derived.sprint_resolved).toEqual({
      id: 'S-021',
      status: 'missing',
      epic_id: '',
    });
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
