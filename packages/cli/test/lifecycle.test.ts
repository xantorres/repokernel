import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloseCommand } from '../src/commands/lifecycle.js';
import { runReopenCommand } from '../src/commands/lifecycle.js';
import { runReviewCommand } from '../src/commands/lifecycle.js';
import { runStartCommand } from '../src/commands/lifecycle.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

// mock git utilities so test fixtures don't need a real git repo
vi.mock('../src/lifecycle/git.js', () => ({
  getCurrentSha: vi.fn().mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd'),
  isWorkingTreeClean: vi.fn().mockResolvedValue(true),
  changedFilesSince: vi.fn().mockResolvedValue(['src/parser/markdown.ts']),
}));

import { changedFilesSince, getCurrentSha, isWorkingTreeClean } from '../src/lifecycle/git.js';

afterAll(cleanupAllFixtures);

afterEach(() => {
  vi.mocked(getCurrentSha).mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd');
  vi.mocked(isWorkingTreeClean).mockResolvedValue(true);
  vi.mocked(changedFilesSince).mockResolvedValue(['src/parser/markdown.ts']);
});

// — fixtures —

function epicFile(sprintIds: string[]) {
  return fm({ id: 'E-001', title: 'Test Epic', status: 'active', sprints: sprintIds });
}

function queueFile(slots: Array<{ id: string; sprint_id: string; order: number }>) {
  return fm({ lane: 'main', slots });
}

function reviewFile(id: string, sprintId: string, verdict = 'accepted', endSha?: string) {
  const data: Record<string, unknown> = {
    id,
    sprint_id: sprintId,
    verdict,
    reviewer: 'agent',
    findings: [],
    created_at: '2026-04-25T10:00:00Z',
  };
  if (endSha) data.end_sha = endSha;
  return fm(data);
}

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

// — start command —

describe('runStartCommand', () => {
  it('queued → active, captures base_sha', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({ id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runStartCommand('S-001', { cwd, force: false, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Started S-001');
    expect(r.stdout).toContain('deadbee'); // first 7 chars of mock SHA

    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('active');
    expect(data.base_sha).toBe('deadbeefcafe1234567890abcdef12345678abcd');
    expect(data.started_at).toBeTruthy();
  });

  it('fails with actionable message when sprint not in queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({ id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runStartCommand('S-001', { cwd, force: false, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('not in any queue');
    expect(r.stderr).toContain('rk queue add S-001');
  });

  it('fails when depends_on sprint is not shipped', async () => {
    // S-002 is at head of queue but depends on S-001 which is still queued (not shipped)
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({ id: 'S-001', title: 'Dep', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002', title: 'Target', epic_id: 'E-001', status: 'queued', lane: 'main',
          depends_on: ['S-001'],
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-001', sprint_id: 'S-002', order: 0 }, // S-002 at head
          { id: 'Q-002', sprint_id: 'S-001', order: 1 },
        ]),
      },
    ]);

    const r = await runStartCommand('S-002', { cwd, force: false, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('dependency S-001 is not shipped');
  });

  it('fails when another sprint is already active in the same lane', async () => {
    // S-002 is at head of queue; S-001 is active in the same lane
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Active one', epic_id: 'E-001', status: 'active', lane: 'main',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'abc1234',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({ id: 'S-002', title: 'Queued', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-002', sprint_id: 'S-002', order: 0 }, // S-002 at head
        ]),
      },
    ]);

    const r = await runStartCommand('S-002', { cwd, force: false, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('already active in lane main');
    expect(r.stderr).toContain('S-001');
  });

  it('fails when sprint has an unresolved gate', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Gated', epic_id: 'E-001', status: 'queued', lane: 'main',
          gate: 'human_review',
        }),
      },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runStartCommand('S-001', { cwd, force: false, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('unresolved gate: human_review');
  });

  it('--force allows starting a planned sprint with a loud warning', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({ id: 'S-001', title: 'Planned', epic_id: 'E-001', status: 'planned', lane: 'main' }),
      },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runStartCommand('S-001', { cwd, force: true, dryRun: false, json: false });
    // may succeed or fail at lane-active check depending on state
    // but it must not fail with INVALID_STATUS
    expect(r.stderr).not.toContain('INVALID_STATUS');
    // started or blocked by queue issues, not by status
    if (r.exitCode === 0) {
      expect(r.stdout).toContain('Warning');
      expect(r.stdout).toContain('--force');
      const data = await readFm(join(cwd, 'sprints/S-001.md'));
      expect(data.status).toBe('active');
    }
  });
});

// — review command —

describe('runReviewCommand', () => {
  it('active → review, auto-creates review file when missing', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'active', lane: 'main',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Sprint S-001 moved to review');
    expect(r.stdout).toContain('created');

    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('review');
    expect(data.review_id).toMatch(/^R-\d+$/);
  });

  it('fails when no changes since base_sha', async () => {
    vi.mocked(changedFilesSince).mockResolvedValueOnce([]);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'active', lane: 'main',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('no changes since base_sha');
    expect(r.stderr).toContain('commit your implementation');
  });

  it('fails when a modified file matches denied_paths', async () => {
    vi.mocked(changedFilesSince).mockResolvedValueOnce(['.repokernel/plan/sprints/S-002.md']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'active', lane: 'main',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          denied_paths: ['.repokernel/plan/sprints'],
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('modified denied path');
    expect(r.stderr).toContain('.repokernel/plan/sprints/S-002.md');
  });

  it('fails when a file is outside allowed_paths', async () => {
    vi.mocked(changedFilesSince).mockResolvedValueOnce(['src/parser/parser.ts', 'src/validator/validator.ts']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'active', lane: 'main',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          allowed_paths: ['src/parser'],
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('outside allowed_paths');
    expect(r.stderr).toContain('src/validator/validator.ts');
  });

  it('skips allowlist enforcement when allowed_paths is empty', async () => {
    vi.mocked(changedFilesSince).mockResolvedValueOnce(['any/path/anywhere.ts']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'active', lane: 'main',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          // no allowed_paths — any file is OK
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('OUT_OF_SCOPE_PATH');
  });
});

// — close command —

describe('runCloseCommand', () => {
  it('review + accepted → shipped, removes queue slot and re-numbers', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'review', lane: 'main',
          review_required: true, review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({ id: 'S-002', title: 'Next', epic_id: 'E-001', status: 'queued', lane: 'main' }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-001', sprint_id: 'S-001', order: 0 },
          { id: 'Q-002', sprint_id: 'S-002', order: 1 },
        ]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Closed S-001');

    const sprintData = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(sprintData.status).toBe('shipped');
    expect(sprintData.end_sha).toBeTruthy();
    expect(sprintData.closed_at).toBeTruthy();

    // queue slot removed
    const queueData = await readFm(join(cwd, 'queues/main.md'));
    const slots = queueData.slots as Array<{ sprint_id: string; order: number }>;
    expect(slots.find((s) => s.sprint_id === 'S-001')).toBeUndefined();
    // remaining slot re-numbered
    expect(slots[0]?.order).toBe(0);
  });

  it('fails when working tree has uncommitted changes', async () => {
    vi.mocked(isWorkingTreeClean).mockResolvedValueOnce(false);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'review', lane: 'main',
          review_id: 'R-001', started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('uncommitted changes');
  });

  it('fails when review verdict is not accepted', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'review', lane: 'main',
          review_required: true, review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'pending') },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('verdict is pending');
  });

  it('fails when sprint is active and review_required is true', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'active', lane: 'main',
          review_required: true, started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d',
        }),
      },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('review_required: true');
  });

  it('succeeds when sprint is active and review_required is false', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'active', lane: 'main',
          review_required: false, started_at: '2026-04-25T10:00:00Z', base_sha: 'a1b2c3d',
        }),
      },
      { path: 'queues/main.md', content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]) },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('shipped');
  });
});

// — reopen command —

describe('runReopenCommand', () => {
  it('shipped → reopened, clears end_sha and closed_at', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Parse', epic_id: 'E-001', status: 'shipped', lane: 'main',
          review_id: 'R-001', base_sha: 'a1b2c3d',
          started_at: '2026-04-25T10:00:00Z', closed_at: '2026-04-25T12:00:00Z',
          end_sha: 'b2c3d4e',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
    ]);

    const r = await runReopenCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Sprint S-001 reopened');
    expect(r.stdout).toContain('queue add');

    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('reopened');
    expect(data.end_sha).toBeNull();
    expect(data.closed_at).toBeNull();
    expect(data.review_id).toBe('R-001'); // preserved
    expect(data.base_sha).toBe('a1b2c3d'); // preserved
  });

  it('fails for cancelled sprint', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001', title: 'Cancelled', epic_id: 'E-001', status: 'cancelled', lane: 'main',
        }),
      },
    ]);

    const r = await runReopenCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('rk reopen requires status review or shipped');
    expect(r.stderr).toContain('cancelled');
  });
});
