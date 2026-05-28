import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RepoKernelError } from '@repokernel/core';
import { git } from './gitExec.js';
import { gitDiffNameOnlyZ, gitDiffNameStatusPathsZ, gitPorcelainV1Z } from './gitPorcelain.js';
import { scanStagedPathsForSecrets } from './secretScanner.js';

export async function getCurrentSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await git(['-C', cwd, 'rev-parse', 'HEAD']);
    return stdout.trim();
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      'could not read HEAD SHA — is this a git repository?',
      cause,
    );
  }
}

/**
 * Resolve an arbitrary git ref (branch, tag, HEAD, short SHA) to a full commit
 * SHA. The `^{commit}` peeling ensures tags resolve to their commit and that
 * the ref actually names a commit, not a tree or blob.
 */
export async function resolveCommitSha(cwd: string, ref: string): Promise<string> {
  try {
    const { stdout } = await git(['-C', cwd, 'rev-parse', '--verify', `${ref}^{commit}`]);
    return stdout.trim();
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not resolve git ref "${ref}"`, cause);
  }
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  try {
    const entries = await gitPorcelainV1Z(cwd);
    return entries.length === 0;
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', 'could not check working tree status', cause);
  }
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await git(['-C', cwd, 'diff', '--cached', '--quiet']);
    return false;
  } catch (cause) {
    if (isGitExit(cause, 1)) return true;
    throw new RepoKernelError('IO_ERROR', 'could not check staged changes', cause);
  }
}

async function hasUnstagedChanges(cwd: string): Promise<boolean> {
  try {
    await git(['-C', cwd, 'diff', '--quiet']);
    return false;
  } catch (cause) {
    if (isGitExit(cause, 1)) return true;
    throw new RepoKernelError('IO_ERROR', 'could not check unstaged changes', cause);
  }
}

async function listUnmergedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await git(['-C', cwd, 'diff', '--name-only', '--diff-filter=U']);
  return stdout.trim().split('\n').filter(Boolean);
}

function isGitExit(cause: unknown, code: number): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === code
  );
}

export async function getDirtyFiles(cwd: string): Promise<string[]> {
  try {
    const entries = await gitPorcelainV1Z(cwd);
    // For renames/copies, the new path is the meaningful one to surface — the
    // old path is implied by the rename semantics. NUL-delimited stream
    // preserves whitespace/newlines/quotes in filenames intact.
    return entries.map((e) => e.path);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', 'could not check working tree status', cause);
  }
}

export async function stagePathsAndCommit(
  cwd: string,
  paths: readonly string[],
  message: string,
): Promise<void> {
  try {
    const uniquePaths = [...new Set(paths)].filter((path) => path.length > 0);
    if (await hasStagedChanges(cwd)) {
      throw new RepoKernelError(
        'IO_ERROR',
        'refusing to create RepoKernel metadata commit while unrelated staged changes exist',
      );
    }
    if (uniquePaths.length > 0) {
      await git(['-C', cwd, 'add', '--', ...uniquePaths]);
    }
    await scanStagedPathsForSecrets(cwd, uniquePaths);
    const commitArgs =
      uniquePaths.length > 0
        ? ['-C', cwd, 'commit', '--allow-empty', '--only', '-m', message, '--', ...uniquePaths]
        : ['-C', cwd, 'commit', '--allow-empty', '-m', message];
    await git(commitArgs);
  } catch (cause) {
    if (cause instanceof RepoKernelError) throw cause;
    throw new RepoKernelError('IO_ERROR', 'could not commit RepoKernel metadata', cause);
  }
}

export async function changedFilesSince(cwd: string, baseSha: string): Promise<string[]> {
  try {
    return [...(await gitDiffNameOnlyZ(cwd, `${baseSha}..HEAD`))];
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not compute diff since ${baseSha}`, cause);
  }
}

export interface SprintChangedFiles {
  readonly files: readonly string[];
  readonly committed: readonly string[];
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export type PublishState = 'pushed' | 'not_pushed' | 'no_remote' | 'unknown';

export interface PublishStateReport {
  readonly state: PublishState;
  readonly branch?: string;
  readonly upstream?: string;
  readonly remotes: readonly string[];
  readonly ahead?: number;
  readonly behind?: number;
}

export async function changedFilesForSprint(
  cwd: string,
  baseSha: string,
): Promise<SprintChangedFiles> {
  try {
    const [committed, staged, unstaged, porcelain] = await Promise.all([
      gitDiffNameStatusPathsZ(cwd, [`${baseSha}..HEAD`]),
      gitDiffNameStatusPathsZ(cwd, ['--cached']),
      gitDiffNameStatusPathsZ(cwd, []),
      gitPorcelainV1Z(cwd),
    ]);
    const untracked = porcelain
      .filter((entry) => entry.indexCode === '?' && entry.workCode === '?')
      .map((entry) => entry.path);
    const files = uniqSorted([...committed, ...staged, ...unstaged, ...untracked]);
    return {
      files,
      committed: uniqSorted(committed),
      staged: uniqSorted(staged),
      unstaged: uniqSorted(unstaged),
      untracked: uniqSorted(untracked),
    };
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not compute sprint diff since ${baseSha}`, cause);
  }
}

export async function changedLineCountForSprint(cwd: string, baseSha: string): Promise<number> {
  try {
    const [tracked, porcelain] = await Promise.all([
      git(['-C', cwd, 'diff', '--numstat', baseSha]),
      gitPorcelainV1Z(cwd),
    ]);
    const untracked = porcelain
      .filter((entry) => entry.indexCode === '?' && entry.workCode === '?')
      .map((entry) => entry.path);
    return countNumstatLines([tracked.stdout]) + (await countUntrackedLines(cwd, untracked));
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `could not compute sprint line diff since ${baseSha}`,
      cause,
    );
  }
}

function countNumstatLines(outputs: readonly string[]): number {
  let total = 0;
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const [addedRaw, deletedRaw] = line.split(/\s+/u);
      const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw ?? '0', 10);
      const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw ?? '0', 10);
      total += (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0);
    }
  }
  return total;
}

async function countUntrackedLines(cwd: string, files: readonly string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    const content = await readFile(join(cwd, file), 'utf8');
    if (content.length === 0) continue;
    total += content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
  }
  return total;
}

function uniqSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export async function getPublishState(cwd: string): Promise<PublishStateReport> {
  try {
    const remotes = (await git(['-C', cwd, 'remote'])).stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const branch = await currentBranch(cwd);
    if (remotes.length === 0) {
      return { state: 'no_remote', ...(branch !== undefined ? { branch } : {}), remotes };
    }

    let upstream: string | undefined;
    try {
      upstream = (
        await git(['-C', cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      ).stdout.trim();
    } catch {
      return { state: 'not_pushed', ...(branch !== undefined ? { branch } : {}), remotes };
    }

    const counts = (
      await git(['-C', cwd, 'rev-list', '--left-right', '--count', `${upstream}...HEAD`])
    ).stdout
      .trim()
      .split(/\s+/u);
    const behind = Number.parseInt(counts[0] ?? '0', 10);
    const ahead = Number.parseInt(counts[1] ?? '0', 10);
    return {
      state: ahead > 0 ? 'not_pushed' : 'pushed',
      ...(branch !== undefined ? { branch } : {}),
      upstream,
      remotes,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  } catch {
    return { state: 'unknown', remotes: [] };
  }
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const branch = (await git(['-C', cwd, 'branch', '--show-current'])).stdout.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

export async function revertRange(
  cwd: string,
  baseSha: string,
  endSha: string,
  message: string,
): Promise<void> {
  if ((await hasStagedChanges(cwd)) || (await hasUnstagedChanges(cwd))) {
    throw new RepoKernelError(
      'IO_ERROR',
      'refusing to revert while working tree or index has local changes',
    );
  }
  try {
    await git(['-C', cwd, 'revert', '--no-commit', `${baseSha}..${endSha}`]);
    await git(['-C', cwd, 'commit', '-m', message]);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not revert range ${baseSha}..${endSha}`, cause);
  }
}

export type RevertRangeResult =
  | { ok: true }
  | { ok: false; reason: 'dirty'; details: string }
  | { ok: false; reason: 'conflict'; details: string }
  | { ok: false; reason: 'error'; cause: unknown };

export async function tryRevertRange(
  cwd: string,
  baseSha: string,
  endSha: string,
  message: string,
): Promise<RevertRangeResult> {
  if ((await hasStagedChanges(cwd)) || (await hasUnstagedChanges(cwd))) {
    return {
      ok: false,
      reason: 'dirty',
      details: 'working tree or index has local changes; refusing to revert over user state',
    };
  }
  try {
    await git(['-C', cwd, 'revert', '--no-commit', `${baseSha}..${endSha}`]);
  } catch (cause) {
    const unmergedFiles = await listUnmergedFiles(cwd).catch(() => []);
    await git(['-C', cwd, 'revert', '--abort']).catch(() => null);
    if (unmergedFiles.length > 0) {
      return { ok: false, reason: 'conflict', details: unmergedFiles.join('\n') };
    }
    return { ok: false, reason: 'error', cause };
  }
  try {
    await git(['-C', cwd, 'commit', '-m', message]);
    return { ok: true };
  } catch (cause) {
    await git(['-C', cwd, 'revert', '--abort']).catch(() => null);
    return { ok: false, reason: 'error', cause };
  }
}
