import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RepoKernelError } from '@repokernel/core';
import { scanStagedPathsForSecrets } from './secretScanner.js';

const execFileAsync = promisify(execFile);

export async function getCurrentSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    return stdout.trim();
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      'could not read HEAD SHA — is this a git repository?',
      cause,
    );
  }
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain']);
    return stdout.trim() === '';
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', 'could not check working tree status', cause);
  }
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', cwd, 'diff', '--cached', '--quiet']);
    return false;
  } catch (cause) {
    if (isGitExit(cause, 1)) return true;
    throw new RepoKernelError('IO_ERROR', 'could not check staged changes', cause);
  }
}

async function hasUnstagedChanges(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', cwd, 'diff', '--quiet']);
    return false;
  } catch (cause) {
    if (isGitExit(cause, 1)) return true;
    throw new RepoKernelError('IO_ERROR', 'could not check unstaged changes', cause);
  }
}

async function listUnmergedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    cwd,
    'diff',
    '--name-only',
    '--diff-filter=U',
  ]);
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
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain']);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
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
      await execFileAsync('git', ['-C', cwd, 'add', '--', ...uniquePaths]);
    }
    await scanStagedPathsForSecrets(cwd, uniquePaths);
    const commitArgs =
      uniquePaths.length > 0
        ? ['-C', cwd, 'commit', '--allow-empty', '--only', '-m', message, '--', ...uniquePaths]
        : ['-C', cwd, 'commit', '--allow-empty', '-m', message];
    await execFileAsync('git', commitArgs);
  } catch (cause) {
    if (cause instanceof RepoKernelError) throw cause;
    throw new RepoKernelError('IO_ERROR', 'could not commit RepoKernel metadata', cause);
  }
}

export async function changedFilesSince(cwd: string, baseSha: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      cwd,
      'diff',
      '--name-only',
      `${baseSha}..HEAD`,
    ]);
    const trimmed = stdout.trim();
    return trimmed === '' ? [] : trimmed.split('\n').filter(Boolean);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not compute diff since ${baseSha}`, cause);
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
    await execFileAsync('git', ['-C', cwd, 'revert', '--no-commit', `${baseSha}..${endSha}`]);
    await execFileAsync('git', ['-C', cwd, 'commit', '-m', message]);
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
    await execFileAsync('git', ['-C', cwd, 'revert', '--no-commit', `${baseSha}..${endSha}`]);
  } catch (cause) {
    const unmergedFiles = await listUnmergedFiles(cwd).catch(() => []);
    await execFileAsync('git', ['-C', cwd, 'revert', '--abort']).catch(() => null);
    if (unmergedFiles.length > 0) {
      return { ok: false, reason: 'conflict', details: unmergedFiles.join('\n') };
    }
    return { ok: false, reason: 'error', cause };
  }
  try {
    await execFileAsync('git', ['-C', cwd, 'commit', '-m', message]);
    return { ok: true };
  } catch (cause) {
    await execFileAsync('git', ['-C', cwd, 'revert', '--abort']).catch(() => null);
    return { ok: false, reason: 'error', cause };
  }
}
