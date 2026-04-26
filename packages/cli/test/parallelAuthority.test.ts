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
});
