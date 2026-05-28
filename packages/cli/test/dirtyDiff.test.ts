import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFilesForSprint, changedLineCountForSprint } from '../src/lifecycle/git.js';

const execFileAsync = promisify(execFile);
const repos: string[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'rk-dirty-diff-'));
  repos.push(cwd);
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', cwd]);
  await git(cwd, 'config', 'user.email', 'test@repokernel.test');
  await git(cwd, 'config', 'user.name', 'RepoKernel Test');
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src', 'base.ts'), 'export const base = true;\n', 'utf8');
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-m', 'init');
  return cwd;
}

describe('changedFilesForSprint', () => {
  it('unions committed, staged, unstaged, and untracked paths', async () => {
    const cwd = await makeRepo();
    const base = await git(cwd, 'rev-parse', 'HEAD');

    await writeFile(join(cwd, 'src', 'committed.ts'), 'export const committed = true;\n', 'utf8');
    await git(cwd, 'add', 'src/committed.ts');
    await git(cwd, 'commit', '-m', 'feat: committed');

    await writeFile(join(cwd, 'src', 'staged.ts'), 'export const staged = true;\n', 'utf8');
    await git(cwd, 'add', 'src/staged.ts');

    await writeFile(join(cwd, 'src', 'base.ts'), 'export const base = false;\n', 'utf8');
    await writeFile(join(cwd, 'src', 'untracked.ts'), 'export const untracked = true;\n', 'utf8');

    const changed = await changedFilesForSprint(cwd, base);

    expect(changed.committed).toEqual(['src/committed.ts']);
    expect(changed.staged).toEqual(['src/staged.ts']);
    expect(changed.unstaged).toEqual(['src/base.ts']);
    expect(changed.untracked).toEqual(['src/untracked.ts']);
    expect(changed.files).toEqual([
      'src/base.ts',
      'src/committed.ts',
      'src/staged.ts',
      'src/untracked.ts',
    ]);
  });

  it('includes both source and destination paths for staged renames', async () => {
    const cwd = await makeRepo();
    const base = await git(cwd, 'rev-parse', 'HEAD');

    await git(cwd, 'mv', 'src/base.ts', 'src/renamed.ts');

    const changed = await changedFilesForSprint(cwd, base);

    expect(changed.staged).toEqual(['src/base.ts', 'src/renamed.ts']);
    expect(changed.files).toEqual(['src/base.ts', 'src/renamed.ts']);
  });
});

describe('changedLineCountForSprint', () => {
  it('counts the current tracked diff without double-counting intermediate commits', async () => {
    const cwd = await makeRepo();
    const base = await git(cwd, 'rev-parse', 'HEAD');

    await writeFile(join(cwd, 'src/base.ts'), 'export const base = false;\n', 'utf8');
    await git(cwd, 'add', 'src/base.ts');
    await git(cwd, 'commit', '-m', 'feat: flip base');

    await writeFile(join(cwd, 'src/base.ts'), 'export const base = "final";\n', 'utf8');

    await expect(changedLineCountForSprint(cwd, base)).resolves.toBe(2);
  });

  it('counts added lines from untracked files', async () => {
    const cwd = await makeRepo();
    const base = await git(cwd, 'rev-parse', 'HEAD');

    await writeFile(join(cwd, 'src/new.ts'), 'one\ntwo\nthree\n', 'utf8');

    await expect(changedLineCountForSprint(cwd, base)).resolves.toBe(3);
  });
});
