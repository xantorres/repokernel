/**
 * Authority enforcement tests for parallel execution CLI flags.
 * Tests that --parallel cannot upgrade a sequential epic, and
 * --allow-overlap is gated by config.
 *
 * Uses makeFixture + vi.mock for controlPaths so no real git repo is needed.
 */
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runRunCommand } from '../src/commands/run.js';
import { isWorktreeCheckout, operationalRoot } from '../src/lifecycle/controlPaths.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

// Mock git-calling utilities — no real git repo needed for authority checks
vi.mock('../src/lifecycle/controlPaths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lifecycle/controlPaths.js')>();
  return {
    ...actual,
    isWorktreeCheckout: vi.fn().mockResolvedValue(false),
    operationalRoot: vi.fn(),
  };
});

afterAll(cleanupAllFixtures);

afterEach(() => {
  vi.mocked(isWorktreeCheckout).mockResolvedValue(false);
});

function epicFm(strategy?: string): string {
  const data: Record<string, unknown> = {
    id: 'E-001',
    title: 'Test Epic',
    status: 'active',
    sprints: [],
    adr_links: [],
  };
  if (strategy !== undefined) data.execution_strategy = strategy;
  return fm(data);
}

async function fixture(strategy?: string): Promise<string> {
  const cwd = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    { path: 'epics/E-001.md', content: epicFm(strategy) },
  ]);
  vi.mocked(operationalRoot).mockResolvedValue(join(cwd, '.repokernel-op'));
  return cwd;
}

describe('authority enforcement', () => {
  it('--parallel on sequential epic returns PARALLEL_UPGRADE_DENIED error', async () => {
    const cwd = await fixture('sequential');
    const result = await runRunCommand({
      cwd,
      epicId: 'E-001',
      agent: 'manual',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
      parallel: true,
    });
    expect(result.stderr).toContain('execution_strategy=sequential');
    expect(result.stderr).toContain('--parallel cannot override');
    expect(result.exitCode).not.toBe(0);
  });

  it('--parallel on parallel epic is accepted silently', async () => {
    const cwd = await fixture('parallel');
    const result = await runRunCommand({
      cwd,
      epicId: 'E-001',
      agent: 'manual',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
      parallel: true,
    });
    // Authority check passes — may error for other reasons (no sprints etc)
    expect(result.stderr).not.toContain('--parallel cannot override');
  });

  it('--allow-overlap without config flag returns OVERLAP_FLAG_DISABLED error', async () => {
    const cwd = await fixture('parallel');
    const result = await runRunCommand({
      cwd,
      epicId: 'E-001',
      agent: 'manual',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
      allowOverlap: true,
    });
    expect(result.stderr).toContain('allowOverlapFlag');
    expect(result.exitCode).not.toBe(0);
  });

  it('epic without execution_strategy defaults to sequential', async () => {
    const cwd = await fixture(); // no strategy → defaults to sequential
    const result = await runRunCommand({
      cwd,
      epicId: 'E-001',
      agent: 'manual',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
      parallel: true,
    });
    expect(result.stderr).toContain('execution_strategy=sequential');
    expect(result.exitCode).not.toBe(0);
  });

  it('--sequential flag accepted on parallel epic (downgrades)', async () => {
    const cwd = await fixture('parallel');
    const result = await runRunCommand({
      cwd,
      epicId: 'E-001',
      agent: 'manual',
      mode: 'assisted',
      worktree: false,
      dryRun: false,
      experimental: false,
      sequential: true,
    });
    // Authority check passes — may error for other reasons
    expect(result.stderr).not.toContain('cannot override');
  });

  it('dry-run chain preview is scoped to the requested epic even when another epic is earlier in the lane queue', async () => {
    const cwd = await makeFixture([
      { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
      {
        path: 'epics/E-001.md',
        content: fm({ id: 'E-001', title: 'Requested', status: 'active', sprints: ['S-001'] }),
      },
      {
        path: 'epics/E-002.md',
        content: fm({ id: 'E-002', title: 'Earlier', status: 'active', sprints: ['S-002'] }),
      },
      {
        path: 'sprints/S-001.md',
        content: fm({
          id: 'S-001',
          title: 'Requested sprint',
          epic_id: 'E-001',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'sprints/S-002.md',
        content: fm({
          id: 'S-002',
          title: 'Wrong epic sprint',
          epic_id: 'E-002',
          status: 'queued',
          lane: 'main',
        }),
      },
      {
        path: 'queues/main.md',
        content: fm({
          lane: 'main',
          slots: [
            { id: 'Q-001', sprint_id: 'S-002', order: 0 },
            { id: 'Q-002', sprint_id: 'S-001', order: 1 },
          ],
        }),
      },
    ]);
    vi.mocked(operationalRoot).mockResolvedValue(join(cwd, '.repokernel-op'));

    const result = await runRunCommand({
      cwd,
      epicId: 'E-001',
      agent: 'manual',
      mode: 'assisted',
      worktree: false,
      dryRun: true,
      experimental: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('S-001 — Requested sprint');
    expect(result.stdout).not.toContain('S-002 — Wrong epic sprint');
  });
});
