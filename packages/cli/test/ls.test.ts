import { afterAll, describe, expect, it } from 'vitest';
import {
  runLsEpicsCommand,
  runLsLanesCommand,
  runLsReviewsCommand,
  runLsSprintsCommand,
} from '../src/commands/ls.js';
import { stripAnsi } from '../src/format/table.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function baseFixture() {
  return [
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'Core Validator',
        status: 'active',
        sprints: ['S-001', 'S-002'],
      }),
    },
    {
      path: 'epics/E-002.md',
      content: fm({
        id: 'E-002',
        title: 'Queue Importer',
        status: 'planned',
        sprints: ['S-003'],
      }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Config loader',
        status: 'shipped',
        epic_id: 'E-001',
        lane: 'main',
        depends_on: [],
      }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({
        id: 'S-002',
        title: 'Parse sprints',
        status: 'active',
        epic_id: 'E-001',
        lane: 'main',
        depends_on: ['S-001'],
      }),
    },
    {
      path: 'sprints/S-003.md',
      content: fm({
        id: 'S-003',
        title: 'Import queue data',
        status: 'queued',
        epic_id: 'E-002',
        lane: 'infra',
        depends_on: [],
      }),
    },
    {
      path: 'reviews/R-001.md',
      content: fm({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'accepted',
        reviewer: 'alice',
        created_at: '2024-01-01T00:00:00Z',
        findings: [],
      }),
    },
    {
      path: 'reviews/R-002.md',
      content: fm({
        id: 'R-002',
        sprint_id: 'S-002',
        verdict: 'pending',
        reviewer: 'agent',
        created_at: '2024-01-02T00:00:00Z',
        findings: [],
      }),
    },
    { path: 'lanes/main.md', content: fm({ name: 'main', claimed_by: 'alice' }) },
    { path: 'lanes/infra.md', content: fm({ name: 'infra' }) },
    {
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-002', order: 0 }] }),
    },
    {
      path: 'queues/infra.md',
      content: fm({ lane: 'infra', slots: [{ id: 'Q-001', sprint_id: 'S-003', order: 0 }] }),
    },
  ];
}

// — rk ls epics —

describe('runLsEpicsCommand', () => {
  it('lists all epics with progress', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('E-001');
    expect(out).toContain('Core Validator');
    expect(out).toContain('E-002');
    expect(out).toContain('Queue Importer');
  });

  it('filters by status', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, status: 'active', json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('E-001');
    expect(out).not.toContain('E-002');
  });

  it('shows empty state gracefully', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runLsEpicsCommand({ cwd, status: 'done', json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(no epics)');
  });

  it('emits JSON with sprintCounts', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, json: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('epics');
    expect(Array.isArray(data.epics)).toBe(true);
    const e1 = data.epics.find((e: { id: string }) => e.id === 'E-001');
    expect(e1).toBeDefined();
    expect(e1.sprintCounts).toHaveProperty('shipped');
  });

  it('shows progress bar in text output', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsEpicsCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    // E-001 has 1 shipped out of 2
    expect(out).toContain('1/2');
  });

  describe('--unshipped flag', () => {
    function mixedStatusFixture() {
      return [
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
        {
          path: 'epics/E-100.md',
          content: fm({ id: 'E-100', title: 'Active', status: 'active', sprints: [] }),
        },
        {
          path: 'epics/E-101.md',
          content: fm({ id: 'E-101', title: 'Planned', status: 'planned', sprints: [] }),
        },
        {
          path: 'epics/E-102.md',
          content: fm({ id: 'E-102', title: 'OnHold', status: 'on_hold', sprints: [] }),
        },
        {
          path: 'epics/E-103.md',
          content: fm({ id: 'E-103', title: 'Done', status: 'done', sprints: [] }),
        },
        {
          path: 'epics/E-104.md',
          content: fm({ id: 'E-104', title: 'Cancelled', status: 'cancelled', sprints: [] }),
        },
      ];
    }

    it('returns only epics with status not in {done, cancelled}', async () => {
      const cwd = await makeFixture(mixedStatusFixture());
      const result = await runLsEpicsCommand({ cwd, unshipped: true, json: true });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout) as { epics: { id: string; status: string }[] };
      const ids = data.epics.map((e) => e.id).sort();
      expect(ids).toEqual(['E-100', 'E-101', 'E-102']);
      expect(data.epics.every((e) => e.status !== 'done' && e.status !== 'cancelled')).toBe(true);
    });

    it('returns mutual exclusion error when used with --status', async () => {
      const cwd = await makeFixture(mixedStatusFixture());
      const result = await runLsEpicsCommand({
        cwd,
        unshipped: true,
        status: 'active',
        json: false,
      });
      expect(result.exitCode).toBe(64); // EXIT_USAGE — sysexits convention
      expect(result.stderr).toMatch(/mutually exclusive/);
    });

    it('text output excludes done epics under --unshipped', async () => {
      const cwd = await makeFixture(mixedStatusFixture());
      const result = await runLsEpicsCommand({ cwd, unshipped: true, json: false });
      expect(result.exitCode).toBe(0);
      const out = stripAnsi(result.stdout);
      expect(out).toContain('E-100');
      expect(out).toContain('E-101');
      expect(out).toContain('E-102');
      expect(out).not.toContain('E-103');
      expect(out).not.toContain('E-104');
    });

    it('returns exit 0 + empty epic list when only terminal epics exist', async () => {
      const cwd = await makeFixture([
        { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
        {
          path: 'epics/E-200.md',
          content: fm({ id: 'E-200', title: 'Done', status: 'done', sprints: [] }),
        },
        {
          path: 'epics/E-201.md',
          content: fm({ id: 'E-201', title: 'Cancelled', status: 'cancelled', sprints: [] }),
        },
      ]);
      const result = await runLsEpicsCommand({ cwd, unshipped: true, json: true });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout) as { epics: { id: string }[] };
      expect(data.epics).toEqual([]);
    });
  });
});

// — rk ls sprints —

describe('runLsSprintsCommand', () => {
  it('lists all sprints', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, withDeps: false, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-001');
    expect(out).toContain('S-002');
    expect(out).toContain('S-003');
  });

  it('filters by epic', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, epic: 'E-001', withDeps: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-001');
    expect(out).toContain('S-002');
    expect(out).not.toContain('S-003');
  });

  it('filters by status', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({
      cwd,
      status: 'active',
      withDeps: false,
      json: false,
    });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-002');
    expect(out).not.toContain('S-001');
    expect(out).not.toContain('S-003');
  });

  it('filters by lane', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, lane: 'infra', withDeps: false, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('S-003');
    expect(out).not.toContain('S-001');
  });

  it('shows deps column when --with-deps', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, withDeps: true, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('DEPS');
    expect(out).toContain('S-001'); // S-002 depends on S-001
  });

  it('emits JSON with sprint array', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({ cwd, withDeps: false, json: true });
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('sprints');
    expect(data.sprints.length).toBe(3);
  });

  it('combines epic + lane filters', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsSprintsCommand({
      cwd,
      epic: 'E-001',
      lane: 'infra',
      withDeps: false,
      json: false,
    });
    // E-001 sprints are on 'main', not 'infra'
    expect(result.stdout).toContain('(no sprints)');
  });
});

// — rk ls reviews —

describe('runLsReviewsCommand', () => {
  it('lists all reviews', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('R-001');
    expect(out).toContain('R-002');
  });

  it('filters by verdict', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, verdict: 'pending', json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('R-002');
    expect(out).not.toContain('R-001');
  });

  it('filters by sprint', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, sprint: 'S-001', json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('R-001');
    expect(out).not.toContain('R-002');
  });

  it('emits JSON with findings_count', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, json: true });
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('reviews');
    expect(data.reviews[0]).toHaveProperty('findings_count');
  });

  it('shows empty state when no reviews match filter', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsReviewsCommand({ cwd, verdict: 'rejected', json: false });
    expect(result.stdout).toContain('(no reviews)');
  });
});

// — rk ls lanes —

describe('runLsLanesCommand', () => {
  it('lists all lanes', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('main');
    expect(out).toContain('infra');
  });

  it('shows claimed status for lane with claimed_by', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    expect(out).toContain('alice');
    expect(out).toContain('claimed');
  });

  it('shows free status for unclaimed lane', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: false });
    const out = stripAnsi(result.stdout);
    // infra lane has no claimed_by
    expect(out).toContain('free');
  });

  it('emits JSON with lane array', async () => {
    const cwd = await makeFixture(baseFixture());
    const result = await runLsLanesCommand({ cwd, json: true });
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('lanes');
    expect(data.lanes.length).toBe(2);
    const main = data.lanes.find((l: { name: string }) => l.name === 'main');
    expect(main.claimed_by).toBe('alice');
    expect(main.queueDepth).toBe(1);
  });

  it('shows empty state when no lanes exist', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);
    const result = await runLsLanesCommand({ cwd, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(no lanes)');
  });
});

describe('runLsEpicsCommand --json — shape', () => {
  it('emits a fully-keyed sprintCounts object plus total / progressPercent / sprints[]', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-010.md',
        content: fm({
          id: 'E-010',
          title: 'Mixed-status epic',
          status: 'active',
          sprints: ['S-100', 'S-101', 'S-102', 'S-103'],
        }),
      },
      {
        path: 'sprints/S-100.md',
        content: fm({
          id: 'S-100',
          title: 's',
          epic_id: 'E-010',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-04-29T10:00:00Z',
        }),
      },
      {
        path: 'sprints/S-101.md',
        content: fm({
          id: 'S-101',
          title: 's',
          epic_id: 'E-010',
          status: 'shipped',
          lane: 'main',
          base_sha: 'c'.repeat(40),
          end_sha: 'd'.repeat(40),
          closed_at: '2026-04-29T11:00:00Z',
        }),
      },
      {
        path: 'sprints/S-102.md',
        content: fm({ id: 'S-102', title: 's', epic_id: 'E-010', status: 'active', lane: 'main' }),
      },
      {
        path: 'sprints/S-103.md',
        content: fm({ id: 'S-103', title: 's', epic_id: 'E-010', status: 'planned', lane: 'main' }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    const result = await runLsEpicsCommand({ cwd, json: true });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as {
      epics: {
        id: string;
        sprintCounts: Record<string, number>;
        total: number;
        progressPercent: number;
        sprints: string[];
      }[];
    };
    expect(data.epics).toHaveLength(1);
    const epic = data.epics[0]!;

    // All 8 SprintStatus keys must be present (zero-filled).
    const expectedKeys = [
      'planned',
      'pending',
      'queued',
      'active',
      'review',
      'shipped',
      'reopened',
      'cancelled',
    ];
    for (const key of expectedKeys) {
      expect(epic.sprintCounts, `sprintCounts.${key} missing`).toHaveProperty(key);
      expect(typeof epic.sprintCounts[key]).toBe('number');
    }
    expect(epic.sprintCounts.shipped).toBe(2);
    expect(epic.sprintCounts.active).toBe(1);
    expect(epic.sprintCounts.planned).toBe(1);
    expect(epic.sprintCounts.cancelled).toBe(0); // dense fill, not undefined

    // New top-level convenience fields.
    expect(epic.total).toBe(4);
    expect(epic.progressPercent).toBe(50); // 2 shipped / 4 total
    expect(epic.sprints).toEqual(['S-100', 'S-101', 'S-102', 'S-103']);
  });
});

describe('runLsSprintsCommand --last N', () => {
  function lastFixture() {
    return [
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'E',
          status: 'active',
          sprints: ['S-001', 'S-002', 'S-003', 'S-004'],
        }),
      },
      // S-001: shipped earliest
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'oldest',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'a'.repeat(40),
          end_sha: 'b'.repeat(40),
          closed_at: '2026-04-25T10:00:00Z',
        }),
      },
      // S-002: shipped middle
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'middle',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'c'.repeat(40),
          end_sha: 'd'.repeat(40),
          closed_at: '2026-04-27T14:00:00Z',
        }),
      },
      // S-003: shipped most recent
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 'newest',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'e'.repeat(40),
          end_sha: 'f'.repeat(40),
          closed_at: '2026-04-29T18:00:00Z',
        }),
      },
      // S-004: in-flight (started but not closed) — older started_at
      {
        path: 'sprints/S-004.md',
        content: fm({
          id: 'S-004',
          title: 'in-flight',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-28T09:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ];
  }

  it('returns the N most recent sprints by activity timestamp (closed_at | started_at)', async () => {
    // Activity ordering — most-recent timestamp wins regardless of kind.
    // Apr 29 (S-003 closed) > Apr 28 (S-004 started) > Apr 27 (S-002 closed).
    const cwd = await makeFixture(lastFixture());
    const result = await runLsSprintsCommand({
      cwd,
      withDeps: false,
      json: true,
      last: 3,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as {
      sprints: { id: string; closed_at: string | null; started_at: string | null }[];
    };
    expect(data.sprints.map((s) => s.id)).toEqual(['S-003', 'S-004', 'S-002']);
  });

  it('combines with --epic to filter then take last N', async () => {
    const cwd = await makeFixture(lastFixture());
    const result = await runLsSprintsCommand({
      cwd,
      withDeps: false,
      json: true,
      epic: 'E-001',
      last: 2,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as { sprints: { id: string }[] };
    expect(data.sprints.map((s) => s.id)).toEqual(['S-003', 'S-004']);
  });

  it('rejects --last 0 with a usage error', async () => {
    const cwd = await makeFixture(lastFixture());
    const result = await runLsSprintsCommand({
      cwd,
      withDeps: false,
      json: true,
      last: 0,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--last');
  });
});
