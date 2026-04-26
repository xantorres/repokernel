import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RepoKernelError } from '@repokernel/core';
import { scanDiffForSecrets } from './secretScanner.js';

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

export async function stageAndCommit(cwd: string, message: string): Promise<void> {
  await scanDiffForSecrets(cwd);
  try {
    await execFileAsync('git', ['-C', cwd, 'add', '-A']);
    await execFileAsync('git', ['-C', cwd, 'commit', '--allow-empty', '-m', message]);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', 'could not commit wave close metadata', cause);
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
  try {
    await execFileAsync('git', ['-C', cwd, 'revert', '--no-commit', `${baseSha}..${endSha}`]);
    await execFileAsync('git', ['-C', cwd, 'commit', '-m', message]);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not revert range ${baseSha}..${endSha}`, cause);
  }
}

export type RevertRangeResult =
  | { ok: true }
  | { ok: false; reason: 'conflict'; details: string }
  | { ok: false; reason: 'error'; cause: unknown };

export async function tryRevertRange(
  cwd: string,
  baseSha: string,
  endSha: string,
  message: string,
): Promise<RevertRangeResult> {
  try {
    await execFileAsync('git', ['-C', cwd, 'revert', '--no-commit', `${baseSha}..${endSha}`]);
  } catch (cause) {
    await execFileAsync('git', ['-C', cwd, 'revert', '--abort']).catch(() => null);
    const msg = cause instanceof Error ? cause.message : String(cause);
    const isConflict =
      msg.includes('conflict') || msg.includes('CONFLICT') || msg.includes('could not apply');
    if (isConflict) return { ok: false, reason: 'conflict', details: msg };
    return { ok: false, reason: 'error', cause };
  }
  try {
    await execFileAsync('git', ['-C', cwd, 'commit', '-m', message]);
    return { ok: true };
  } catch (cause) {
    await execFileAsync('git', ['-C', cwd, 'revert', '--abort']).catch(() => null);
    return {
      ok: false,
      reason: 'conflict',
      details: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
