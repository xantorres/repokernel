import { afterAll, describe, expect, it, vi } from 'vitest';
import { runEpicCloseCommand } from '../src/commands/epic.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

vi.mock('../src/lifecycle/git.js', () => ({
  getCurrentSha: vi.fn().mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd'),
  getPublishState: vi.fn().mockResolvedValue({ state: 'no_remote', remotes: [] }),
  isWorkingTreeClean: vi.fn().mockResolvedValue(true),
  changedFilesSince: vi.fn().mockResolvedValue([]),
  changedFilesForSprint: vi.fn().mockResolvedValue({
    files: [],
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
  }),
}));

afterAll(cleanupAllFixtures);

function epicFile(sprintIds: string[], status = 'active'): string {
  return fm({ id: 'E-001', title: 'Test Epic', status, sprints: sprintIds });
}

function shippedSprintWithBrokenReview(id: string, brokenReviewId: string): string {
  return fm({
    id,
    title: `Sprint ${id}`,
    epic_id: 'E-001',
    status: 'shipped',
    lane: 'main',
    review_required: true,
    review_id: brokenReviewId,
    started_at: '2026-04-25T10:00:00Z',
    base_sha: 'abc1234',
    closed_at: '2026-04-26T10:00:00Z',
    end_sha: 'def5678',
  });
}

function shippedSprintWithGoodReview(id: string, reviewId: string): string {
  return fm({
    id,
    title: `Sprint ${id}`,
    epic_id: 'E-001',
    status: 'shipped',
    lane: 'main',
    review_required: true,
    review_id: reviewId,
    started_at: '2026-04-25T10:00:00Z',
    base_sha: 'abc1234',
    closed_at: '2026-04-26T10:00:00Z',
    end_sha: 'def5678',
  });
}

function acceptedReview(id: string, sprintId: string): string {
  return fm({
    id,
    sprint_id: sprintId,
    verdict: 'accepted',
    reviewer: 'agent',
    created_at: '2026-04-26T11:00:00Z',
    base_sha: 'abc1234',
    end_sha: 'def5678',
  });
}

describe('runEpicCloseCommand — review-integrity pre-flight gate', () => {
  it('blocks close when a sprint review_id points at a missing review file', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: shippedSprintWithBrokenReview('S-001', 'R-999') },
    ]);

    const r = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: false,
      force: false,
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('review-integrity issue');
    expect(r.stderr).toContain('rk review-reconcile');
    // Epic frontmatter MUST NOT have been mutated.
    const { readFile } = await import('node:fs/promises');
    const matter = (await import('gray-matter')).default;
    const data = matter(await readFile(`${cwd}/epics/E-001.md`, 'utf8')).data;
    expect(data.status).toBe('active');
  });

  it('--force bypasses the review-integrity gate (epic mutated even though findings remain)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: shippedSprintWithBrokenReview('S-001', 'R-999') },
    ]);

    const r = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: false,
      force: true,
    });

    // Post-close registry refresh still surfaces the broken review_id as
    // findings (EXIT_FINDINGS=1), but the epic itself is mutated to done.
    expect(r.stdout).toContain('Closed E-001');
    const { readFile } = await import('node:fs/promises');
    const matter = (await import('gray-matter')).default;
    const data = matter(await readFile(`${cwd}/epics/E-001.md`, 'utf8')).data;
    expect(data.status).toBe('done');
  });

  it('clean epic with all sprint→review pointers valid passes the gate', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: shippedSprintWithGoodReview('S-001', 'R-001') },
      { path: 'reviews/R-001.md', content: acceptedReview('R-001', 'S-001') },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }],
        }),
      },
    ]);

    const r = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: false,
      force: false,
    });

    expect(r.exitCode).toBe(0);
  });
});
