import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runReviewReconcileCommand } from '../src/commands/reviewReconcile.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface SprintSpec {
  id: string;
  reviewId?: string | null;
}
interface ReviewSpec {
  id: string;
  sprintId: string;
}

async function projectWithSprintsAndReviews(
  sprints: SprintSpec[],
  reviews: ReviewSpec[],
): Promise<string> {
  const files = [
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({
        id: 'E-001',
        title: 'demo',
        status: 'active',
        sprints: sprints.map((s) => s.id),
      }),
    },
    {
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [] }),
    },
  ];
  for (const s of sprints) {
    files.push({
      path: `sprints/${s.id}.md`,
      content: fm({
        id: s.id,
        title: s.id,
        epic_id: 'E-001',
        status: 'planned',
        lane: 'main',
        review_id: s.reviewId === undefined ? null : s.reviewId,
      }),
    });
  }
  for (const r of reviews) {
    files.push({
      path: `reviews/${r.id}.md`,
      content: fm({
        id: r.id,
        sprint_id: r.sprintId,
        verdict: 'pending',
        reviewer: 'agent',
        created_at: '2026-04-28T10:00:00Z',
      }),
    });
  }
  return makeFixture(files);
}

describe('runReviewReconcileCommand', () => {
  it('reports clean when nothing is broken', async () => {
    const cwd = await projectWithSprintsAndReviews(
      [{ id: 'S-001', reviewId: 'R-001' }],
      [{ id: 'R-001', sprintId: 'S-001' }],
    );
    const r = await runReviewReconcileCommand({ cwd, apply: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('detects sprint review_id pointing at missing file', async () => {
    const cwd = await projectWithSprintsAndReviews([{ id: 'S-001', reviewId: 'R-999' }], []);
    const r = await runReviewReconcileCommand({ cwd, apply: false, json: true });
    expect(r.exitCode).not.toBe(0);
    const obj = JSON.parse(r.stdout) as { issues: Array<{ kind: string }> };
    expect(obj.issues.some((i) => i.kind === 'missing_review_file')).toBe(true);
  });

  it('detects review pointing at a different sprint', async () => {
    const cwd = await projectWithSprintsAndReviews(
      [
        { id: 'S-001', reviewId: 'R-001' },
        { id: 'S-002', reviewId: null },
      ],
      [{ id: 'R-001', sprintId: 'S-002' }],
    );
    const r = await runReviewReconcileCommand({ cwd, apply: false, json: true });
    expect(r.exitCode).not.toBe(0);
    const obj = JSON.parse(r.stdout) as { issues: Array<{ kind: string }> };
    expect(obj.issues.some((i) => i.kind === 'review_sprint_mismatch')).toBe(true);
  });

  it('detects two sprints sharing a review_id (DV E-025/E-029 collision)', async () => {
    const cwd = await projectWithSprintsAndReviews(
      [
        { id: 'S-001', reviewId: 'R-100' },
        { id: 'S-002', reviewId: 'R-100' },
      ],
      [{ id: 'R-100', sprintId: 'S-001' }],
    );
    const r = await runReviewReconcileCommand({ cwd, apply: false, json: true });
    expect(r.exitCode).not.toBe(0);
    const obj = JSON.parse(r.stdout) as { issues: Array<{ kind: string }> };
    expect(obj.issues.some((i) => i.kind === 'duplicate_review_id')).toBe(true);
  });

  it('--apply allocates fresh review IDs and rewrites sprint frontmatter', async () => {
    const cwd = await projectWithSprintsAndReviews(
      [
        { id: 'S-001', reviewId: 'R-100' },
        { id: 'S-002', reviewId: 'R-100' },
        { id: 'S-003', reviewId: 'R-999' }, // missing
      ],
      [{ id: 'R-100', sprintId: 'S-001' }],
    );
    const r = await runReviewReconcileCommand({ cwd, apply: true, json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      ok: boolean;
      repairs: Array<{ sprintId: string; toReviewId: string }>;
    };
    expect(obj.ok).toBe(true);
    // S-002 had collision, S-003 had missing file → both need new IDs.
    const repairedSprints = obj.repairs.map((x) => x.sprintId);
    expect(repairedSprints).toContain('S-002');
    expect(repairedSprints).toContain('S-003');
    // Check the newly-allocated review files exist with correct sprint_id.
    for (const repair of obj.repairs) {
      const stub = await readFile(join(cwd, `reviews/${repair.toReviewId}.md`), 'utf8');
      expect(matter(stub).data.sprint_id).toBe(repair.sprintId);
    }
    // Sprint frontmatter rewritten.
    const s2 = matter(await readFile(join(cwd, 'sprints/S-002.md'), 'utf8')).data;
    expect(s2.review_id).not.toBe('R-100');
  });

  it('--epic restricts to one epic (no false positives in other epics)', async () => {
    const cwd = await projectWithSprintsAndReviews([{ id: 'S-001', reviewId: 'R-999' }], []);
    const rNoEpic = await runReviewReconcileCommand({ cwd, apply: false, json: true });
    expect(rNoEpic.exitCode).not.toBe(0);
    const rOtherEpic = await runReviewReconcileCommand({
      cwd,
      apply: false,
      epic: 'E-999',
      json: true,
    });
    expect(rOtherEpic.exitCode).toBe(0);
  });
});
