import { afterAll, describe, expect, it } from 'vitest';
import { validateProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface FileSpec {
  path: string;
  content: string;
}

async function setup(files: FileSpec[], configYaml = defaultConfigYaml()) {
  const fixture = await makeFixture([
    { path: 'repokernel.config.yaml', content: configYaml },
    ...files,
  ]);
  return validateProject({ cwd: fixture.cwd });
}

const validEpic = (id: string, sprints: string[]) =>
  fm({ id, title: id, status: 'active', sprints });

const validSprint = (
  id: string,
  epic: string,
  status: string = 'planned',
  extra: Record<string, unknown> = {},
) =>
  fm({
    id,
    title: id,
    epic_id: epic,
    status,
    lane: 'main',
    ...extra,
  });

const validReview = (id: string, sprint: string, verdict = 'accepted') =>
  fm({
    id,
    sprint_id: sprint,
    verdict,
    reviewer: 'someone',
    created_at: '2026-04-25T10:00:00Z',
  });

describe('validator: minimal valid project', () => {
  it('returns no findings when everything aligns', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned'),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    expect(r.findings).toEqual([]);
  });
});

describe('validator: duplicate ids', () => {
  it('flags duplicate sprint ids as P0', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001'),
      },
      {
        path: 'sprints/S-001-other.md',
        content: validSprint('S-001', 'E-001'),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'DUPLICATE_SPRINT_ID' && f.severity === 'P0')).toBe(
      true,
    );
  });
});

describe('validator: queue references missing sprint', () => {
  it('emits P1', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', []) },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-999', order: 0 }],
        }),
      },
    ]);
    expect(
      r.findings.some((f) => f.code === 'QUEUE_REFERENCES_MISSING_SPRINT' && f.severity === 'P1'),
    ).toBe(true);
  });

  it('flags queue slots whose sprint belongs to a different lane', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'queued', { lane: 'main' }),
      },
      {
        path: 'queues/platform.md',
        content: fm({
          lane: 'platform',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'QUEUE_SLOT_LANE_MISMATCH')).toBe(true);
  });
});

describe('validator: epic references missing sprint', () => {
  it('emits P1', async () => {
    const r = await setup([{ path: 'epics/E-001.md', content: validEpic('E-001', ['S-999']) }]);
    expect(r.findings.some((f) => f.code === 'EPIC_REFERENCES_MISSING_SPRINT')).toBe(true);
  });
});

describe('validator: dependency references missing sprint', () => {
  it('emits P1', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned', { depends_on: ['S-999'] }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'DEPENDENCY_REFERENCES_MISSING_SPRINT')).toBe(true);
  });
});

describe('validator: dependency cycle', () => {
  it('emits P1', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned', { depends_on: ['S-002'] }),
      },
      {
        path: 'sprints/S-002.md',
        content: validSprint('S-002', 'E-001', 'planned', { depends_on: ['S-001'] }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'DEPENDENCY_CYCLE')).toBe(true);
  });
});

describe('validator: queued dependency not shipped', () => {
  it('emits P1', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned'),
      },
      {
        path: 'sprints/S-002.md',
        content: validSprint('S-002', 'E-001', 'queued', { depends_on: ['S-001'] }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-002', sprint_id: 'S-002', order: 0 }],
        }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'QUEUED_DEPENDENCY_NOT_SHIPPED')).toBe(true);
  });
});

describe('validator: pending in queue', () => {
  it('emits PENDING_SPRINT_IN_QUEUE_AS_RUNNABLE P1', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'pending'),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'PENDING_SPRINT_IN_QUEUE_AS_RUNNABLE')).toBe(true);
  });
});

describe('validator: active sprint missing fields', () => {
  it('emits ACTIVE_SPRINT_MISSING_BASE_SHA and STARTED_AT', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      { path: 'sprints/S-001.md', content: validSprint('S-001', 'E-001', 'active') },
    ]);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain('ACTIVE_SPRINT_MISSING_STARTED_AT');
    expect(codes).toContain('ACTIVE_SPRINT_MISSING_BASE_SHA');
  });

  it('does not emit when both fields present', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'active', {
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    expect(
      r.findings.filter((f) =>
        ['ACTIVE_SPRINT_MISSING_STARTED_AT', 'ACTIVE_SPRINT_MISSING_BASE_SHA'].includes(f.code),
      ),
    ).toEqual([]);
  });
});

describe('validator: sprint policy', () => {
  it('flags statuses disallowed by project policy', async () => {
    const r = await setup(
      [
        { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
        {
          path: 'sprints/S-001.md',
          content: validSprint('S-001', 'E-001', 'queued'),
        },
      ],
      `${defaultConfigYaml()}policies:
  allowedStatuses:
    - planned
`,
    );
    expect(r.findings.some((f) => f.code === 'SPRINT_STATUS_NOT_ALLOWED')).toBe(true);
  });

  it('flags multiple active sprints in one lane by default', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'active', {
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: validSprint('S-002', 'E-001', 'active', {
          started_at: '2026-04-25T11:00:00Z',
          base_sha: 'b2c3d4e',
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
    expect(r.findings.some((f) => f.code === 'MULTIPLE_ACTIVE_SPRINTS_IN_LANE')).toBe(true);
  });
});

describe('validator: shipped sprint missing fields', () => {
  it('emits closed_at, end_sha, review missing', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      { path: 'sprints/S-001.md', content: validSprint('S-001', 'E-001', 'shipped') },
    ]);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain('SHIPPED_SPRINT_MISSING_CLOSED_AT');
    expect(codes).toContain('SHIPPED_SPRINT_MISSING_END_SHA');
    expect(codes).toContain('SHIPPED_SPRINT_MISSING_REVIEW');
  });

  it('passes when shipped with accepted review and SHA', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'shipped', {
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T15:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
          review_id: 'R-001',
        }),
      },
      { path: 'reviews/R-001.md', content: validReview('R-001', 'S-001') },
    ]);
    expect(r.findings).toEqual([]);
  });
});

describe('validator: review references missing sprint', () => {
  it('emits P1', async () => {
    const r = await setup([{ path: 'reviews/R-001.md', content: validReview('R-001', 'S-999') }]);
    expect(r.findings.some((f) => f.code === 'REVIEW_REFERENCES_MISSING_SPRINT')).toBe(true);
  });
});

describe('validator: sprint without epic', () => {
  it('emits P1 when epic_id has no matching epic', async () => {
    const r = await setup([
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-999'),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'SPRINT_WITHOUT_EPIC')).toBe(true);
  });
});

describe('validator: sprint in multiple epics', () => {
  it('emits P1', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      { path: 'epics/E-002.md', content: validEpic('E-002', ['S-001']) },
      { path: 'sprints/S-001.md', content: validSprint('S-001', 'E-001') },
    ]);
    expect(r.findings.some((f) => f.code === 'SPRINT_IN_MULTIPLE_EPICS')).toBe(true);
  });
});

describe('validator: shipped/cancelled in queue', () => {
  it('flags shipped P2', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'shipped', {
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T15:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
        }),
      },
      { path: 'reviews/R-001.md', content: validReview('R-001', 'S-001') },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'SHIPPED_SPRINT_IN_QUEUE')).toBe(true);
  });
});

describe('validator: active not in queue', () => {
  it('flags P2', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'active', {
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'ACTIVE_SPRINT_NOT_IN_QUEUE')).toBe(true);
  });
});

describe('validator: queue duplicates', () => {
  it('flags duplicate order, slot id, and sprint', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: validSprint('S-001', 'E-001') },
      { path: 'sprints/S-002.md', content: validSprint('S-002', 'E-001') },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [
            { id: 'Q-001', sprint_id: 'S-001', order: 0 },
            { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          ],
        }),
      },
    ]);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain('DUPLICATE_QUEUE_ORDER');
    expect(codes).toContain('DUPLICATE_QUEUE_SLOT_ID');
    expect(codes).toContain('DUPLICATE_QUEUE_SPRINT');
  });
});

describe('validator: invalid config', () => {
  it('returns synthetic CONFIG_INVALID and skips other rules', async () => {
    const r = await setup([], 'schemaVersion: 1\nprojectId: demo\n');
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings[0]?.code).toBe('CONFIG_INVALID');
    expect(r.findings[0]?.severity).toBe('P0');
    expect(r.project).toBeNull();
  });
});

describe('validator: blocked_by references missing sprint', () => {
  it('emits P1 when blocked_by lists a non-existent sprint', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned', { blocked_by: ['S-999'] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    expect(
      r.findings.some(
        (f) => f.code === 'BLOCKED_BY_REFERENCES_MISSING_SPRINT' && f.severity === 'P1',
      ),
    ).toBe(true);
  });

  it('no finding when blocked_by references an existing sprint', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned', { blocked_by: ['S-002'] }),
      },
      { path: 'sprints/S-002.md', content: validSprint('S-002', 'E-001', 'planned') },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    expect(r.findings.some((f) => f.code === 'BLOCKED_BY_REFERENCES_MISSING_SPRINT')).toBe(false);
  });
});

describe('validator: blocked_by cycle', () => {
  it('emits P2 when two sprints block each other', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned', { blocked_by: ['S-002'] }),
      },
      {
        path: 'sprints/S-002.md',
        content: validSprint('S-002', 'E-001', 'planned', { blocked_by: ['S-001'] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    expect(
      r.findings.some((f) => f.code === 'BLOCKED_BY_CYCLE' && f.severity === 'P2'),
    ).toBe(true);
  });

  it('emits P2 for self-blocking sprint', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned', { blocked_by: ['S-001'] }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    expect(r.findings.some((f) => f.code === 'BLOCKED_BY_CYCLE' && f.severity === 'P2')).toBe(
      true,
    );
  });

  it('no cycle finding for linear blocked_by chain', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001', 'S-002', 'S-003']) },
      {
        path: 'sprints/S-001.md',
        content: validSprint('S-001', 'E-001', 'planned', { blocked_by: ['S-002'] }),
      },
      {
        path: 'sprints/S-002.md',
        content: validSprint('S-002', 'E-001', 'planned', { blocked_by: ['S-003'] }),
      },
      { path: 'sprints/S-003.md', content: validSprint('S-003', 'E-001', 'planned') },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    expect(r.findings.some((f) => f.code === 'BLOCKED_BY_CYCLE')).toBe(false);
  });
});

describe('validator: deterministic ordering', () => {
  it('sorts P0 before P1 before P2 before P3', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: validEpic('E-001', ['S-001']) },
      { path: 'sprints/S-001.md', content: validSprint('S-001', 'E-001') },
      { path: 'sprints/S-001-dup.md', content: validSprint('S-001', 'E-001') },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-999', order: 0 }],
        }),
      },
    ]);
    const sevs = r.findings.map((f) => f.severity);
    const sorted = [...sevs].sort();
    expect(sevs).toEqual(sorted);
  });
});
