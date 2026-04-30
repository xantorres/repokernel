import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReviewDiscardCommand } from '../src/commands/reviewDiscard.js';

const tracked: string[] = [];

afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(extraFiles: Record<string, string> = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-review-discard-'));
  tracked.push(cwd);
  await mkdir(join(cwd, 'reviews'), { recursive: true });
  await writeFile(
    join(cwd, 'repokernel.config.yaml'),
    `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`,
    'utf8',
  );
  for (const [path, content] of Object.entries(extraFiles)) {
    const abs = join(cwd, path);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return cwd;
}

function pendingReviewMd(): string {
  return `---
id: R-001
sprint_id: S-001
verdict: pending
---
`;
}

describe('runReviewDiscardCommand — argument validation', () => {
  it('rejects an invalid review id format', async () => {
    const cwd = await makeRepo();
    const result = await runReviewDiscardCommand('not-an-id', { cwd, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not a valid review id');
  });

  it('rejects lowercase r-001', async () => {
    const cwd = await makeRepo();
    const result = await runReviewDiscardCommand('r-001', { cwd, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not a valid review id');
  });
});

describe('runReviewDiscardCommand — config errors', () => {
  it('non-config cwd returns runtime error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-no-config-'));
    tracked.push(dir);
    const result = await runReviewDiscardCommand('R-001', { cwd: dir, json: false });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('runReviewDiscardCommand — file not found', () => {
  it('returns blocked error when review file absent', async () => {
    const cwd = await makeRepo();
    const result = await runReviewDiscardCommand('R-099', { cwd, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
  });
});

describe('runReviewDiscardCommand — verdict guard', () => {
  it('rejects review with accepted verdict', async () => {
    const content = `---
id: R-001
sprint_id: S-001
verdict: accepted
---
`;
    const cwd = await makeRepo({ 'reviews/R-001.md': content });
    const result = await runReviewDiscardCommand('R-001', { cwd, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('accepted');
    expect(result.stderr).toContain('rk reopen');
  });

  it('rejects review with changes_requested verdict', async () => {
    const content = `---
id: R-001
sprint_id: S-001
verdict: changes_requested
---
`;
    const cwd = await makeRepo({ 'reviews/R-001.md': content });
    const result = await runReviewDiscardCommand('R-001', { cwd, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('changes_requested');
  });

  it('rejects review with no verdict set', async () => {
    const content = `---
id: R-001
sprint_id: S-001
---
`;
    const cwd = await makeRepo({ 'reviews/R-001.md': content });
    const result = await runReviewDiscardCommand('R-001', { cwd, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('(unset)');
  });
});

describe('runReviewDiscardCommand — happy path', () => {
  it('deletes pending review file, returns exitCode 0 (text output)', async () => {
    const cwd = await makeRepo({ 'reviews/R-001.md': pendingReviewMd() });
    const result = await runReviewDiscardCommand('R-001', { cwd, json: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discarded');
    expect(result.stdout).toContain('R-001');
    expect(existsSync(join(cwd, 'reviews', 'R-001.md'))).toBe(false);
  });

  it('deletes pending review file, returns JSON output', async () => {
    const cwd = await makeRepo({ 'reviews/R-001.md': pendingReviewMd() });
    const result = await runReviewDiscardCommand('R-001', { cwd, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { reviewId: string; discarded: boolean };
    expect(parsed.reviewId).toBe('R-001');
    expect(parsed.discarded).toBe(true);
    expect(existsSync(join(cwd, 'reviews', 'R-001.md'))).toBe(false);
  });

  it('handles R-NNN with leading zeros correctly', async () => {
    const content = `---
id: R-042
sprint_id: S-010
verdict: pending
---
`;
    const cwd = await makeRepo({ 'reviews/R-042.md': content });
    const result = await runReviewDiscardCommand('R-042', { cwd, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { reviewId: string };
    expect(parsed.reviewId).toBe('R-042');
  });
});
