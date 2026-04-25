import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RepoKernelError } from '@repokernel/core';

const execFileAsync = promisify(execFile);

export async function commonGitDir(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
    const rel = stdout.trim();
    // git returns absolute path or relative to cwd
    if (rel.startsWith('/')) return rel;
    const { resolve } = await import('node:path');
    return resolve(cwd, rel);
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      'could not resolve git-common-dir — is this a git repository?',
      cause,
    );
  }
}

export async function operationalRoot(cwd: string): Promise<string> {
  const gitDir = await commonGitDir(cwd);
  return join(gitDir, 'repokernel');
}

export async function isWorktreeCheckout(cwd: string): Promise<boolean> {
  try {
    const [gitDir, gitCommonDir] = await Promise.all([
      execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-dir']).then(({ stdout }) =>
        stdout.trim(),
      ),
      execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-common-dir']).then(({ stdout }) =>
        stdout.trim(),
      ),
    ]);
    return gitDir !== gitCommonDir && gitDir !== '.git';
  } catch {
    return false;
  }
}

export function runStateRoot(opRoot: string): string {
  return join(opRoot, 'runs');
}

export function lockRoot(opRoot: string): string {
  return join(opRoot, 'locks');
}

export function laneStateRoot(opRoot: string): string {
  return join(opRoot, 'lanes');
}
