import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runGatesCommand } from '../src/commands/gates.js';
import { runPlanCommand } from '../src/commands/plan.js';
import { runRegistryCommand } from '../src/commands/registry.js';
import { runReviewEvidenceCommand } from '../src/commands/reviewEvidence.js';
import { runShipCommand } from '../src/commands/ship.js';
import { runWaveCommand } from '../src/commands/wave.js';
import {
  cleanupAllFixtures,
  defaultConfigYaml,
  fm,
  makeFixture,
  resetTrustForTest,
  seedTrustForCwd,
} from './helpers/fixture.js';

vi.mock('../src/lifecycle/git.js', () => ({
  getCurrentSha: vi.fn().mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd'),
  getPublishState: vi.fn().mockResolvedValue({ state: 'no_remote', remotes: [] }),
  isWorkingTreeClean: vi.fn().mockResolvedValue(true),
  changedLineCountForSprint: vi.fn().mockResolvedValue(12),
  changedFilesSince: vi.fn().mockResolvedValue(['src/app.ts']),
  changedFilesForSprint: vi.fn().mockResolvedValue({
    files: ['src/app.ts'],
    committed: ['src/app.ts'],
    staged: [],
    unstaged: [],
    untracked: [],
  }),
}));
vi.mock('../src/lifecycle/worktree.js', () => ({
  findSprintWorktreePath: vi.fn().mockResolvedValue(null),
}));

import {
  changedFilesForSprint,
  changedFilesSince,
  changedLineCountForSprint,
  getCurrentSha,
  isWorkingTreeClean,
} from '../src/lifecycle/git.js';
import { findSprintWorktreePath } from '../src/lifecycle/worktree.js';

afterAll(cleanupAllFixtures);

let originalTrustEnv: string | undefined;
afterEach(() => {
  vi.mocked(getCurrentSha).mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd');
  vi.mocked(isWorkingTreeClean).mockResolvedValue(true);
  vi.mocked(changedFilesSince).mockResolvedValue(['src/app.ts']);
  vi.mocked(changedFilesForSprint).mockResolvedValue({
    files: ['src/app.ts'],
    committed: ['src/app.ts'],
    staged: [],
    unstaged: [],
    untracked: [],
  });
  vi.mocked(changedLineCountForSprint).mockResolvedValue(12);
  vi.mocked(findSprintWorktreePath).mockResolvedValue(null);
  resetTrustForTest(originalTrustEnv);
  originalTrustEnv = undefined;
});

function config(extra = ''): string {
  return `${defaultConfigYaml()}automation:
  defaultReviewer: codex
${extra}`;
}

const AUTO_REVIEW_CONFIG = `review:
  auto:
    when: gates_green
`;

async function readFm(cwd: string, path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(cwd, path), 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

describe('v1.18 ceremony commands', () => {
  it('rk ship reviews, accepts, closes, validates, checks registry, and records evidence', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Ship flow', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Implement feature',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          started_at: '2026-05-18T08:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runShipCommand('S-001', { cwd, dryRun: false, json: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Ship S-001');
    expect(result.stdout).toContain('allowed_paths');
    expect(result.stdout).toContain('registry --check');

    const sprint = await readFm(cwd, 'sprints/S-001.md');
    expect(sprint.status).toBe('shipped');
    expect(sprint.review_id).toBe('R-001');

    const review = await readFm(cwd, 'reviews/R-001.md');
    expect(review.reviewer).toBe('codex');
    expect(review.verdict).toBe('accepted');
    expect(review.command_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'review-sprint', status: 'passed' }),
        expect.objectContaining({ label: 'validate', status: 'passed' }),
        expect.objectContaining({ label: 'registry-check', status: 'passed' }),
      ]),
    );
  });

  it('rk ship --evidence-cmd records passing command evidence before close', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config(AUTO_REVIEW_CONFIG) },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Evidence flow', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Close with evidence',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          started_at: '2026-05-18T08:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runShipCommand('S-001', {
      cwd,
      dryRun: false,
      json: false,
      evidenceCommand: 'node -e "console.log(123)"',
      evidenceLabel: 'focused-test',
      evidenceTimeoutSeconds: 5,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('focused-test');

    const review = await readFm(cwd, 'reviews/R-001.md');
    expect(review.command_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'focused-test', status: 'passed' }),
      ]),
    );
  });

  it('rk ship --evidence-cmd blocks close when evidence fails', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config(AUTO_REVIEW_CONFIG) },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Evidence fail', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Failing evidence',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          started_at: '2026-05-18T08:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runShipCommand('S-001', {
      cwd,
      dryRun: false,
      json: false,
      evidenceCommand: 'node -e "process.exit(7)"',
      evidenceLabel: 'focused-test',
      evidenceTimeoutSeconds: 5,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('focused-test');

    const sprint = await readFm(cwd, 'sprints/S-001.md');
    expect(sprint.status).not.toBe('shipped');
  });

  it('rk ship --evidence-cmd requires gates_green auto-review policy before creating a verdict', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Evidence policy',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Policy blocked evidence',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          started_at: '2026-05-18T08:00:00Z',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
      },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runShipCommand('S-001', {
      cwd,
      dryRun: false,
      json: false,
      evidenceCommand: 'node -e "console.log(123)"',
      evidenceTimeoutSeconds: 5,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('auto-review-policy');
    const sprint = await readFm(cwd, 'sprints/S-001.md');
    expect(sprint.status).toBe('active');
  });

  it('rk gates uses configured checks when present, runs RK checks, and records evidence', async () => {
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: config('  checksCmd: "node -e \\"process.exit(0)\\""\n'),
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Gates flow', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Run gates',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    await seedTrustForCwd(cwd, { checks_cmd: true });

    const result = await runGatesCommand('S-001', { cwd, json: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Gates S-001');
    expect(result.stdout).toContain('configured-checks');
    expect(result.stdout).toContain('allowed_paths');

    const review = await readFm(cwd, 'reviews/R-001.md');
    expect(review.command_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'configured-checks', status: 'passed' }),
        expect.objectContaining({ label: 'diff-paths', status: 'passed' }),
        expect.objectContaining({ label: 'registry-check', status: 'passed' }),
      ]),
    );
  });

  it('rk gates fails closed when base_sha is missing', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Missing base', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'No base sha',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('base_sha');
  });

  it('rk gates validates diffs from the sprint worktree when registered', async () => {
    vi.mocked(findSprintWorktreePath).mockResolvedValue('/tmp/rk-sprint-worktree');
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Worktree gates', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Worktree sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: false });

    expect(result.exitCode).toBe(0);
    expect(changedFilesForSprint).toHaveBeenCalledWith('/tmp/rk-sprint-worktree', 'abc1234');
  });

  it('rk gates fails when sprint budget max_files is exceeded', async () => {
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['src/a.ts', 'src/b.ts'],
      committed: ['src/a.ts', 'src/b.ts'],
      staged: [],
      unstaged: [],
      untracked: [],
    });
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Budget gates', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Too wide',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          budget: { max_files: 1 },
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('budget max_files exceeded');
  });

  it('rk gates fails when sprint budget max_loc is exceeded', async () => {
    vi.mocked(changedLineCountForSprint).mockResolvedValue(42);
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Budget loc', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Too large',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          budget: { max_loc: 12 },
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('budget max_loc exceeded');
  });

  it('rk gates exempts RepoKernel plan-state paths from the diff-scope gate', async () => {
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['reviews/R-999.md'],
      committed: ['reviews/R-999.md'],
      staged: [],
      unstaged: [],
      untracked: [],
    });
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Plan-state drift',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Scoped sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: false });

    // RK-owned state files are machine-managed; the lifecycle legitimately
    // writes sibling review/queue/sprint files during a run. They must not be
    // gated against the user's allowed_paths.
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('outside allowed_paths');
  });

  it('rk gates JSON classifies committed files outside sprint scope as blockers', async () => {
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['src/app.ts', 'server/api.ts'],
      committed: ['src/app.ts', 'server/api.ts'],
      staged: [],
      unstaged: [],
      untracked: [],
    });
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Scope gate', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Scoped sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: true });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      error: { details: { blockers: unknown[]; steps: Array<{ label: string }> } };
      next_actions: string[];
    };
    expect(parsed.error.details.blockers).toEqual([
      expect.objectContaining({
        category: 'out_of_scope_committed',
        scope: 'sprint',
        paths: ['server/api.ts'],
      }),
    ]);
    expect(parsed.next_actions).toEqual(
      expect.arrayContaining(['rk inspect S-001', 'rk blockers S-001 --json']),
    );
  });

  it('rk gates reports uncommitted external dirt without blocking sprint scope', async () => {
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['src/app.ts', 'scratch.txt'],
      committed: ['src/app.ts'],
      staged: [],
      unstaged: ['scratch.txt'],
      untracked: [],
    });
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'External dirty',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Scoped sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: true });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      data: { warnings: unknown[] };
      warnings: unknown[];
    };
    expect(parsed.data.warnings).toEqual([
      expect.objectContaining({
        category: 'external_dirty',
        scope: 'workspace',
        paths: ['scratch.txt'],
      }),
    ]);
    expect(parsed.warnings).toEqual(parsed.data.warnings);
  });

  it('rk gates classifies configured-check failures from sprint-owned paths', async () => {
    const command = `${process.execPath} -e "console.error('src/app.ts:12: bad'); process.exit(2)"`;
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: config(`  checksCmd: ${JSON.stringify(command)}\n`),
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'In-scope check', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Owned failure',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    await seedTrustForCwd(cwd, { checks_cmd: true });

    const result = await runGatesCommand('S-001', { cwd, json: true });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      error: { details: { blockers: unknown[] } };
      next_actions: string[];
    };
    expect(parsed.error.details.blockers).toEqual([
      expect.objectContaining({
        category: 'in_scope',
        scope: 'sprint',
        paths: ['src/app.ts'],
      }),
    ]);
    expect(parsed.next_actions).toEqual(
      expect.arrayContaining(['rk gates S-001 --profile focused --explain']),
    );
  });

  it('rk gates classifies configured-check failures without paths as environment', async () => {
    const command = `${process.execPath} -e "console.error('toolchain failed'); process.exit(2)"`;
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: config(`  checksCmd: ${JSON.stringify(command)}\n`),
      },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Environment check',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Unknown failure',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    await seedTrustForCwd(cwd, { checks_cmd: true });

    const result = await runGatesCommand('S-001', { cwd, json: true });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      error: { details: { blockers: unknown[] } };
      next_actions: string[];
    };
    expect(parsed.error.details.blockers).toEqual([
      expect.objectContaining({
        category: 'environment',
        scope: 'environment',
        paths: [],
      }),
    ]);
    expect(parsed.next_actions).toEqual(
      expect.arrayContaining(['rk gates S-001 --profile focused --explain']),
    );
  });

  it('rk gates extracts root-file paths from configured-check output', async () => {
    const command = `${process.execPath} -e "console.error('package.json:1: bad'); process.exit(2)"`;
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: config(`  checksCmd: ${JSON.stringify(command)}\n`),
      },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Root check', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Root owned failure',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['package.json'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    await seedTrustForCwd(cwd, { checks_cmd: true });

    const result = await runGatesCommand('S-001', { cwd, json: true });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      error: { details: { blockers: unknown[] } };
    };
    expect(parsed.error.details.blockers).toEqual([
      expect.objectContaining({
        category: 'in_scope',
        paths: ['package.json'],
      }),
    ]);
  });

  it('rk gates routes out-of-scope configured-check failures toward focused recovery', async () => {
    const command = `${process.execPath} -e "console.error('tests/e2e/opportunities.spec.ts:1: stale'); process.exit(2)"`;
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: config(`  checksCmd: ${JSON.stringify(command)}\n`),
      },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Out-of-scope check',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'External failure',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });
    originalTrustEnv = process.env.REPOKERNEL_TRUST_FILE;
    await seedTrustForCwd(cwd, { checks_cmd: true });

    const result = await runGatesCommand('S-001', { cwd, json: true });

    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      error: { details: { blockers: unknown[] } };
      next_actions: string[];
    };
    expect(parsed.error.details.blockers).toEqual([
      expect.objectContaining({
        category: 'out_of_scope_committed',
        paths: ['tests/e2e/opportunities.spec.ts'],
      }),
    ]);
    expect(parsed.next_actions).toEqual(
      expect.arrayContaining(['rk gates S-001 --profile focused --explain']),
    );
  });

  it('rk gates --explain returns planned focused steps without executing them', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Explain gates', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Explain sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runGatesCommand('S-001', {
      cwd,
      json: true,
      profile: 'focused',
      explain: true,
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      data: { explain: boolean; steps: Array<{ label: string; status: string }> };
    };
    expect(parsed.data.explain).toBe(true);
    expect(parsed.data.steps).toEqual([
      { label: 'configured-checks', status: 'skipped' },
      { label: 'diff-paths', status: 'planned' },
      { label: 'validate', status: 'planned' },
      { label: 'registry-check', status: 'planned' },
    ]);
  });

  it('rk ship re-checks path policy for sprints already in review', async () => {
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['forbidden/file.ts'],
      committed: ['forbidden/file.ts'],
      staged: [],
      unstaged: [],
      untracked: [],
    });
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Late scope drift',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Already reviewed',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runShipCommand('S-001', { cwd, dryRun: false, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('outside allowed_paths');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('review');
  });

  it('rk ship refuses to overwrite an explicit negative review verdict', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Negative verdict',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Rejected sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'changes_requested',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runShipCommand('S-001', { cwd, dryRun: false, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('changes_requested');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('review');
    expect((await readFm(cwd, 'reviews/R-001.md')).verdict).toBe('changes_requested');
  });

  it('rk ship blocks on uncommitted in-scope changes before ship-owned metadata writes', async () => {
    // S-001 is scoped to src/**; an uncommitted in-scope edit must block ship.
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['src/app.ts'],
      committed: [],
      staged: [],
      unstaged: ['src/app.ts'],
      untracked: [],
    });
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Dirty ship', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Dirty sprint',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          started_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runShipCommand('S-001', { cwd, dryRun: false, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('uncommitted in-scope changes');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('active');
    await expect(readFile(join(cwd, 'reviews/R-001.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rk ship dry-run runs non-mutating eligibility checks', async () => {
    vi.mocked(changedFilesForSprint).mockResolvedValue({
      files: ['forbidden/file.ts'],
      committed: ['forbidden/file.ts'],
      staged: [],
      unstaged: [],
      untracked: [],
    });
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Dry path drift', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Already reviewed',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          allowed_paths: ['src'],
          base_sha: 'abc1234',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'accepted',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runShipCommand('S-001', { cwd, dryRun: true, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('outside allowed_paths');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('review');
    expect((await readFm(cwd, 'reviews/R-001.md')).command_evidence).toBeUndefined();
  });

  it('rk ship dry-run checks active sprint review eligibility', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Dry active gate',
          status: 'active',
          sprints: ['S-001'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Active without base',
          epic_id: 'E-001',
          status: 'active',
          lane: 'main',
          allowed_paths: ['src'],
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runShipCommand('S-001', { cwd, dryRun: true, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('base_sha');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('active');
  });

  it('rk review-evidence appends manual command evidence through sprint or review id', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Evidence', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Evidence sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'pending',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
    ]);

    const result = await runReviewEvidenceCommand('S-001', {
      cwd,
      label: 'focused_tests',
      command: 'pnpm test -- filter',
      exitCode: 0,
      summary: 'focused tests passed',
      json: false,
    });

    expect(result.exitCode).toBe(0);
    const review = await readFm(cwd, 'reviews/R-001.md');
    expect(review.command_evidence).toEqual([
      expect.objectContaining({
        label: 'focused_tests',
        command: 'pnpm test -- filter',
        exit_code: 0,
        status: 'passed',
      }),
    ]);
  });

  it('rk review-evidence rejects blank evidence fields before writing', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Evidence', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Evidence sprint',
          epic_id: 'E-001',
          status: 'review',
          lane: 'main',
          review_id: 'R-001',
        }),
      },
      {
        path: 'reviews/R-001.md',
        content: fm({
          id: 'R-001',
          sprint_id: 'S-001',
          verdict: 'pending',
          reviewer: 'codex',
          findings: [],
          created_at: '2026-05-18T08:00:00Z',
        }),
      },
    ]);

    const result = await runReviewEvidenceCommand('S-001', {
      cwd,
      label: ' ',
      command: ' ',
      exitCode: 0,
      json: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('label');
    expect((await readFm(cwd, 'reviews/R-001.md')).command_evidence).toBeUndefined();
  });

  it('rk plan creates one queued sprint from a straightforward epic when requested', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm(
          { id: 'E-001', title: 'Add settings panel', status: 'active', sprints: [] },
          '## Objective\n\nAdd a focused settings panel.\n',
        ),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runPlanCommand('E-001', {
      cwd,
      createSprint: true,
      enqueue: true,
      singleSprint: true,
      split: false,
      noSprint: false,
      allowedPaths: ['src/settings'],
      yes: false,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const obj = JSON.parse(result.stdout) as { sprintId: string; mode: string };
    expect(obj.mode).toBe('single');
    expect(obj.sprintId).toBe('S-001');

    const sprint = await readFm(cwd, 'sprints/S-001.md');
    expect(sprint.status).toBe('queued');
    expect(sprint.allowed_paths).toEqual(['src/settings']);
  });

  it('rk plan honors --single-sprint for broad epic bodies', async () => {
    const broadBody = [
      '## Objective',
      '',
      '- One',
      '- Two',
      '- Three',
      '- Four',
      '- Five',
      '- Six',
      '- Seven',
      '- Eight',
      '- Nine',
    ].join('\n');
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Broad epic', status: 'active', sprints: [] }, broadBody),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runPlanCommand('E-001', {
      cwd,
      createSprint: true,
      enqueue: false,
      singleSprint: true,
      split: false,
      noSprint: false,
      allowedPaths: ['src/broad'],
      yes: false,
      json: true,
    });

    expect(result.exitCode).toBe(0);
    const obj = JSON.parse(result.stdout) as { sprintId: string; mode: string };
    expect(obj.mode).toBe('single');
    expect(obj.sprintId).toBe('S-001');
  });

  it('rk wave previews by default and apply queues eligible planned sprints', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Wave one', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Eligible',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const preview = await runWaveCommand('E-001', {
      cwd,
      apply: false,
      createSprint: false,
      enqueue: true,
      json: true,
    });
    expect(preview.exitCode).toBe(0);
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('planned');

    const applied = await runWaveCommand('E-001', {
      cwd,
      apply: true,
      createSprint: false,
      enqueue: true,
      json: true,
    });
    expect(applied.exitCode).toBe(0);
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('queued');
  });

  it('rk wave deduplicates repeated epic selectors before applying', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Duplicate wave', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Eligible once',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const applied = await runWaveCommand('E-001,E-001', {
      cwd,
      apply: true,
      createSprint: false,
      enqueue: true,
      json: true,
    });

    expect(applied.exitCode).toBe(0);
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('queued');
    const obj = JSON.parse(applied.stdout) as {
      epics: Array<{ epicId: string; applied: string[] }>;
    };
    expect(obj.epics).toHaveLength(1);
    expect(obj.epics[0]?.applied).toEqual(['S-001']);
  });

  it('rk wave uses core readiness semantics for gates and blocked_by', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Readiness wave',
          status: 'active',
          sprints: ['S-000', 'S-001', 'S-002', 'S-003'],
        }),
      },
      {
        path: 'sprints/S-000.md',
        content: fm({
          id: 'S-000',
          title: 'Cancelled upstream',
          epic_id: 'E-001',
          status: 'cancelled',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Blocked by cancelled upstream',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          blocked_by: ['S-000'],
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Gated sprint',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
          gate: 'human_approval',
        }),
      },
      {
        path: 'sprints/S-003.md',
        content: fm({
          id: 'S-003',
          title: 'Eligible',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const applied = await runWaveCommand('E-001', {
      cwd,
      apply: true,
      createSprint: false,
      enqueue: true,
      json: true,
    });

    expect(applied.exitCode).toBe(0);
    const obj = JSON.parse(applied.stdout) as {
      epics: Array<{ applied: string[]; blocked: Array<{ sprintId: string; reason: string }> }>;
    };
    expect(obj.epics[0]?.applied).toEqual(['S-003']);
    expect(obj.epics[0]?.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sprintId: 'S-001', reason: expect.stringContaining('S-000') }),
        expect.objectContaining({
          sprintId: 'S-002',
          reason: expect.stringContaining('human_approval'),
        }),
      ]),
    );
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('planned');
    expect((await readFm(cwd, 'sprints/S-002.md')).status).toBe('planned');
    expect((await readFm(cwd, 'sprints/S-003.md')).status).toBe('queued');
  });

  it('rk wave preflights before mutating when a selected sprint cannot be queued', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      {
        path: 'epics/E-001.md',
        content: fm({
          id: 'E-001',
          title: 'Partial wave',
          status: 'active',
          sprints: ['S-001', 'S-002'],
        }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Eligible',
          epic_id: 'E-001',
          status: 'planned',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Pending',
          epic_id: 'E-001',
          status: 'pending',
          lane: 'main',
        }),
      },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const applied = await runWaveCommand('E-001', {
      cwd,
      apply: true,
      createSprint: false,
      enqueue: true,
      json: false,
    });

    expect(applied.exitCode).not.toBe(0);
    expect(applied.stderr).toContain('pending');
    expect((await readFm(cwd, 'sprints/S-001.md')).status).toBe('planned');
  });

  it('rk wave rejects --create-sprint until missing-sprint planning is supported', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: config() },
      { path: 'epics/E-001.md', content: fm({ id: 'E-001', title: 'Wave', status: 'active' }) },
      { path: 'queues/main.md', content: fm({ lane: 'main', slots: [] }) },
    ]);

    const result = await runWaveCommand('E-001', {
      cwd,
      apply: true,
      createSprint: true,
      enqueue: true,
      json: false,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--create-sprint');
  });
});
