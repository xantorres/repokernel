import { afterAll, describe, expect, it } from 'vitest';
import { effectiveReviewRequired, validateProject } from '../src/index.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

interface FileSpec {
  path: string;
  content: string;
}

async function setup(files: FileSpec[], extraConfig = '') {
  const fixture = await makeFixture([
    {
      path: 'repokernel.config.yaml',
      content: `${defaultConfigYaml()}${extraConfig}`,
    },
    ...files,
  ]);
  return validateProject({ cwd: fixture.cwd });
}

const epic = (sprints: string[]) => fm({ id: 'E-001', title: 'e', status: 'active', sprints });

function sprint(id: string, status: string, extra: Record<string, unknown> = {}): string {
  return fm({
    id,
    title: 's',
    epic_id: 'E-001',
    status,
    lane: 'main',
    ...extra,
  });
}

describe('effectiveReviewRequired (PR7 finding 12)', () => {
  it('returns false when requireReviewForShipped is off (project-wide opt-out)', () => {
    expect(
      effectiveReviewRequired({ id: 'S-099', review_required: true }, {
        policies: { requireReviewForShipped: false },
      } as never),
    ).toBe(false);
  });

  it('returns true when sprint.review_required is true and gate is on', () => {
    expect(
      effectiveReviewRequired({ id: 'S-001', review_required: true }, {
        policies: { requireReviewForShipped: true },
      } as never),
    ).toBe(true);
  });

  it('returns true when sprint number is >= threshold even if review_required is false', () => {
    expect(
      effectiveReviewRequired({ id: 'S-038', review_required: false }, {
        policies: {
          requireReviewForShipped: true,
          requireReviewForShippedFromSprintId: 38,
        },
      } as never),
    ).toBe(true);
  });

  it('returns false when sprint number is below threshold and review_required is false', () => {
    expect(
      effectiveReviewRequired({ id: 'S-001', review_required: false }, {
        policies: {
          requireReviewForShipped: true,
          requireReviewForShippedFromSprintId: 38,
        },
      } as never),
    ).toBe(false);
  });

  it('returns false when no threshold and review_required is false (legacy behavior)', () => {
    expect(
      effectiveReviewRequired({ id: 'S-099', review_required: false }, {
        policies: { requireReviewForShipped: true },
      } as never),
    ).toBe(false);
  });
});

describe('shipped-sprint review gate respects threshold (PR7 finding 12)', () => {
  it('shipped S-038 with threshold=38 and review_required:false flags missing review', async () => {
    const r = await setup(
      [
        { path: 'epics/E-001.md', content: epic(['S-038']) },
        {
          path: 'sprints/S-038.md',
          content: sprint('S-038', 'shipped', {
            review_required: false,
            base_sha: 'a'.repeat(40),
            end_sha: 'b'.repeat(40),
            closed_at: '2026-04-25T10:00:00Z',
          }),
        },
      ],
      'policies:\n  requireReviewForShippedFromSprintId: 38\n',
    );
    expect(r.findings.some((f) => f.code === 'SHIPPED_SPRINT_MISSING_REVIEW')).toBe(true);
  });

  it('shipped S-001 below threshold=38 with review_required:false does NOT flag (legacy)', async () => {
    const r = await setup(
      [
        { path: 'epics/E-001.md', content: epic(['S-001']) },
        {
          path: 'sprints/S-001.md',
          content: sprint('S-001', 'shipped', {
            review_required: false,
            base_sha: 'a'.repeat(40),
            end_sha: 'b'.repeat(40),
            closed_at: '2026-04-25T10:00:00Z',
          }),
        },
      ],
      'policies:\n  requireReviewForShippedFromSprintId: 38\n',
    );
    expect(r.findings.some((f) => f.code === 'SHIPPED_SPRINT_MISSING_REVIEW')).toBe(false);
  });

  it('shipped S-038 with threshold=38, review_required:false, and a non-accepted review flags REVIEW_NOT_ACCEPTED', async () => {
    const r = await setup(
      [
        { path: 'epics/E-001.md', content: epic(['S-038']) },
        {
          path: 'sprints/S-038.md',
          content: sprint('S-038', 'shipped', {
            review_required: false,
            review_id: 'R-001',
            base_sha: 'a'.repeat(40),
            end_sha: 'b'.repeat(40),
            closed_at: '2026-04-25T10:00:00Z',
          }),
        },
        {
          path: 'reviews/R-001.md',
          content: fm({
            id: 'R-001',
            sprint_id: 'S-038',
            verdict: 'changes_requested',
            reviewer: 'q',
            created_at: '2026-04-25T10:00:00Z',
          }),
        },
      ],
      'policies:\n  requireReviewForShippedFromSprintId: 38\n',
    );
    expect(r.findings.some((f) => f.code === 'SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED')).toBe(true);
  });

  it('with requireReviewForShipped:false, threshold is moot — no review finding even at threshold', async () => {
    const r = await setup(
      [
        { path: 'epics/E-001.md', content: epic(['S-038']) },
        {
          path: 'sprints/S-038.md',
          content: sprint('S-038', 'shipped', {
            review_required: false,
            base_sha: 'a'.repeat(40),
            end_sha: 'b'.repeat(40),
            closed_at: '2026-04-25T10:00:00Z',
          }),
        },
      ],
      'policies:\n  requireReviewForShipped: false\n  requireReviewForShippedFromSprintId: 38\n',
    );
    expect(r.findings.some((f) => f.code === 'SHIPPED_SPRINT_MISSING_REVIEW')).toBe(false);
  });
});
