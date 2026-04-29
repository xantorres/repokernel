import { afterAll, describe, expect, it } from 'vitest';
import { runBriefCommand } from '../src/commands/brief.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const NOW = '2026-04-29T12:00:00Z';

interface SprintOverride {
  readonly id?: string;
  readonly title?: string;
  readonly status?: string;
  readonly review_id?: string;
  readonly depends_on?: readonly string[];
  readonly blocked_by?: readonly string[];
  readonly gate?: string;
}

interface ReviewOverride {
  readonly id?: string;
  readonly verdict?: string;
  readonly findings?: ReadonlyArray<{ severity: string; message: string }>;
  readonly panel_runs?: ReadonlyArray<unknown>;
}

function sprintFm(o: SprintOverride = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: o.id ?? 'S-001',
    title: o.title ?? 'Demo sprint',
    epic_id: 'E-001',
    status: o.status ?? 'planned',
    lane: 'main',
    depends_on: o.depends_on ?? [],
    blocked_by: o.blocked_by ?? [],
  };
  if (o.review_id) base.review_id = o.review_id;
  if (o.gate) base.gate = o.gate;
  return base;
}

function reviewFm(o: ReviewOverride = {}): Record<string, unknown> {
  const r: Record<string, unknown> = {
    id: o.id ?? 'R-001',
    sprint_id: 'S-001',
    verdict: o.verdict ?? 'pending',
    reviewer: 'agent',
    findings: o.findings ?? [],
    created_at: NOW,
  };
  if (o.panel_runs) r.panel_runs = o.panel_runs;
  return r;
}

async function project(opts: {
  sprints?: readonly Record<string, unknown>[];
  reviews?: readonly Record<string, unknown>[];
  epicSprints?: readonly string[];
  epicStatus?: string;
}): Promise<string> {
  const sprints = opts.sprints ?? [sprintFm()];
  const reviews = opts.reviews ?? [];
  const epicSprints = opts.epicSprints ?? sprints.map((s) => s.id as string);
  const files = [
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'Demo epic',
        status: opts.epicStatus ?? 'active',
        sprints: epicSprints,
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ];
  for (const s of sprints) {
    files.push({ path: `sprints/${s.id as string}.md`, content: fm(s) });
  }
  for (const r of reviews) {
    files.push({ path: `reviews/${r.id as string}.md`, content: fm(r) });
  }
  return makeFixture(files);
}

describe('rk brief — sprint, gate auto-detect', () => {
  it('renders review-fail brief when latest review verdict is changes_requested', async () => {
    const cwd = await project({
      sprints: [sprintFm({ status: 'review', review_id: 'R-001' })],
      reviews: [
        reviewFm({
          verdict: 'changes_requested',
          findings: [
            { severity: 'HIGH', message: 'broken validation' },
            { severity: 'MEDIUM', message: 'missing test' },
          ],
          panel_runs: [
            {
              round: 1,
              aggregate: 'YELLOW',
              completed_at: NOW,
              reviewers: [
                { reviewer_id: 'security', verdict: 'YELLOW', findings: [], completed_at: NOW },
                { reviewer_id: 'style', verdict: 'GREEN', findings: [], completed_at: NOW },
              ],
            },
          ],
        }),
      ],
    });
    const r = await runBriefCommand('S-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('# Sprint S-001');
    expect(r.stdout).toContain('Review failed');
    expect(r.stdout).toContain('changes_requested');
    expect(r.stdout).toContain('broken validation');
    expect(r.stdout).toContain('Panel aggregate: **YELLOW**');
    expect(r.stdout).toContain('| security | YELLOW |');
    expect(r.stdout).toContain('## Suggested next action');
    expect(r.stdout).toContain('rk fix');
  });

  it('renders ready-to-close brief when latest review verdict is accepted', async () => {
    const cwd = await project({
      sprints: [sprintFm({ status: 'review', review_id: 'R-001' })],
      reviews: [reviewFm({ verdict: 'accepted' })],
    });
    const r = await runBriefCommand('S-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Ready to close');
    expect(r.stdout).toContain('rk close S-001');
  });

  it('renders pause brief when review exists but verdict is still pending', async () => {
    const cwd = await project({
      sprints: [sprintFm({ status: 'review', review_id: 'R-001' })],
      reviews: [reviewFm({ verdict: 'pending' })],
    });
    const r = await runBriefCommand('S-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Awaiting review verdict');
    expect(r.stdout).toContain('rk review-sprint S-001');
  });

  it('renders blocked brief when sprint has unshipped depends_on', async () => {
    const cwd = await project({
      sprints: [
        sprintFm({ id: 'S-001', status: 'shipped' }),
        sprintFm({ id: 'S-002', status: 'planned', depends_on: ['S-001', 'S-999'] }),
      ],
      epicSprints: ['S-001', 'S-002'],
    });
    const r = await runBriefCommand('S-002', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Blocked');
    expect(r.stdout).toContain('S-999');
  });

  it('renders status brief for a planned sprint with no blockers', async () => {
    const cwd = await project({
      sprints: [sprintFm({ status: 'planned' })],
    });
    const r = await runBriefCommand('S-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Sprint S-001');
    expect(r.stdout).toContain('Status:');
    expect(r.stdout).toContain('planned');
    expect(r.stdout).toContain('rk start S-001');
  });
});

describe('rk brief — explicit --gate forces template', () => {
  it('--gate=review-fail renders review-fail even when verdict is accepted', async () => {
    const cwd = await project({
      sprints: [sprintFm({ status: 'review', review_id: 'R-001' })],
      reviews: [reviewFm({ verdict: 'accepted' })],
    });
    const r = await runBriefCommand('S-001', { cwd, json: false, gate: 'review-fail' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Review failed');
  });

  it('rejects an unknown --gate with EXIT_USAGE', async () => {
    const cwd = await project({ sprints: [sprintFm()] });
    const r = await runBriefCommand('S-001', { cwd, json: false, gate: 'banana' });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('banana');
  });
});

describe('rk brief — epic mode', () => {
  it('renders an epic brief with sprint status table and next runnable', async () => {
    const cwd = await project({
      sprints: [
        sprintFm({ id: 'S-001', status: 'shipped' }),
        sprintFm({ id: 'S-002', status: 'planned' }),
        sprintFm({ id: 'S-003', status: 'planned' }),
      ],
      epicSprints: ['S-001', 'S-002', 'S-003'],
    });
    const r = await runBriefCommand('E-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('# Epic E-001');
    expect(r.stdout).toContain('| S-001 |');
    expect(r.stdout).toContain('| S-002 |');
    expect(r.stdout).toContain('| S-003 |');
    expect(r.stdout).toContain('shipped');
    expect(r.stdout).toContain('1 / 3'); // progress
    expect(r.stdout).toContain('## Suggested next action');
  });
});

describe('rk brief — JSON envelope', () => {
  it('emits structured JSON when --json is set', async () => {
    const cwd = await project({
      sprints: [sprintFm({ status: 'review', review_id: 'R-001' })],
      reviews: [
        reviewFm({
          verdict: 'changes_requested',
          findings: [{ severity: 'HIGH', message: 'broken' }],
        }),
      ],
    });
    const r = await runBriefCommand('S-001', { cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      kind: string;
      id: string;
      gate: string;
      next_action: string;
      markdown: string;
      review?: { verdict: string; findings_count: number };
    };
    expect(parsed.kind).toBe('sprint');
    expect(parsed.id).toBe('S-001');
    expect(parsed.gate).toBe('review-fail');
    expect(parsed.next_action).toContain('rk');
    expect(parsed.markdown).toContain('# Sprint S-001');
    expect(parsed.review?.verdict).toBe('changes_requested');
    expect(parsed.review?.findings_count).toBe(1);
  });
});

describe('rk brief — errors', () => {
  it('returns EXIT_BLOCKED when sprint id is not found', async () => {
    const cwd = await project({});
    const r = await runBriefCommand('S-999', { cwd, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('S-999');
  });

  it('returns EXIT_USAGE when id format is unrecognized', async () => {
    const cwd = await project({});
    const r = await runBriefCommand('XYZ-001', { cwd, json: false });
    expect(r.exitCode).toBe(64);
  });
});
