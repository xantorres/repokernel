import { afterAll, describe, expect, it } from 'vitest';
import { runStatusCommand } from '../src/commands/status.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(inReview: boolean): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Sprint One',
        epic_id: 'E-001',
        status: inReview ? 'review' : 'active',
        lane: 'main',
        ...(inReview ? { review_id: 'R-001' } : {}),
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ...(inReview
      ? [
          {
            path: 'reviews/R-001.md',
            content: fm({
              id: 'R-001',
              sprint_id: 'S-001',
              verdict: 'changes_requested',
              reviewer: 'codex',
              created_at: '2026-06-01T00:00:00Z',
              review_attempt: 2,
            }),
          },
        ]
      : []),
  ]);
}

describe('status current_review', () => {
  it('reports the review linked to the sprint in review status (JSON)', async () => {
    const cwd = await project(true);
    const r = await runStatusCommand({ cwd, json: true });
    const out = JSON.parse(r.stdout) as { current_review: Record<string, unknown> };
    expect(out.current_review).toMatchObject({
      review_id: 'R-001',
      reviewer: 'codex',
      verdict: 'changes_requested',
      review_attempt: 2,
    });
  });

  it('shows the review line in text output', async () => {
    const cwd = await project(true);
    const r = await runStatusCommand({ cwd, json: false });
    expect(r.stdout).toContain('Review:');
    expect(r.stdout).toContain('R-001 (codex) changes_requested — attempt 2');
  });

  it('is null when no sprint is in review', async () => {
    const cwd = await project(false);
    const r = await runStatusCommand({ cwd, json: true });
    expect((JSON.parse(r.stdout) as { current_review: unknown }).current_review).toBeNull();
  });
});

async function parallelProject(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'E', status: 'active', sprints: ['S-001', 'S-002'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'One',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        review_id: 'R-001',
      }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({
        id: 'S-002',
        title: 'Two',
        epic_id: 'E-001',
        status: 'review',
        lane: 'second',
        review_id: 'R-002',
      }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    { path: 'queues/second.md', content: fm({ lane: 'second', slots: [] }) },
    {
      path: 'reviews/R-001.md',
      content: fm({
        id: 'R-001',
        sprint_id: 'S-001',
        verdict: 'pending',
        reviewer: 'codex',
        created_at: '2026-06-01T00:00:00Z',
      }),
    },
    {
      path: 'reviews/R-002.md',
      content: fm({
        id: 'R-002',
        sprint_id: 'S-002',
        verdict: 'accepted',
        reviewer: 'codex',
        created_at: '2026-06-01T00:00:00Z',
      }),
    },
  ]);
}

describe('status current_reviews (parallel lanes)', () => {
  it('lists every sprint in review, not just the first', async () => {
    const cwd = await parallelProject();
    const r = await runStatusCommand({ cwd, json: true });
    const out = JSON.parse(r.stdout) as {
      current_reviews: Array<{ sprint_id: string; lane: string; verdict: string }>;
    };
    expect(out.current_reviews).toHaveLength(2);
    expect(out.current_reviews.map((x) => x.sprint_id)).toEqual(['S-001', 'S-002']);
    expect(out.current_reviews.find((x) => x.sprint_id === 'S-002')?.lane).toBe('second');
  });
});
