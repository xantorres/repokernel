import { afterAll, describe, expect, it } from 'vitest';
import { validateProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface FileSpec {
  path: string;
  content: string;
}

async function setup(files: FileSpec[]) {
  const fixture = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ...files,
  ]);
  return validateProject({ cwd: fixture.cwd });
}

const epic = (sprints: string[]) => fm({ id: 'E-001', title: 'e', status: 'active', sprints });

const sprint = (status: string, extra: Record<string, unknown> = {}) =>
  fm({
    id: 'S-001',
    title: 's',
    epic_id: 'E-001',
    status,
    lane: 'main',
    ...extra,
  });

const review = (extra: Record<string, unknown> = {}) =>
  fm({
    id: 'R-001',
    sprint_id: 'S-001',
    verdict: 'accepted',
    reviewer: 'someone',
    created_at: '2026-04-25T10:00:00Z',
    ...extra,
  });

describe('SPRINT_REVIEW_ID_MISSING_REVIEW', () => {
  it('flags when sprint declares review_id pointing nowhere', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: epic(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: sprint('planned', { review_id: 'R-999' }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'SPRINT_REVIEW_ID_MISSING_REVIEW')).toBe(true);
  });
});

describe('SPRINT_REVIEW_ID_WRONG_SPRINT', () => {
  it('flags when sprint references review for another sprint', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: epic(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: sprint('planned', { review_id: 'R-001' }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 's2',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-002',
          verdict: 'accepted',
          reviewer: 'someone',
          created_at: '2026-04-25T10:00:00Z',
        }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'SPRINT_REVIEW_ID_WRONG_SPRINT')).toBe(true);
  });
});

describe('SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED', () => {
  it('flags shipped sprint with only changes_requested review', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: epic(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: sprint('shipped', {
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T11:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: review({ verdict: 'changes_requested' }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED')).toBe(true);
  });
});

describe('REVIEW_BASE_SHA_MISMATCH', () => {
  it('flags when sprint base_sha differs from review base_sha', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: epic(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: sprint('shipped', {
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T11:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: review({ base_sha: 'deadbee', end_sha: 'b2c3d4e' }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'REVIEW_BASE_SHA_MISMATCH')).toBe(true);
  });
});

describe('REVIEW_END_SHA_MISMATCH', () => {
  it('flags when sprint end_sha differs from review end_sha', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: epic(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: sprint('shipped', {
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T11:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: review({ base_sha: 'a1b2c3d', end_sha: 'cafef00' }),
      },
    ]);
    expect(r.findings.some((f) => f.code === 'REVIEW_END_SHA_MISMATCH')).toBe(true);
  });
});

describe('SHA matches do not flag', () => {
  it('clean shipped sprint with matching SHAs and accepted review has no review-integrity findings', async () => {
    const r = await setup([
      { path: 'epics/E-001.md', content: epic(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: sprint('shipped', {
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T11:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: review({ base_sha: 'a1b2c3d', end_sha: 'b2c3d4e' }),
      },
    ]);
    const reviewCodes = r.findings.filter((f) =>
      [
        'SPRINT_REVIEW_ID_MISSING_REVIEW',
        'SPRINT_REVIEW_ID_WRONG_SPRINT',
        'SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED',
        'REVIEW_BASE_SHA_MISMATCH',
        'REVIEW_END_SHA_MISMATCH',
      ].includes(f.code),
    );
    expect(reviewCodes).toEqual([]);
  });
});
