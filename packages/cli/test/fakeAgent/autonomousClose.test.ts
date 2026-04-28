/**
 * Autonomous-mode close path: review→close in one loop iteration must leave a
 * clean working tree. Without staging the review-side mutations between the
 * two phases, runCloseCommand would refuse on a dirty tree even though the
 * dirt is RepoKernel's own metadata.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runRunCommand } from '../../src/commands/run.js';
import { findRunId, git, loadRunFile, makeEpicRepo, readFm, removeRepo } from './helpers.js';

const execFileAsync = promisify(execFile);

let repoDir: string;

afterEach(async () => {
  if (repoDir) await removeRepo(repoDir);
});

async function workingTreeIsClean(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain']);
  return stdout.trim() === '';
}

describe('autonomous run loop: review → close', () => {
  it('ships a single sprint without leaving the tree dirty between review and close', async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001', review_required: true }],
      autonomousClose: true,
    });

    const result = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'autonomous',
      limit: 1,
      worktree: false,
      dryRun: false,
    });

    expect(result.exitCode, `run failed: ${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain('working tree');
    expect(result.stderr).not.toContain('dirty');

    const runId = await findRunId(repoDir);
    const run = await loadRunFile(repoDir, runId);
    expect(run.sprint_count).toBe(1);
    expect(run.completed_sprints[0]?.verdict).toBe('accepted');

    const sprint = await readFm(join(repoDir, 'sprints/S-001.md'));
    expect(sprint.status).toBe('shipped');
    expect(sprint.end_sha).toBeTruthy();

    expect(await workingTreeIsClean(repoDir)).toBe(true);
  });

  it('ships sequential sprints in a single autonomous run', async () => {
    repoDir = await makeEpicRepo({
      sprints: [
        { id: 'S-001', review_required: true },
        { id: 'S-002', review_required: true, depends_on: ['S-001'] },
      ],
      autonomousClose: true,
    });

    const result = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'autonomous',
      worktree: false,
      dryRun: false,
    });

    expect(result.exitCode, `run failed: stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);

    for (const sid of ['S-001', 'S-002']) {
      const sprint = await readFm(join(repoDir, 'sprints', `${sid}.md`));
      expect(sprint.status, `${sid} should be shipped`).toBe('shipped');
    }
  });

  it('produces two RepoKernel commits — review-side and close-side — for the autonomous transition', async () => {
    repoDir = await makeEpicRepo({
      sprints: [{ id: 'S-001', review_required: true }],
      autonomousClose: true,
    });

    const initialHead = await git(repoDir, 'rev-parse', 'HEAD');

    const result = await runRunCommand({
      cwd: repoDir,
      epicId: 'E-001',
      agent: 'fake',
      mode: 'autonomous',
      limit: 1,
      worktree: false,
      dryRun: false,
    });

    expect(result.exitCode, `run failed: ${result.stderr}`).toBe(0);

    const log = await git(repoDir, 'log', '--format=%s', `${initialHead}..HEAD`);
    const messages = log.split('\n').filter(Boolean);
    expect(messages).toContain('chore(rk): record review for S-001');
    expect(messages).toContain('chore(rk): close S-001');
  });
});
