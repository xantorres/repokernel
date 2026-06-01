import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runReReviewCommand } from '../src/commands/lifecycle.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

function review(
  verdict: string,
  extra: Record<string, unknown> = {},
): { path: string; content: string } {
  return {
    path: 'reviews/R-001.md',
    content: fm({
      id: 'R-001',
      sprint_id: 'S-001',
      verdict,
      reviewer: 'agent',
      findings: [],
      created_at: '2024-01-01T00:00:00Z',
      ...extra,
    }),
  };
}

async function project(reviewFile: { path: string; content: string }): Promise<string> {
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
        title: 'S',
        epic_id: 'E-001',
        status: 'review',
        lane: 'main',
        review_id: 'R-001',
      }),
    },
    reviewFile,
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

async function readReview(cwd: string): Promise<Record<string, unknown>> {
  return matter(await readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).data as Record<
    string,
    unknown
  >;
}

describe('runReReviewCommand', () => {
  it('reopens a changes_requested review and increments the attempt (default 1 → 2)', async () => {
    const cwd = await project(review('changes_requested'));
    const r = await runReReviewCommand('R-001', { cwd, dryRun: false, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as { verdict: string; review_attempt: number };
    expect(obj.verdict).toBe('pending');
    expect(obj.review_attempt).toBe(2);
    const data = await readReview(cwd);
    expect(data.verdict).toBe('pending');
    expect(data.review_attempt).toBe(2);
  });

  it('resolves the linked review from a sprint id', async () => {
    const cwd = await project(review('rejected'));
    const r = await runReReviewCommand('S-001', { cwd, dryRun: false, json: true });
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as { reviewId: string }).reviewId).toBe('R-001');
  });

  it('refuses to re-review an accepted verdict', async () => {
    const cwd = await project(review('accepted'));
    const r = await runReReviewCommand('R-001', { cwd, dryRun: false, json: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('accepted');
  });

  it('refuses to re-review a pending verdict', async () => {
    const cwd = await project(review('pending'));
    const r = await runReReviewCommand('R-001', { cwd, dryRun: false, json: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain('pending');
  });

  it('escalates once the sprint has been sent back repeatedly', async () => {
    const cwd = await project(review('rejected', { review_attempt: 2 }));
    const r = await runReReviewCommand('R-001', { cwd, dryRun: false, json: true });
    const obj = JSON.parse(r.stdout) as { review_attempt: number; escalate: boolean };
    expect(obj.review_attempt).toBe(3);
    expect(obj.escalate).toBe(true);
  });
});
