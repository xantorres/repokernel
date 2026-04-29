import { afterAll, describe, expect, it } from 'vitest';
import { runReviewAggregateCommand } from '../src/commands/reviewAggregateCmd.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

const NOW = '2026-04-29T12:00:00Z';

function reviewerRun(reviewerId: string, verdict: 'GREEN' | 'YELLOW' | 'RED') {
  return {
    reviewer_id: reviewerId,
    verdict,
    findings: [],
    completed_at: NOW,
  };
}

function panelRun(round: number, aggregate: 'GREEN' | 'YELLOW' | 'RED', reviewers: object[]) {
  return {
    round,
    aggregate,
    completed_at: NOW,
    reviewers,
  };
}

async function projectWithReview(panelRuns?: object[]): Promise<string> {
  const reviewFm: Record<string, unknown> = {
    id: 'R-001',
    sprint_id: 'S-001',
    verdict: 'pending',
    reviewer: 'agent',
    findings: [],
    created_at: NOW,
  };
  if (panelRuns !== undefined) {
    reviewFm.panel_runs = panelRuns;
  }
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'demo', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'demo sprint',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        review_id: 'R-001',
      }),
    },
    { path: 'reviews/R-001.md', content: fm(reviewFm) },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

describe('rk review-aggregate — inline --verdicts mode', () => {
  it('returns RED when any reviewer is RED', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'YELLOW', 'RED'],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('RED');
  });

  it('returns YELLOW when reviewers are GREEN/YELLOW only', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'YELLOW'],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('YELLOW');
  });

  it('returns GREEN when all reviewers are GREEN', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'GREEN'],
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('GREEN');
  });

  it('rejects invalid verdict tokens with EXIT_USAGE (64)', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'BANANA'],
      json: false,
    });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('BANANA');
  });

  it('rejects empty verdicts list with EXIT_USAGE', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: [],
      json: false,
    });
    expect(r.exitCode).toBe(64);
  });

  it('emits JSON envelope when --json is set', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'RED'],
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { aggregate: string; source: string; inputs: string[] };
    expect(parsed.aggregate).toBe('RED');
    expect(parsed.source).toBe('inline');
    expect(parsed.inputs).toEqual(['GREEN', 'RED']);
  });
});

describe('rk review-aggregate — sprint mode', () => {
  it('reports the latest round aggregate from a sprint review', async () => {
    const cwd = await projectWithReview([
      panelRun(1, 'YELLOW', [reviewerRun('a', 'GREEN'), reviewerRun('b', 'YELLOW')]),
      panelRun(2, 'RED', [reviewerRun('a', 'RED'), reviewerRun('b', 'GREEN')]),
    ]);
    const r = await runReviewAggregateCommand('S-001', { cwd, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('RED');
  });

  it('emits JSON with round + reviewer breakdown when --json is set', async () => {
    const cwd = await projectWithReview([
      panelRun(1, 'YELLOW', [reviewerRun('a', 'GREEN'), reviewerRun('b', 'YELLOW')]),
    ]);
    const r = await runReviewAggregateCommand('S-001', { cwd, json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      aggregate: string;
      source: string;
      sprint_id: string;
      review_id: string;
      round: number;
      reviewers: Array<{ reviewer_id: string; verdict: string }>;
    };
    expect(parsed.aggregate).toBe('YELLOW');
    expect(parsed.source).toBe('sprint');
    expect(parsed.sprint_id).toBe('S-001');
    expect(parsed.review_id).toBe('R-001');
    expect(parsed.round).toBe(1);
    expect(parsed.reviewers).toHaveLength(2);
  });

  it('returns EXIT_BLOCKED when sprint is missing', async () => {
    const cwd = await projectWithReview([panelRun(1, 'GREEN', [reviewerRun('a', 'GREEN')])]);
    const r = await runReviewAggregateCommand('S-999', { cwd, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('S-999');
  });

  it('returns EXIT_BLOCKED when review has no panel_runs', async () => {
    const cwd = await projectWithReview();
    const r = await runReviewAggregateCommand('S-001', { cwd, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('panel_runs');
  });
});

describe('rk review-aggregate — --fail-on threshold', () => {
  it('exits 1 (EXIT_FINDINGS) when aggregate matches or exceeds --fail-on RED', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'RED'],
      json: false,
      failOn: 'RED',
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout.trim()).toBe('RED');
  });

  it('exits 0 when aggregate is below --fail-on RED', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'YELLOW'],
      json: false,
      failOn: 'RED',
    });
    expect(r.exitCode).toBe(0);
  });

  it('--fail-on YELLOW catches both YELLOW and RED', async () => {
    const yellowRun = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN', 'YELLOW'],
      json: false,
      failOn: 'YELLOW',
    });
    expect(yellowRun.exitCode).toBe(1);

    const redRun = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['RED'],
      json: false,
      failOn: 'YELLOW',
    });
    expect(redRun.exitCode).toBe(1);

    const greenRun = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      verdicts: ['GREEN'],
      json: false,
      failOn: 'YELLOW',
    });
    expect(greenRun.exitCode).toBe(0);
  });
});

describe('rk review-aggregate — --findings mode', () => {
  it('CRITICAL finding → RED', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: JSON.stringify([{ severity: 'CRITICAL', message: 'crash' }]),
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('RED');
  });

  it('HIGH finding → RED', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: JSON.stringify([{ severity: 'HIGH', message: 'vuln' }]),
      json: false,
    });
    expect(r.stdout.trim()).toBe('RED');
  });

  it('MEDIUM-only → YELLOW', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: JSON.stringify([{ severity: 'MEDIUM', message: 'warning' }]),
      json: false,
    });
    expect(r.stdout.trim()).toBe('YELLOW');
  });

  it('LOW-only → GREEN', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: JSON.stringify([{ severity: 'LOW', message: 'nit' }]),
      json: false,
    });
    expect(r.stdout.trim()).toBe('GREEN');
  });

  it('empty findings array → GREEN', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: '[]',
      json: false,
    });
    expect(r.stdout.trim()).toBe('GREEN');
  });

  it('CRITICAL + MEDIUM → RED (dominant)', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: JSON.stringify([
        { severity: 'CRITICAL', message: 'crash' },
        { severity: 'MEDIUM', message: 'warn' },
      ]),
      json: false,
    });
    expect(r.stdout.trim()).toBe('RED');
  });

  it('emits JSON envelope with source=findings when --json', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: JSON.stringify([{ severity: 'HIGH', message: 'bad' }]),
      json: true,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      aggregate: string;
      source: string;
      findings_count: number;
    };
    expect(parsed.aggregate).toBe('RED');
    expect(parsed.source).toBe('findings');
    expect(parsed.findings_count).toBe(1);
  });

  it('rejects invalid JSON with EXIT_USAGE', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: 'not json',
      json: false,
    });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('invalid JSON');
  });

  it('rejects unknown severity with EXIT_USAGE', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: JSON.stringify([{ severity: 'BANANA', message: 'bad' }]),
      json: false,
    });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('invalid schema');
  });

  it('rejects combination of --findings and --verdicts with EXIT_USAGE', async () => {
    const r = await runReviewAggregateCommand(undefined, {
      cwd: process.cwd(),
      findings: '[]',
      verdicts: ['GREEN'],
      json: false,
    });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('exactly one mode');
  });

  it('rejects combination of --findings and sprint-id with EXIT_USAGE', async () => {
    const r = await runReviewAggregateCommand('S-001', {
      cwd: process.cwd(),
      findings: '[]',
      json: false,
    });
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('exactly one mode');
  });
});
