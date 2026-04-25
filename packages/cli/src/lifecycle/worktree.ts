import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { EpicId } from '@repokernel/core';
import { type Config, RepoKernelError } from '@repokernel/core';
import { operationalRoot } from './controlPaths.js';
import { isWorkingTreeClean } from './git.js';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly reused: boolean;
}

interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly bare: boolean;
}

export function worktreePath(epicId: EpicId, config: Config, controlCwd: string): string {
  const root = config.worktrees.root;
  const base = isAbsolute(root) ? root : resolve(controlCwd, root);
  // Use repo dir basename to namespace worktrees from different repos
  const repoName = resolve(controlCwd).split('/').pop() ?? 'repo';
  return join(base, repoName, epicId);
}

export function worktreeBranch(epicId: EpicId, config: Config): string {
  return `${config.worktrees.branchPrefix}${epicId}`;
}

export async function listWorktrees(controlCwd: string): Promise<WorktreeEntry[]> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      controlCwd,
      'worktree',
      'list',
      '--porcelain',
    ]);
    return parseWorktreeList(stdout);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', 'could not list git worktrees', cause);
  }
}

function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = output.trim().split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.trim().split('\n');
    let path = '';
    let branch: string | null = null;
    let bare = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace('refs/heads/', '');
      else if (line === 'bare') bare = true;
    }
    if (path) entries.push({ path, branch, bare });
  }
  return entries;
}

async function branchExists(branch: string, controlCwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', controlCwd, 'rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function acquireWorktree(
  epicId: EpicId,
  config: Config,
  controlCwd: string,
): Promise<WorktreeInfo> {
  const path = worktreePath(epicId, config, controlCwd);
  const branch = worktreeBranch(epicId, config);
  const opRoot = await operationalRoot(controlCwd);

  const existing = await listWorktrees(controlCwd);
  const registered = existing.find((w) => w.path === path);

  if (registered) {
    await updateWorktreesJson(opRoot, { path, branch, epicId });
    return { path, branch, reused: true };
  }

  await mkdir(join(path, '..'), { recursive: true });

  const branchAlreadyExists = await branchExists(branch, controlCwd);

  try {
    if (branchAlreadyExists) {
      await execFileAsync('git', ['-C', controlCwd, 'worktree', 'add', path, branch]);
    } else {
      await execFileAsync('git', [
        '-C',
        controlCwd,
        'worktree',
        'add',
        '-b',
        branch,
        path,
        config.worktrees.baseBranch,
      ]);
    }
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `could not create worktree at ${path} (branch: ${branch})`,
      cause,
    );
  }

  await updateWorktreesJson(opRoot, { path, branch, epicId });
  return { path, branch, reused: false };
}

export async function releaseWorktree(
  epicId: EpicId,
  config: Config,
  controlCwd: string,
  force = false,
): Promise<void> {
  const path = worktreePath(epicId, config, controlCwd);
  const opRoot = await operationalRoot(controlCwd);

  if (!force) {
    const clean = await isWorkingTreeClean(path).catch(() => true);
    if (!clean) {
      throw new RepoKernelError(
        'IO_ERROR',
        `worktree at ${path} has uncommitted changes — use --force to release anyway`,
      );
    }
  }

  try {
    const args = ['worktree', 'remove', path];
    if (force) args.push('--force');
    await execFileAsync('git', ['-C', controlCwd, ...args]);
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not remove worktree at ${path}`, cause);
  }

  await removeFromWorktreesJson(opRoot, epicId);
}

// — worktrees.json registry —

interface WorktreeRecord {
  readonly epicId: string;
  readonly path: string;
  readonly branch: string;
}

interface WorktreesJson {
  readonly worktrees: WorktreeRecord[];
}

function worktreesJsonPath(opRoot: string): string {
  return join(opRoot, 'worktrees.json');
}

async function readWorktreesJson(opRoot: string): Promise<WorktreesJson> {
  try {
    const raw = await readFile(worktreesJsonPath(opRoot), 'utf8');
    return JSON.parse(raw) as WorktreesJson;
  } catch {
    return { worktrees: [] };
  }
}

async function updateWorktreesJson(
  opRoot: string,
  entry: { path: string; branch: string; epicId: string },
): Promise<void> {
  await mkdir(opRoot, { recursive: true });
  const data = await readWorktreesJson(opRoot);
  const filtered = data.worktrees.filter((w) => w.epicId !== entry.epicId);
  const updated: WorktreesJson = {
    worktrees: [...filtered, { epicId: entry.epicId, path: entry.path, branch: entry.branch }],
  };
  await writeFile(worktreesJsonPath(opRoot), JSON.stringify(updated, null, 2), 'utf8');
}

async function removeFromWorktreesJson(opRoot: string, epicId: string): Promise<void> {
  const data = await readWorktreesJson(opRoot);
  const filtered = data.worktrees.filter((w) => w.epicId !== epicId);
  await writeFile(
    worktreesJsonPath(opRoot),
    JSON.stringify({ worktrees: filtered }, null, 2),
    'utf8',
  );
}
