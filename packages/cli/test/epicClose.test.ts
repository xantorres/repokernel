import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runEpicCloseCommand } from '../src/commands/epic.js';
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
  changedFilesSince: vi.fn().mockResolvedValue([]),
  changedFilesForSprint: vi.fn().mockResolvedValue({
    files: [],
    committed: [],
    staged: [],
    unstaged: [],
    untracked: [],
  }),
}));

import { changedFilesSince, getCurrentSha, isWorkingTreeClean } from '../src/lifecycle/git.js';

afterAll(cleanupAllFixtures);

afterEach(() => {
  vi.mocked(getCurrentSha).mockResolvedValue('deadbeefcafe1234567890abcdef12345678abcd');
  vi.mocked(isWorkingTreeClean).mockResolvedValue(true);
  vi.mocked(changedFilesSince).mockResolvedValue([]);
});

async function readFm(file: string): Promise<Record<string, unknown>> {
  const raw = await readFile(file, 'utf8');
  return matter(raw).data as Record<string, unknown>;
}

function epicFile(sprintIds: string[], status = 'active') {
  return fm({ id: 'E-001', title: 'Test Epic', status, sprints: sprintIds });
}

function shippedSprint(id: string) {
  return fm({
    id,
    title: `Sprint ${id}`,
    epic_id: 'E-001',
    status: 'shipped',
    lane: 'main',
    // review_required: false — no review file in fixture;
    // avoids SHIPPED_SPRINT_MISSING_REVIEW P1 from refreshRegistry
    review_required: false,
    started_at: '2026-04-25T10:00:00Z',
    base_sha: 'abc1234',
    closed_at: '2026-04-26T10:00:00Z',
    end_sha: 'def5678',
  });
}

function cancelledSprint(id: string) {
  return fm({ id, title: `Sprint ${id}`, epic_id: 'E-001', status: 'cancelled', lane: 'main' });
}

function activeSprint(id: string) {
  return fm({
    id,
    title: `Sprint ${id}`,
    epic_id: 'E-001',
    status: 'active',
    lane: 'main',
    review_required: false,
    started_at: '2026-04-25T10:00:00Z',
    base_sha: 'abc1234',
  });
}

function plannedSprint(id: string) {
  return fm({ id, title: `Sprint ${id}`, epic_id: 'E-001', status: 'planned', lane: 'main' });
}

// — happy path —

describe('runEpicCloseCommand', () => {
  it('closes epic when all sprints are shipped', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
      { path: 'sprints/S-002.md', content: shippedSprint('S-002') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Closed E-001');

    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('done');
    expect(data.closed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('reconciles stale fastpath aliases when closing a synthetic epic', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
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

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('T-001.json');

    const alias = JSON.parse(await readFile(join(cwd, '.repokernel/tasks/T-001.json'), 'utf8')) as {
      status: string;
      closed_at: string | null;
    };
    expect(alias.status).toBe('shipped');
    expect(alias.closed_at).toBe('2026-04-26T10:00:00Z');
  });

  it('closes epic when all sprints are shipped or cancelled', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
      { path: 'sprints/S-002.md', content: cancelledSprint('S-002') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('done');
  });

  it('closes epic with no sprints', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([]) },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('done');
  });

  it('closes a planned epic (no explicit guard on non-active statuses)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([], 'planned') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('done');
  });

  it('closes an on_hold epic', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([], 'on_hold') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).toBe(0);
    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('done');
  });

  // — dry run —

  it('dry-run returns preview without writing', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: true, force: false });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dry-run');
    expect(r.stdout).toContain('No files written');

    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('active');
  });

  it('dry-run with --force shows incomplete count in preview', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
      { path: 'sprints/S-002.md', content: activeSprint('S-002') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: true, force: true });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('dry-run');
    expect(r.stdout).toContain('incomplete: 1');
    expect(r.stdout).toContain('No files written');
  });

  // — error: not found —

  it('returns error when epic not found', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    ]);

    const r = await runEpicCloseCommand('E-999', { cwd, dryRun: false, force: false });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('E-999');
  });

  // — error: already done —

  it('returns error when epic already done', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([], 'done') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('already closed');
  });

  // — error: cancelled —

  it('returns error when epic is cancelled', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile([], 'cancelled') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('cancelled');
  });

  // — error: incomplete sprints —

  it('returns error when sprints are not all shipped (active sprint)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
      { path: 'sprints/S-002.md', content: activeSprint('S-002') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('incomplete sprint');
    expect(r.stderr).toContain('S-002');

    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('active');
  });

  it('returns error when sprint is planned (counts as incomplete)', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: plannedSprint('S-001') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('S-001');
  });

  // — force —

  it('--force closes epic despite incomplete sprints, warns in stdout', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001', 'S-002']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
      { path: 'sprints/S-002.md', content: activeSprint('S-002') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: true });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('--force used');

    const data = await readFm(join(cwd, 'epics/E-001.md'));
    expect(data.status).toBe('done');
  });

  // — output format —

  it('stdout includes git add path for epic file', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      { path: 'epics/E-001.md', content: epicFile(['S-001']) },
      { path: 'sprints/S-001.md', content: shippedSprint('S-001') },
    ]);

    const r = await runEpicCloseCommand('E-001', { cwd, dryRun: false, force: false });

    expect(r.stdout).toContain('git add -- epics/E-001.md');
  });
});

// — run-checks gate —

function makeSpawnMock(exitCode: number) {
  return {
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'close') {
        // schedule via microtask so the Promise constructor in runChecksCommand
        // completes before the listener fires
        Promise.resolve().then(() => cb(exitCode));
      }
      return this;
    },
    stdin: { write: vi.fn(), end: vi.fn() },
  };
}

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';

describe('epic close --run-checks', () => {
  function allShippedFixture(checksCmd?: string) {
    const automationYaml = checksCmd ? `automation:\n  checksCmd: "${checksCmd}"\n` : '';
    const config = `schemaVersion: 1\nprojectId: test\nprojectName: Test\npaths:\n  epics: epics\n  sprints: sprints\n  reviews: reviews\n  queues: queues\n  lanes: lanes\n  generated: .repokernel\n  registry: .repokernel/registry.json\n${automationYaml}`;
    return makeFixture([
      { path: 'repokernel.config.yaml', content: config },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Test Epic', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Sprint S-001',
          epic_id: 'E-001',
          status: 'shipped',
          lane: 'main',
          review_required: false,
          started_at: '2026-04-25T10:00:00Z',
          base_sha: 'abc1234',
          closed_at: '2026-04-26T10:00:00Z',
          end_sha: 'def5678',
        }),
      },
    ]);
  }

  it('--run-checks with no checksCmd → error', async () => {
    const cwd = await allShippedFixture();
    const r = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: false,
      force: false,
      runChecks: true,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no check command configured');
  });

  it('--run-checks with failing command → error', async () => {
    vi.mocked(spawn).mockReturnValueOnce(makeSpawnMock(1) as unknown as ReturnType<typeof spawn>);
    const cwd = await allShippedFixture();
    const r = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: false,
      force: false,
      runChecks: true,
      checksCmd: 'exit 1',
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('checks failed');
  });

  it('--run-checks with passing command → epic closed', async () => {
    vi.mocked(spawn).mockReturnValueOnce(makeSpawnMock(0) as unknown as ReturnType<typeof spawn>);
    const cwd = await allShippedFixture();
    const r = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: false,
      force: false,
      runChecks: true,
      checksCmd: 'exit 0',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Closed E-001');
  });

  it('--dry-run skips check execution even when --run-checks given', async () => {
    const cwd = await allShippedFixture();
    const r = await runEpicCloseCommand('E-001', {
      cwd,
      dryRun: true,
      force: false,
      runChecks: true,
      checksCmd: 'exit 1',
    });
    expect(r.exitCode).toBe(0);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('checksCmd from config is used when --run-checks given without --checks-cmd', async () => {
    vi.mocked(spawn).mockReturnValueOnce(makeSpawnMock(0) as unknown as ReturnType<typeof spawn>);
    const cwd = await allShippedFixture('pnpm test');
    const trustBackup = process.env.REPOKERNEL_TRUST_FILE;
    try {
      await seedTrustForCwd(cwd, { checks_cmd: true });
      const r = await runEpicCloseCommand('E-001', {
        cwd,
        dryRun: false,
        force: false,
        runChecks: true,
      });
      expect(r.exitCode).toBe(0);
      // spawnPolicyEnforced calls spawn with (cmd, args[], options); the policy
      // restricts env to the allowlist and keeps shell:true since checksCmd
      // legitimately needs shell parsing.
      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        'pnpm test',
        [],
        expect.objectContaining({ shell: true }),
      );
    } finally {
      resetTrustForTest(trustBackup);
    }
  });

  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });
});
