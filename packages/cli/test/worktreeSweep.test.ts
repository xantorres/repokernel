import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '@repokernel/core';
import { afterAll, describe, expect, it } from 'vitest';
import { runWorktreeSweepCommand } from '../src/commands/worktreeSweep.js';
import { deleteMergedBranch } from '../src/lifecycle/worktree.js';
import { cleanupAllFixtures, defaultConfigYaml, makeFixture } from './helpers/fixture.js';

const execFileAsync = promisify(execFile);

async function makeGitFixture(): Promise<string> {
  const cwd = await makeFixture([
    { path: 'repokernel.config.yaml', content: defaultConfigYaml() },
    { path: 'README.md', content: '# fixture\n' },
  ]);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@rk.test']);
  await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'RK Test']);
  await execFileAsync('git', ['-C', cwd, 'add', '-A']);
  await execFileAsync('git', ['-C', cwd, 'commit', '-m', 'init']);
  return cwd;
}

/** Create `branch` and merge it back into main, leaving the ref behind. */
async function mergedBranch(cwd: string, branch: string, file: string): Promise<void> {
  await execFileAsync('git', ['-C', cwd, 'checkout', '-b', branch]);
  await execFileAsync('git', ['-C', cwd, 'commit', '--allow-empty', '-m', `work on ${file}`]);
  await execFileAsync('git', ['-C', cwd, 'checkout', 'main']);
  await execFileAsync('git', ['-C', cwd, 'merge', '--no-ff', '-m', `merge ${branch}`, branch]);
}

async function localBranches(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    cwd,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/',
  ]);
  return stdout.trim().split('\n').filter(Boolean);
}

afterAll(cleanupAllFixtures);

describe('runWorktreeSweepCommand', () => {
  it('requires an explicit mode', async () => {
    const cwd = await makeGitFixture();
    const result = await runWorktreeSweepCommand({
      cwd,
      preview: false,
      apply: false,
      json: false,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--preview');
  });

  it('rejects --preview together with --apply', async () => {
    const cwd = await makeGitFixture();
    const result = await runWorktreeSweepCommand({ cwd, preview: true, apply: true, json: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('lists merged prefixed branches without deleting them', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'rk/epic/E-001', 'a');

    const result = await runWorktreeSweepCommand({ cwd, preview: true, apply: false, json: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rk/epic/E-001');
    expect(await localBranches(cwd)).toContain('rk/epic/E-001');
  });

  it('deletes merged prefixed branches on apply', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'rk/epic/E-001', 'a');

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('deleted rk/epic/E-001');
    expect(await localBranches(cwd)).not.toContain('rk/epic/E-001');
  });

  it('leaves unmerged prefixed branches alone', async () => {
    const cwd = await makeGitFixture();
    await execFileAsync('git', ['-C', cwd, 'checkout', '-b', 'rk/epic/E-002']);
    await execFileAsync('git', ['-C', cwd, 'commit', '--allow-empty', '-m', 'unmerged work']);
    await execFileAsync('git', ['-C', cwd, 'checkout', 'main']);

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: false });

    expect(result.exitCode).toBe(0);
    expect(await localBranches(cwd)).toContain('rk/epic/E-002');
  });

  it('ignores merged branches outside the configured prefix', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'feature/unrelated', 'b');

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: false });

    expect(result.exitCode).toBe(0);
    expect(await localBranches(cwd)).toContain('feature/unrelated');
  });

  it('deletes a merged branch while HEAD sits on a divergent branch', async () => {
    const cwd = await makeGitFixture();
    const { stdout: root } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    await mergedBranch(cwd, 'rk/epic/E-004', 'd');
    // Branch off the root commit so the merged branch is not an ancestor of HEAD.
    await execFileAsync('git', ['-C', cwd, 'checkout', '-b', 'feature/divergent', root.trim()]);
    await execFileAsync('git', ['-C', cwd, 'commit', '--allow-empty', '-m', 'divergent work']);

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: false });

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await localBranches(cwd)).not.toContain('rk/epic/E-004');
  });

  it('emits the candidate list as JSON under --preview --json', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'rk/epic/E-005', 'e');

    const result = await runWorktreeSweepCommand({ cwd, preview: true, apply: false, json: true });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { branches: { branch: string; head: string }[] };
    expect(payload.branches).toHaveLength(1);
    expect(payload.branches[0]?.branch).toBe('rk/epic/E-005');
    expect(payload.branches[0]?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(await localBranches(cwd)).toContain('rk/epic/E-005');
  });

  it('reports deletions as JSON under --apply --json', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'rk/epic/E-006', 'f');

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: true });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      deleted: { branch: string }[];
      failed: unknown[];
    };
    expect(payload.deleted.map((d) => d.branch)).toEqual(['rk/epic/E-006']);
    expect(payload.failed).toEqual([]);
    expect(await localBranches(cwd)).not.toContain('rk/epic/E-006');
  });

  it('reports an uninitialized project instead of sweeping', async () => {
    const cwd = await makeFixture([{ path: 'README.md', content: '# no rk config\n' }]);
    await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);

    const result = await runWorktreeSweepCommand({ cwd, preview: true, apply: false, json: false });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('rk init');
  });

  it('keeps a merged branch that still backs a worktree', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'rk/epic/E-003', 'c');
    const attached = `${cwd}-wt-E-003`;
    await execFileAsync('git', ['-C', cwd, 'worktree', 'add', attached, 'rk/epic/E-003']);

    try {
      const result = await runWorktreeSweepCommand({
        cwd,
        preview: false,
        apply: true,
        json: false,
      });

      expect(result.exitCode).toBe(0);
      expect(await localBranches(cwd)).toContain('rk/epic/E-003');
    } finally {
      await execFileAsync('git', ['-C', cwd, 'worktree', 'remove', '--force', attached]);
    }
  });

  it('does not claim branches that merely share a prefix substring', async () => {
    // branchPrefix is only validated as a legal ref, not for specificity. A
    // short one must not let the sweep adopt unrelated namespaces.
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}worktrees:
  branchPrefix: "r"
`,
      },
      { path: 'README.md', content: '# fixture\n' },
    ]);
    await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@rk.test']);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'RK Test']);
    await execFileAsync('git', ['-C', cwd, 'add', '-A']);
    await execFileAsync('git', ['-C', cwd, 'commit', '-q', '-m', 'init']);
    await mergedBranch(cwd, 'release/2026-01', 'h');
    await mergedBranch(cwd, 'refactor/tidy', 'i');
    await mergedBranch(cwd, 'r/epic/E-001', 'j');

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: false });

    expect(result.exitCode).toBe(0);
    const remaining = await localBranches(cwd);
    expect(remaining).toContain('release/2026-01');
    expect(remaining).toContain('refactor/tidy');
    expect(remaining).not.toContain('r/epic/E-001');
  });

  it('prints the full commit of every deleted branch', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'rk/epic/E-008', 'k');
    const { stdout: sha } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'rk/epic/E-008']);

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: false });

    // An abbreviation can go ambiguous; recovery depends on the full value.
    expect(result.stdout).toContain(sha.trim());
  });

  it('never sweeps the base branch when the base sits under the prefix', async () => {
    // branchPrefix and baseBranch can overlap. The base then passes the prefix
    // filter, and its local name differs from the remote-tracking ref the
    // merge check resolves to, so nothing but an explicit guard excludes it.
    const cwd = await makeFixture([
      {
        path: 'repokernel.config.yaml',
        content: `${defaultConfigYaml()}worktrees:
  branchPrefix: "release/"
  baseBranch: "release/current"
`,
      },
    ]);
    const remote = await makeFixture([]);
    await execFileAsync('git', ['init', '-q', '--bare', remote]);
    await execFileAsync('git', ['init', '-q', '-b', 'release/current', cwd]);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.email', 'test@rk.test']);
    await execFileAsync('git', ['-C', cwd, 'config', 'user.name', 'RK Test']);
    await execFileAsync('git', ['-C', cwd, 'add', '-A']);
    await execFileAsync('git', ['-C', cwd, 'commit', '-q', '-m', 'init']);
    await execFileAsync('git', ['-C', cwd, 'remote', 'add', 'origin', remote]);
    await execFileAsync('git', ['-C', cwd, 'push', '-q', 'origin', 'release/current']);
    await execFileAsync('git', ['-C', cwd, 'checkout', '-q', '-b', 'release/epic/E-001']);
    await execFileAsync('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'work']);
    await execFileAsync('git', ['-C', cwd, 'checkout', '-q', 'release/current']);
    await execFileAsync('git', [
      '-C',
      cwd,
      'merge',
      '-q',
      '--no-ff',
      '-m',
      'merge E-001',
      'release/epic/E-001',
    ]);
    await execFileAsync('git', ['-C', cwd, 'push', '-q', 'origin', 'release/current']);
    // Step off the base so it is not protected merely by being checked out.
    await execFileAsync('git', ['-C', cwd, 'checkout', '-q', '-b', 'scratch']);

    const result = await runWorktreeSweepCommand({ cwd, preview: false, apply: true, json: false });

    expect(result.exitCode).toBe(0);
    expect(await localBranches(cwd)).toContain('release/current');
    expect(await localBranches(cwd)).not.toContain('release/epic/E-001');
  });
});

describe('deleteMergedBranch', () => {
  it('refuses a branch that stopped being merged after it was listed', async () => {
    const cwd = await makeGitFixture();
    await mergedBranch(cwd, 'rk/epic/E-007', 'g');
    const loaded = await loadConfig({ cwd });
    if (!loaded.ok) throw new Error('fixture config failed to load');

    // The listing/deletion race the ancestry re-check exists to close: the ref
    // gains a commit the base does not carry after it was listed as sweepable.
    await execFileAsync('git', ['-C', cwd, 'checkout', 'rk/epic/E-007']);
    await execFileAsync('git', ['-C', cwd, 'commit', '--allow-empty', '-m', 'late work']);
    await execFileAsync('git', ['-C', cwd, 'checkout', 'main']);

    await expect(deleteMergedBranch('rk/epic/E-007', loaded.config, cwd)).rejects.toThrow(
      /no longer merged/,
    );
    expect(await localBranches(cwd)).toContain('rk/epic/E-007');
  });
});
