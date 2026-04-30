import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RepoKernelError } from '@repokernel/core';

const execFileAsync = promisify(execFile);

/**
 * Normalize a path returned by `git rev-parse`. Git may return either an
 * absolute path or a path relative to `cwd`. We resolve against `cwd`, then
 * best-effort `realpath` so callers compare canonical paths even when the
 * checkout (or `.git/worktrees/*`) sits behind symlinks. realpath failures
 * are non-fatal — if the target doesn't exist yet we keep the resolved path.
 */
async function normalizeGitPath(cwd: string, value: string): Promise<string> {
  const absolute = isAbsolute(value) ? value : resolve(cwd, value);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function commonGitDir(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
    return await normalizeGitPath(cwd, stdout.trim());
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

/**
 * Resolve the operational root, falling back to a project-local directory
 * when git is not available.
 *
 * Use when the caller wants to function outside a git repository (e.g.
 * scaffolding commands like `rk create` invoked before `git init`). The
 * fallback path is `<cwd>/.repokernel/_op` — distinct from the user-facing
 * `paths.generated` so it never collides with registry/derived artifacts.
 *
 * Worktree semantics are moot outside git, so per-cwd state is correct there.
 */
export async function operationalRootBestEffort(cwd: string): Promise<string> {
  try {
    return await operationalRoot(cwd);
  } catch {
    return join(cwd, '.repokernel', '_op');
  }
}

export async function isWorktreeCheckout(cwd: string): Promise<boolean> {
  try {
    const [gitDirRaw, gitCommonDirRaw] = await Promise.all([
      execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-dir']).then(({ stdout }) =>
        stdout.trim(),
      ),
      execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-common-dir']).then(({ stdout }) =>
        stdout.trim(),
      ),
    ]);
    const [gitDir, gitCommonDir] = await Promise.all([
      normalizeGitPath(cwd, gitDirRaw),
      normalizeGitPath(cwd, gitCommonDirRaw),
    ]);
    return gitDir !== gitCommonDir;
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
