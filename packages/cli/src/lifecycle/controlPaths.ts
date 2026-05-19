import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { RepoKernelError } from '@repokernel/core';
import { git } from './gitExec.js';

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
    const { stdout } = await git(['-C', cwd, 'rev-parse', '--git-common-dir']);
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
      git(['-C', cwd, 'rev-parse', '--git-dir']).then(({ stdout }) => stdout.trim()),
      git(['-C', cwd, 'rev-parse', '--git-common-dir']).then(({ stdout }) => stdout.trim()),
    ]);
    // Fast-path: identical raw strings always mean main checkout. The literal
    // ".git" return is git's shorthand for "main checkout" — preserve the
    // guard so the realpath comparison below never mistakes a partial
    // resolution failure for a worktree.
    if (gitDirRaw === gitCommonDirRaw) return false;
    if (gitDirRaw === '.git') return false;
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

/**
 * Root for the multi-file mutation journal. Operations write
 * `OP-<ulid>.pending.json` here before any mutation, rename to
 * `OP-<ulid>.done.json` on commit, and quarantine to
 * `OP-<ulid>.unrecoverable.<ts>.<rand>.json` when `rk recover` cannot
 * safely replay them. Sits under the same git-common-dir scope as the
 * rest of operational state, so it is shared across worktrees of the
 * clone but never travels through `git push`/`git fetch`.
 */
export function journalRoot(opRoot: string): string {
  return join(opRoot, 'journal');
}
