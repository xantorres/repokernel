import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runGatesCommand } from '../src/commands/gates.js';
import { runInspectCommand } from '../src/commands/inspect.js';
import { runNextCommand } from '../src/commands/next.js';
import { runRegistryCommand } from '../src/commands/registry.js';
import { runStatusCommand } from '../src/commands/status.js';
import { runValidateCommand } from '../src/commands/validate.js';
import { shouldUseEnvBrief } from '../src/format/brief.js';
import { cleanupAllFixtures, defaultConfigYaml, fm, makeFixture } from './helpers/fixture.js';

vi.mock('../src/lifecycle/git.js', () => ({
  changedFilesForSprint: vi.fn().mockResolvedValue({
    files: ['src/index.ts'],
    committed: ['src/index.ts'],
    staged: [],
    unstaged: [],
    untracked: [],
  }),
}));
vi.mock('../src/lifecycle/worktree.js', () => ({
  findSprintWorktreePath: vi.fn().mockResolvedValue(null),
}));

afterAll(cleanupAllFixtures);

const originalBriefEnv = process.env.RK_BRIEF;

afterEach(() => {
  if (originalBriefEnv === undefined) delete process.env.RK_BRIEF;
  else process.env.RK_BRIEF = originalBriefEnv;
});

async function compactProject(): Promise<string> {
  return makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    {
      path: 'epics/E-001.md',
      content: fm({ id: 'E-001', title: 'Compact epic', status: 'active', sprints: ['S-001'] }),
    },
    {
      path: 'sprints/S-001.md',
      content: fm({
        id: 'S-001',
        title: 'Compact sprint',
        epic_id: 'E-001',
        status: 'queued',
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
        reviewer: 'tester',
        findings: [],
        created_at: '2026-05-28T10:00:00Z',
      }),
    },
    {
      path: 'queues/main.md',
      content: fm({ lane: 'main', slots: [{ id: 'Q-001', sprint_id: 'S-001', order: 0 }] }),
    },
    { path: 'lanes/main.md', content: fm({ name: 'main' }) },
  ]);
}

describe('compact rk output', () => {
  it('status --brief --json emits the shared brief contract', async () => {
    const cwd = await compactProject();

    const result = await runStatusCommand({ cwd, json: true, brief: true });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      brief: true,
      command: 'status',
      ok: true,
      initialized: true,
      projectId: 'demo',
      activeEpicId: 'E-001',
      nextSprintId: 'S-001',
    });
  });

  it('next --brief --json emits a stable compact shape', async () => {
    const cwd = await compactProject();

    const result = await runNextCommand({ cwd, json: true, brief: true });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      brief: true,
      command: 'next',
      ok: true,
      result: 'runnable',
      sprintId: 'S-001',
      epicId: 'E-001',
      lane: 'main',
      queueDepth: 1,
      blockers: 0,
      warnings: 0,
    });
  });

  it('validate --brief --json reports counts without dumping findings', async () => {
    const cwd = await compactProject();

    const result = await runValidateCommand({ cwd, json: true, brief: true });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      brief: true,
      command: 'validate',
      ok: true,
      threshold: 'P1',
      blockers: 0,
      warnings: 0,
      findings: 0,
    });
  });

  it('inspect --brief --json reports the requested entity summary', async () => {
    const cwd = await compactProject();

    const result = await runInspectCommand({ cwd, id: 'S-001', json: true, brief: true });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      brief: true,
      command: 'inspect',
      ok: true,
      entityType: 'sprint',
      id: 'S-001',
      status: 'queued',
      title: 'Compact sprint',
      epicId: 'E-001',
      lane: 'main',
      blockers: 0,
      warnings: 0,
    });
  });

  it('gates compact output is explicit and still records a compact gate result', async () => {
    const cwd = await compactProject();
    await runRegistryCommand({ cwd, write: true, check: false, json: false });

    const result = await runGatesCommand('S-001', { cwd, json: true, brief: true });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { command: string; steps: unknown[] };
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      brief: true,
      command: 'gates',
      ok: true,
      sprintId: 'S-001',
      failed: 0,
    });
    expect(parsed.steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'diff-paths', status: 'passed' })]),
    );
  });

  it('RK_BRIEF is only accepted for read-only compact commands', () => {
    process.env.RK_BRIEF = '1';

    expect(shouldUseEnvBrief('status')).toBe(true);
    expect(shouldUseEnvBrief('next')).toBe(true);
    expect(shouldUseEnvBrief('validate')).toBe(true);
    expect(shouldUseEnvBrief('inspect')).toBe(true);
    expect(shouldUseEnvBrief('gates')).toBe(false);
  });
});
