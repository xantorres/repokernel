import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runStartCommand } from '../src/commands/lifecycle.js';
import { makeEpicRepo, readFm } from './fakeAgent/helpers.js';

describe('rk start worktree modes', () => {
  it('stays metadata-only when worktree acquisition is disabled', async () => {
    const repo = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const result = await runStartCommand('S-001', {
      cwd: repo,
      force: false,
      enqueue: false,
      dryRun: false,
      json: false,
      worktree: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Worktree');

    const sprint = await readFm(join(repo, 'sprints/S-001.md'));
    expect(sprint.status).toBe('active');
    expect(sprint.base_sha).toBeTruthy();
  });

  it('acquires an isolated sprint worktree when forced on', async () => {
    const repo = await makeEpicRepo({ sprints: [{ id: 'S-001' }] });
    const result = await runStartCommand('S-001', {
      cwd: repo,
      force: false,
      enqueue: false,
      dryRun: false,
      json: false,
      worktree: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Worktree');
    expect(result.stdout).toContain('Branch');
    expect(result.stdout).toContain('rk/sprint/E-001/S-001');

    // The metadata mutation lands inside the acquired worktree, not the main
    // checkout — so the main checkout's sprint file is untouched.
    const mainSprint = await readFm(join(repo, 'sprints/S-001.md'));
    expect(mainSprint.status).toBe('queued');
  });
});
