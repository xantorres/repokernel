import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, describe, expect, it } from 'vitest';
import { runReviewCreateCommand } from '../src/commands/reviewCreate.js';
import { runReviewEvidenceCommand } from '../src/commands/reviewEvidence.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

afterAll(cleanupAllFixtures);

async function project(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'demo', status: 'active', sprints: ['S-001', 'S-002'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({ id: 'S-001', title: 's1', epic_id: 'E-001', status: 'planned', lane: 'main' }),
    },
    {
      path: 'sprints/S-002.md',
      content: fm({ id: 'S-002', title: 's2', epic_id: 'E-001', status: 'planned', lane: 'main' }),
    },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ]);
}

describe('runReviewCreateCommand', () => {
  it('creates a review stub with correct frontmatter schema', async () => {
    const cwd = await project();
    const r = await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('R-001');
    expect(r.stdout).toContain('S-001');

    const stub = await readFile(join(cwd, 'reviews/R-001.md'), 'utf8');
    const { data } = matter(stub);
    expect(data.id).toBe('R-001');
    expect(data.sprint_id).toBe('S-001');
    expect(data.verdict).toBe('pending');
    expect(Array.isArray(data.findings)).toBe(true);
  });

  it('stub body contains authoring section headers', async () => {
    const cwd = await project();
    await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: false });
    const stub = await readFile(join(cwd, 'reviews/R-001.md'), 'utf8');
    expect(stub).toContain('## Summary');
    expect(stub).toContain('## Findings');
    expect(stub).toContain('## Verdict');
  });

  it('emits JSON envelope with reviewId and file path', async () => {
    const cwd = await project();
    const r = await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: true });
    expect(r.exitCode).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      reviewId: string;
      sprintId: string;
      file: string;
      reused: boolean;
      linked: boolean;
      sprintFile: string;
      reviewReady: boolean;
      next_actions: string[];
    };
    expect(obj.reviewId).toBe('R-001');
    expect(obj.sprintId).toBe('S-001');
    expect(obj.file).toContain('R-001.md');
    expect(obj.reused).toBe(false);
    expect(obj.linked).toBe(true);
    expect(obj.sprintFile).toBe('sprints/S-001.md');
    expect(obj.reviewReady).toBe(true);
    expect(obj.next_actions).toEqual(expect.arrayContaining(['rk review-evidence S-001']));

    const sprint = matter(await readFile(join(cwd, 'sprints/S-001.md'), 'utf8')).data as {
      review_id?: string;
    };
    expect(sprint.review_id).toBe('R-001');
  });

  it('is idempotent — returns reused:true on second call, no new file', async () => {
    const cwd = await project();
    const r1 = await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: true });
    const o1 = JSON.parse(r1.stdout) as { reviewId: string; reused: boolean };
    expect(o1.reused).toBe(false);

    const r2 = await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: true });
    const o2 = JSON.parse(r2.stdout) as { reviewId: string; reused: boolean };
    expect(o2.reviewId).toBe(o1.reviewId);
    expect(o2.reused).toBe(true);
    expect(matter(await readFile(join(cwd, 'sprints/S-001.md'), 'utf8')).data.review_id).toBe(
      o1.reviewId,
    );

    // Second sprint gets the next ID
    const r3 = await runReviewCreateCommand({ cwd, sprintId: 'S-002', json: true });
    const o3 = JSON.parse(r3.stdout) as { reviewId: string; reused: boolean };
    expect(o3.reviewId).toBe('R-002');
  });

  it('rejects invalid sprint id with EXIT_BLOCKED', async () => {
    const cwd = await project();
    const r = await runReviewCreateCommand({ cwd, sprintId: 'E-001', json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('invalid sprint id');
  });

  it('lets evidence target the sprint immediately after creating the review', async () => {
    const cwd = await project();
    await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: true });

    const r = await runReviewEvidenceCommand('S-001', {
      cwd,
      label: 'focused-tests',
      command: `${process.execPath} -e "process.exit(0)"`,
      timeoutSeconds: 10,
      json: true,
    });

    expect(r.exitCode).toBe(0);
    const review = matter(await readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).data as {
      command_evidence?: Array<{ label: string; status: string }>;
    };
    expect(review.command_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'focused-tests', status: 'passed' }),
      ]),
    );
  });

  it('stamps the configured default reviewer when no --reviewer is given', async () => {
    const cwd = await project();
    await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: true });
    const data = matter(await readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).data as {
      reviewer?: string;
    };
    expect(data.reviewer).toBe('agent');
  });

  it('stamps an explicit --reviewer over the config default', async () => {
    const cwd = await project();
    await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: true, reviewer: 'codex' });
    const data = matter(await readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).data as {
      reviewer?: string;
    };
    expect(data.reviewer).toBe('codex');
  });

  it('rejects an empty --reviewer', async () => {
    const cwd = await project();
    const r = await runReviewCreateCommand({ cwd, sprintId: 'S-001', json: true, reviewer: '   ' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('non-empty');
  });
});
