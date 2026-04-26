/**
 * Tests for rk review-verdict rejected — revert success and conflict paths.
 *
 * Uses real temp dirs + mocked git functions. Does not require a real git repo.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runReviewVerdictCommand } from '../src/commands/lifecycle.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

vi.mock('../src/lifecycle/git.js', () => ({
  getCurrentSha: vi.fn().mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd'),
  isWorkingTreeClean: vi.fn().mockResolvedValue(true),
  changedFilesSince: vi.fn().mockResolvedValue([]),
  revertRange: vi.fn().mockResolvedValue(undefined),
  tryRevertRange: vi.fn().mockResolvedValue({ ok: true }),
}));

import { tryRevertRange } from '../src/lifecycle/git.js';

afterAll(cleanupAllFixtures);

afterEach(() => {
  vi.mocked(tryRevertRange).mockReset();
  vi.mocked(tryRevertRange).mockResolvedValue({ ok: true });
});

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

function epicFile() {
  return fm({ id: 'E-001', title: 'Test Epic', status: 'active', sprints: ['S-001'] });
}

function sprintFile(extra: Record<string, unknown> = {}) {
  return fm({
    id: 'S-001',
    title: 'Sprint One',
    epic_id: 'E-001',
    status: 'review',
    lane: 'main',
    review_id: 'R-001',
    base_sha: 'aabb0000aabb0000aabb0000aabb0000aabb0000',
    end_sha: 'ccdd1111ccdd1111ccdd1111ccdd1111ccdd1111',
    ...extra,
  });
}

function reviewFile(extra: Record<string, unknown> = {}) {
  return fm({
    id: 'R-001',
    sprint_id: 'S-001',
    verdict: 'pending',
    reviewer: 'agent',
    findings: [],
    created_at: '2026-04-26T10:00:00Z',
    ...extra,
  });
}

function baseFixture(sprintOverrides: Record<string, unknown> = {}) {
  return [
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    { path: 'epics/E-001.md', content: epicFile() },
    { path: 'sprints/S-001.md', content: sprintFile(sprintOverrides) },
    { path: 'reviews/R-001.md', content: reviewFile() },
    { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
  ] as const;
}

// — successful revert —

describe('review-verdict rejected: successful revert', () => {
  it('calls tryRevertRange with correct SHAs', async () => {
    const cwd = await makeFixture(baseFixture());

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    expect(tryRevertRange).toHaveBeenCalledWith(
      cwd,
      'aabb0000aabb0000aabb0000aabb0000aabb0000',
      'ccdd1111ccdd1111ccdd1111ccdd1111ccdd1111',
      expect.stringContaining('S-001'),
    );
  });

  it('shows Reverted line in stdout', async () => {
    const cwd = await makeFixture(baseFixture());

    const result = await runReviewVerdictCommand('R-001', 'rejected', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Reverted');
    expect(result.stdout).not.toContain('Warning');
  });

  it('sets sprint status to reopened', async () => {
    const cwd = await makeFixture(baseFixture());

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('reopened');
  });

  it('records verdict as rejected', async () => {
    const cwd = await makeFixture(baseFixture());

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    const data = await readFm(join(cwd, 'reviews/R-001.md'));
    expect(data.verdict).toBe('rejected');
  });
});

// — revert conflict —

describe('review-verdict rejected: revert conflict', () => {
  it('writes warning to stderr', async () => {
    vi.mocked(tryRevertRange).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      details: 'CONFLICT in src/foo.ts',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cwd = await makeFixture(baseFixture());

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('auto-revert');
    expect(written).toContain('git revert');
    expect(written).toContain('rk reopen S-001');
    stderrSpy.mockRestore();
  });

  it('shows Warning line in stdout', async () => {
    vi.mocked(tryRevertRange).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      details: 'conflict',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cwd = await makeFixture(baseFixture());

    const result = await runReviewVerdictCommand('R-001', 'rejected', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Warning');
    expect(result.stdout).not.toContain('Reverted');
    stderrSpy.mockRestore();
  });

  it('does not set sprint status to reopened', async () => {
    vi.mocked(tryRevertRange).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      details: 'conflict',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cwd = await makeFixture(baseFixture());

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('review');
    stderrSpy.mockRestore();
  });

  it('still records verdict as rejected despite conflict', async () => {
    vi.mocked(tryRevertRange).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      details: 'conflict',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cwd = await makeFixture(baseFixture());

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    const data = await readFm(join(cwd, 'reviews/R-001.md'));
    expect(data.verdict).toBe('rejected');
    stderrSpy.mockRestore();
  });

  it('exit code is 0 even when revert fails (verdict was recorded)', async () => {
    vi.mocked(tryRevertRange).mockResolvedValue({
      ok: false,
      reason: 'conflict',
      details: 'conflict',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cwd = await makeFixture(baseFixture());

    const result = await runReviewVerdictCommand('R-001', 'rejected', {
      cwd,
      dryRun: false,
      json: false,
    });

    expect(result.exitCode).toBe(0);
    stderrSpy.mockRestore();
  });
});

// — sprint has no SHAs —

describe('review-verdict rejected: sprint missing SHAs', () => {
  it('does not call tryRevertRange when sprint has no base_sha', async () => {
    const cwd = await makeFixture(baseFixture({ base_sha: null, end_sha: null }));

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    expect(tryRevertRange).not.toHaveBeenCalled();
  });

  it('does not call tryRevertRange when sprint has no end_sha', async () => {
    const cwd = await makeFixture(baseFixture({ end_sha: null }));

    await runReviewVerdictCommand('R-001', 'rejected', { cwd, dryRun: false, json: false });

    expect(tryRevertRange).not.toHaveBeenCalled();
  });
});
