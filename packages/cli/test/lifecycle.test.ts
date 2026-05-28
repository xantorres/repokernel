import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  runCancelCommand,
  runCloseCommand,
  runReopenCommand,
  runReviewCommand,
  runStartCommand,
} from '../src/commands/lifecycle.js';
import {
  cleanupAllFixtures,
  defaultConfigYaml,
  fm,
  makeFixture,
  resetTrustForTest,
  seedTrustForCwd,
} from './helpers/fixture.js';

// mock git utilities so test fixtures don't need a real git repo
vi.mock('../src/lifecycle/git.js', () => ({
  getCurrentSha: vi.fn().mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd'),
  getPublishState: vi.fn().mockResolvedValue({ state: 'no_remote', remotes: [] }),
  isWorkingTreeClean: vi.fn().mockResolvedValue(true),
  changedFilesSince: vi.fn().mockResolvedValue(['src/parser/markdown.ts']),
  changedFilesForSprint: vi.fn().mockResolvedValue({
    files: ['src/parser/markdown.ts'],
    committed: ['src/parser/markdown.ts'],
    staged: [],
    unstaged: [],
    untracked: [],
  }),
}));

import { changedFilesForSprint, getCurrentSha, isWorkingTreeClean } from '../src/lifecycle/git.js';

afterAll(cleanupAllFixtures);

let originalTrustEnv: string | undefined;
afterEach(() => {
  vi.mocked(getCurrentSha).mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd');
  vi.mocked(isWorkingTreeClean).mockResolvedValue(true);
  mockChangedFiles(['src/parser/markdown.ts']);
  resetTrustForTest(originalTrustEnv);
  originalTrustEnv = undefined;
});

function mockChangedFiles(paths: string[]): void {
  vi.mocked(changedFilesForSprint).mockResolvedValue({
    files: paths,
    committed: paths,
    staged: [],
    unstaged: [],
    untracked: [],
  });
}

function mockChangedFilesOnce(paths: string[]): void {
  vi.mocked(changedFilesForSprint).mockResolvedValueOnce({
    files: paths,
    committed: paths,
    staged: [],
    unstaged: [],
    untracked: [],
  });
}

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
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runStartCommand('S-001', {
      cwd,
      force: false,
      dryRun: false,
      json: false,
      enqueue: false,
      // Hermetic: don't let start.worktree: auto acquire a worktree based on
      // ambient env (CI has no agent markers; a dev shell does).
      worktree: false,
    });
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
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runStartCommand('S-001', {
      cwd,
      force: false,
      dryRun: false,
      json: false,
      enqueue: false,
    });
    expect(r.exitCode).toBe(1);
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
        content: fm({
          id: 'S-001',
          title: 'Dep',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Target',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
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

    const r = await runStartCommand('S-002', {
      cwd,
      force: false,
      dryRun: false,
      json: false,
      enqueue: false,
    });
    expect(r.exitCode).toBe(1);
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
          id: 'S-001',
          title: 'Active one',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'abc1234',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Queued',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([
          { id: 'Q-002', sprint_id: 'S-002', order: 0 }, // S-002 at head
        ]),
      },
    ]);

    const r = await runStartCommand('S-002', {
      cwd,
      force: false,
      dryRun: false,
      json: false,
      enqueue: false,
    });
    expect(r.exitCode).toBe(1);
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
          id: 'S-001',
          title: 'Gated',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
          gate: 'human_review',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runStartCommand('S-001', {
      cwd,
      force: false,
      dryRun: false,
      json: false,
      enqueue: false,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unresolved gate: human_review');
  });

  it('--force allows starting a planned sprint with a loud warning', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Planned',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runStartCommand('S-001', {
      cwd,
      force: true,
      dryRun: false,
      json: false,
      enqueue: false,
    });
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
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
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
    mockChangedFilesOnce([]);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no changes since base_sha');
    expect(r.stderr).toContain('commit your implementation');
  });

  it('fails when a modified file matches denied_paths', async () => {
    mockChangedFilesOnce(['.repokernel/plan/sprints/S-002.md']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          denied_paths: ['.repokernel/plan/sprints'],
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('modified denied path');
    expect(r.stderr).toContain('.repokernel/plan/sprints/S-002.md');
  });

  it('fails when a file is outside allowed_paths', async () => {
    mockChangedFilesOnce(['src/parser/parser.ts', 'src/validator/validator.ts']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          allowed_paths: ['src/parser'],
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('outside allowed_paths');
    expect(r.stderr).toContain('src/validator/validator.ts');
  });

  it('exempts the current sprint frontmatter from allowed_paths check', async () => {
    // `rk start` writes the sprint's own frontmatter before implementation
    // begins. That exact file is lifecycle metadata; broader plan-state files
    // are not exempted.
    mockChangedFilesOnce(['src/parser/parser.ts', 'sprints/S-001.md']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          allowed_paths: ['src/parser'],
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('outside allowed_paths');
  });

  it('exempts the linked review file from allowed_paths check', async () => {
    mockChangedFilesOnce(['src/parser/parser.ts', 'reviews/R-001.md']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          allowed_paths: ['src/parser'],
          review_id: 'R-001',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'pending') },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('outside allowed_paths');
  });

  it('still enforces allowed_paths on non-plan-state files when plan-state is mixed in', async () => {
    mockChangedFilesOnce(['sprints/S-001.md', 'src/validator/validator.ts']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          allowed_paths: ['src/parser'],
        }),
      },
    ]);

    const r = await runReviewCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('outside allowed_paths');
    expect(r.stderr).toContain('src/validator/validator.ts');
  });

  it('skips allowlist enforcement when allowed_paths is empty', async () => {
    mockChangedFilesOnce(['any/path/anywhere.ts']);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
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
  it('runs configured checks before sprint→shipped flip; close fails when checks fail', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}automation:\n  checksCmd: "exit 1"\n`,
      },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    await seedTrustForCwd(cwd, { checks_cmd: true });

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('configured checks failed');

    // sprint must NOT have been mutated to shipped
    const sprintData = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(sprintData.status).toBe('review');
  });

  it('--skip-checks bypasses the configured checks gate', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}automation:\n  checksCmd: "exit 1"\n`,
      },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', {
      cwd,
      dryRun: false,
      json: false,
      skipChecks: true,
    });
    expect(r.exitCode).toBe(0);
    const sprintData = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(sprintData.status).toBe('shipped');
  });

  it('review + accepted → shipped, removes queue slot and re-numbers', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Next',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
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

  it('reports structured phases and a baseline-aware warning summary on close', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: true });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout) as {
      data: {
        phases: Array<{ name: string; status: string; ms: number }>;
        warning_summary: { new: number; baseline_suppressed: number };
      };
    };
    const phaseNames = env.data.phases.map((p) => p.name);
    expect(phaseNames).toEqual(['precheck', 'checks', 'mutate', 'commit']);
    for (const p of env.data.phases) {
      expect(typeof p.ms).toBe('number');
      expect(['ok', 'skipped']).toContain(p.status);
    }
    expect(typeof env.data.warning_summary.new).toBe('number');
    expect(env.data.warning_summary.new).toBeGreaterThanOrEqual(0);
    // No warnings-baseline.json present in the fixture, so nothing is suppressed.
    expect(env.data.warning_summary.baseline_suppressed).toBe(0);
  });

  it('prints a Phases line in human close output', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);
    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Phases:');
    expect(r.stdout).toMatch(/precheck \d+ms/);
  });

  it('updates the linked T-NNN alias when closing a fastpath sprint directly', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Fastpath sprint',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          review_required: false,
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
          extras: { task_id: 'T-001', fastpath: true },
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
      {
        path: '.repokernel/tasks/T-001.json',
        content: `${JSON.stringify(
          {
            id: 'T-001',
            epic_id: 'E-001',
            sprint_id: 'S-001',
            source: 'inline',
            title: 'Fastpath sprint',
            created_at: '2026-04-25T10:00:00.000Z',
            closed_at: null,
            status: 'active',
          },
          null,
          2,
        )}\n`,
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('T-001.json');

    const alias = JSON.parse(await readFile(join(cwd, '.repokernel/tasks/T-001.json'), 'utf8')) as {
      status: string;
      closed_at: string | null;
    };
    expect(alias.status).toBe('shipped');
    expect(alias.closed_at).toBeTruthy();
  });

  it('surfaces newly-unblocked planned sprints in the close output', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'First',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Depends on S-001',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          depends_on: ['S-001'],
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Newly unblocked:');
    expect(r.stdout).toContain('S-002');
    expect(r.stdout).toContain('rk queue add S-002');
  });

  it('omits the newly-unblocked section when no planned sprint became runnable', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Solo',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d4e5f6789012345678901234567890abcd',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('Newly unblocked');
    expect(r.stdout).toContain('rk next');
  });

  it('fails when working tree has uncommitted changes', async () => {
    vi.mocked(isWorkingTreeClean).mockResolvedValueOnce(false);

    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('uncommitted changes');
  });

  it('fails when review verdict is not accepted', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_required: true,
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'pending') },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('verdict is pending');
  });

  it('fails when sprint is active and review_required is true', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          review_required: true,
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('review_required: true');
  });

  it('succeeds when sprint is active and review_required is false', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          review_required: false,
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('shipped');
  });

  it('blocks close when policy threshold flips review-required and no review exists', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}policies:\n  requireReviewForShippedFromSprintId: 1\n`,
      },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          review_required: false,
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'a1b2c3d',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCloseCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('requires a review');
    expect(r.stderr).toContain('requireReviewForShippedFromSprintId');
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
          id: 'S-001',
          title: 'Parse',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          review_id: 'R-001',
          base_sha: 'a1b2c3d',
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T12:00:00Z',
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

  it('reopens a cancelled sprint to planned and clears stale lifecycle metadata', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Cancelled',
          epic_id: 'E-001',
          status: 'cancelled',
          lane: 'main',
          cancel_reason: 'manual',
          review_id: 'R-001',
          started_at: '2026-04-25T10:00:00Z',
          closed_at: '2026-04-25T12:00:00Z',
          base_sha: 'a1b2c3d',
          end_sha: 'b2c3d4e',
        }),
      },
      { path: 'reviews/R-001.md', content: reviewFile('R-001', 'S-001', 'accepted') },
    ]);

    const r = await runReopenCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('planned');
    const sprintFile = await import('node:fs/promises').then((fs) =>
      fs.readFile(`${cwd}/sprints/S-001.md`, 'utf8'),
    );
    expect(sprintFile).toContain('status: planned');
    expect(sprintFile).not.toContain('cancel_reason:');
    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.review_id).toBeNull();
    expect(data.started_at).toBeNull();
    expect(data.closed_at).toBeNull();
    expect(data.base_sha).toBeNull();
    expect(data.end_sha).toBeNull();
  });
});

// — cancel command —

describe('runCancelCommand', () => {
  it('cancels an active sprint, captures cancel_reason and closed_at', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Stale active',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'abc1234',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCancelCommand('S-001', {
      cwd,
      reason: 'no work; abandoned',
      dryRun: false,
      json: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Cancelled S-001');
    expect(r.stdout).toContain('no work; abandoned');

    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('cancelled');
    expect(data.cancel_reason).toBe('no work; abandoned');
    expect(data.closed_at).toBeTruthy();
    // base_sha must be preserved (audit trail)
    expect(data.base_sha).toBe('abc1234');
  });

  it('defaults reason to "manual" when --reason is omitted', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Planned',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runCancelCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('cancelled');
    expect(data.cancel_reason).toBe('manual');
  });

  it('cancel of stale-active unblocks rk start on next queued sprint in same lane', async () => {
    // S-001 is active but not in the queue (typical stale-active scenario);
    // S-002 alone is in the queue at head. Without cancel, lane-active blocks
    // S-002 from starting; after cancel, the lane is free.
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Stale',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'abc1234',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Next',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-002', sprint_id: 'S-002', order: 0 }]),
      },
    ]);

    // start S-002 blocked first
    const blocked = await runStartCommand('S-002', {
      cwd,
      force: false,
      dryRun: false,
      json: false,
      enqueue: false,
    });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain('already active in lane main');

    // cancel the stale-active S-001
    const cancelled = await runCancelCommand('S-001', {
      cwd,
      reason: 'no work',
      dryRun: false,
      json: false,
    });
    expect(cancelled.exitCode).toBe(0);

    // now start S-002 succeeds
    const started = await runStartCommand('S-002', {
      cwd,
      force: false,
      dryRun: false,
      json: false,
      enqueue: false,
      // Hermetic: don't acquire a worktree based on ambient env.
      worktree: false,
    });
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain('Started S-002');
  });

  it('rejects cancelling a shipped sprint', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Done',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          base_sha: 'abc1234',
          end_sha: 'def5678',
          closed_at: '2026-04-25T11:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runCancelCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('cannot transition a shipped sprint');
    expect(r.stderr).toContain('rk reopen');
  });

  it('rejects cancelling an already-cancelled sprint (idempotent guard)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Already gone',
          epic_id: 'E-001',
          status: 'cancelled',
          lane: 'main',
          closed_at: '2026-04-25T11:00:00Z',
          cancel_reason: 'previous',
        }),
      },
      { path: 'queues/main.md', content: queueFile([]) },
    ]);

    const r = await runCancelCommand('S-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('already cancelled');
  });

  it('--dry-run does not write', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Active',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'abc1234',
        }),
      },
      {
        path: 'queues/main.md',
        content: queueFile([{ id: 'Q-001', sprint_id: 'S-001', order: 0 }]),
      },
    ]);

    const r = await runCancelCommand('S-001', { cwd, dryRun: true, json: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dry-run: cancel');
    const data = await readFm(join(cwd, 'sprints/S-001.md'));
    expect(data.status).toBe('active');
  });

  it('rejects when an epic id is passed', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([]) },
    ]);
    const r = await runCancelCommand('E-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('E-001 is an epic');
    expect(r.stderr).toContain('rk cancel S-NNN');
  });
});

// — epic ID passed to sprint commands —

describe('epic ID hint', () => {
  async function minimalFixture() {
    return makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([]) },
    ]);
  }

  it('rk start E-001 → hints to use rk start S-NNN', async () => {
    const cwd = await minimalFixture();
    const r = await runStartCommand('E-001', {
      cwd,
      dryRun: false,
      json: false,
      force: false,
      enqueue: false,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('E-001 is an epic');
    expect(r.stderr).toContain('rk start S-NNN');
  });

  it('rk review E-001 → hints to use rk review S-NNN', async () => {
    const cwd = await minimalFixture();
    const r = await runReviewCommand('E-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('E-001 is an epic');
    expect(r.stderr).toContain('rk review S-NNN');
  });

  it('rk close E-001 → hints to use rk epic close E-001', async () => {
    const cwd = await minimalFixture();
    const r = await runCloseCommand('E-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('E-001 is an epic');
    expect(r.stderr).toContain('rk epic close E-001');
  });

  it('rk reopen E-001 → hints to use rk reopen S-NNN', async () => {
    const cwd = await minimalFixture();
    const r = await runReopenCommand('E-001', { cwd, dryRun: false, json: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('E-001 is an epic');
    expect(r.stderr).toContain('rk reopen S-NNN');
  });
});
