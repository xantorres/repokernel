import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { EpicId, SprintId } from '@repokernel/core';
import { type Config, FINDING_CODES, type Finding, RepoKernelError } from '@repokernel/core';
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
  return `${config.worktrees.branchPrefix}epic/${epicId}`;
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

async function resolveBaseRef(baseBranch: string, controlCwd: string): Promise<string> {
  if (await branchExists(baseBranch, controlCwd)) return baseBranch;
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      controlCwd,
      'symbolic-ref',
      '--short',
      'HEAD',
    ]);
    return stdout.trim();
  } catch {
    return baseBranch;
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
    if (registered.branch !== branch) {
      throw new RepoKernelError(
        'IO_ERROR',
        `worktree at ${path} is on branch ${registered.branch ?? 'detached HEAD'}, expected ${branch} — release or migrate the existing worktree first`,
      );
    }
    await updateWorktreesJson(opRoot, { path, branch, epicId });
    return { path, branch, reused: true };
  }

  await mkdir(join(path, '..'), { recursive: true });

  const branchAlreadyExists = await branchExists(branch, controlCwd);

  try {
    if (branchAlreadyExists) {
      await execFileAsync('git', ['-C', controlCwd, 'worktree', 'add', path, branch]);
    } else {
      const baseRef = await resolveBaseRef(config.worktrees.baseBranch, controlCwd);
      await execFileAsync('git', [
        '-C',
        controlCwd,
        'worktree',
        'add',
        '-b',
        branch,
        path,
        baseRef,
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

// --- sprint-level worktrees ---

export function sprintWorktreePath(
  epicId: EpicId,
  sprintId: SprintId,
  config: Config,
  controlCwd: string,
): string {
  return join(worktreePath(epicId, config, controlCwd), '..', `${epicId}-sprints`, sprintId);
}

export function sprintWorktreeBranch(epicId: EpicId, sprintId: SprintId, config: Config): string {
  return `${config.worktrees.branchPrefix}sprint/${epicId}/${sprintId}`;
}

export interface SprintWorktreeInfo {
  readonly path: string;
  readonly branch: string;
}

/**
 * Create a git worktree for a sprint, branching from the epic worktree's current HEAD.
 * Sprint worktrees live beside the epic worktree — each parallel sprint gets isolation
 * without nesting one git checkout inside another.
 *
 * Branch naming: rk/sprint/E-001/S-003
 * Path: <worktrees.root>/<repo>/E-001-sprints/S-003
 */
export async function acquireSprintWorktree(
  epicId: EpicId,
  sprintId: SprintId,
  epicWorktreePath: string,
  config: Config,
  controlCwd: string,
): Promise<SprintWorktreeInfo> {
  const path = sprintWorktreePath(epicId, sprintId, config, controlCwd);
  const branch = sprintWorktreeBranch(epicId, sprintId, config);
  const opRoot = await operationalRoot(controlCwd);

  // Check if already registered (reuse)
  const existing = await listWorktrees(controlCwd);
  const registered = existing.find((w) => w.path === path);
  if (registered) {
    if (registered.branch !== branch) {
      throw new RepoKernelError(
        'IO_ERROR',
        `sprint worktree at ${path} is on branch ${registered.branch ?? 'detached HEAD'}, expected ${branch} — release or migrate the existing worktree first`,
      );
    }
    await updateWorktreesJson(opRoot, { path, branch, epicId, sprintId, type: 'sprint' });
    return { path, branch };
  }

  await mkdir(join(path, '..'), { recursive: true });

  const branchAlreadyExists = await branchExists(branch, controlCwd);

  try {
    if (branchAlreadyExists) {
      await execFileAsync('git', ['-C', controlCwd, 'worktree', 'add', path, branch]);
    } else {
      // Branch from epic worktree HEAD, not from baseBranch
      await execFileAsync('git', [
        '-C',
        epicWorktreePath,
        'worktree',
        'add',
        '-b',
        branch,
        path,
        'HEAD',
      ]);
    }
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `could not create sprint worktree at ${path} (branch: ${branch})`,
      cause,
    );
  }

  await updateWorktreesJson(opRoot, { path, branch, epicId, sprintId, type: 'sprint' });
  return { path, branch };
}

/**
 * Remove a sprint worktree after its branch has been merged into the epic branch.
 * Always uses --force since the sprint branch is expected to have merged commits.
 */
export async function releaseSprintWorktree(
  epicId: EpicId,
  sprintId: SprintId,
  config: Config,
  controlCwd: string,
): Promise<void> {
  const path = sprintWorktreePath(epicId, sprintId, config, controlCwd);
  const opRoot = await operationalRoot(controlCwd);

  try {
    await execFileAsync('git', ['-C', controlCwd, 'worktree', 'remove', '--force', path]);
  } catch {
    // Ignore errors if worktree already removed
  }

  await removeSprintFromWorktreesJson(opRoot, epicId, sprintId);
}

// — worktrees.json registry —

interface WorktreeRecord {
  readonly epicId: string;
  readonly path: string;
  readonly branch: string;
  /** Distinguishes epic-level vs sprint-level worktrees. Defaults to 'epic'. */
  readonly type?: 'epic' | 'sprint';
  /** Only set for type='sprint'. */
  readonly sprintId?: string;
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
  entry: {
    path: string;
    branch: string;
    epicId: string;
    sprintId?: string;
    type?: 'epic' | 'sprint';
  },
): Promise<void> {
  await mkdir(opRoot, { recursive: true });
  const data = await readWorktreesJson(opRoot);
  const isSprint = entry.type === 'sprint';
  const filtered = isSprint
    ? data.worktrees.filter((w) => !(w.epicId === entry.epicId && w.sprintId === entry.sprintId))
    : data.worktrees.filter((w) => w.epicId !== entry.epicId || w.type === 'sprint');
  let record: WorktreeRecord;
  if (isSprint) {
    const sprintId = entry.sprintId;
    if (sprintId === undefined) {
      throw new RepoKernelError('IO_ERROR', 'sprint worktree entry missing sprintId');
    }
    record = {
      epicId: entry.epicId,
      path: entry.path,
      branch: entry.branch,
      type: 'sprint',
      sprintId,
    };
  } else {
    record = { epicId: entry.epicId, path: entry.path, branch: entry.branch };
  }
  const updated: WorktreesJson = { worktrees: [...filtered, record] };
  await writeFile(worktreesJsonPath(opRoot), JSON.stringify(updated, null, 2), 'utf8');
}

async function removeFromWorktreesJson(opRoot: string, epicId: string): Promise<void> {
  const data = await readWorktreesJson(opRoot);
  const filtered = data.worktrees.filter((w) => w.epicId !== epicId || w.type === 'sprint');
  await writeFile(
    worktreesJsonPath(opRoot),
    JSON.stringify({ worktrees: filtered }, null, 2),
    'utf8',
  );
}

async function removeSprintFromWorktreesJson(
  opRoot: string,
  epicId: string,
  sprintId: string,
): Promise<void> {
  const data = await readWorktreesJson(opRoot);
  const filtered = data.worktrees.filter((w) => !(w.epicId === epicId && w.sprintId === sprintId));
  await writeFile(
    worktreesJsonPath(opRoot),
    JSON.stringify({ worktrees: filtered }, null, 2),
    'utf8',
  );
}

// — worktree leak detection —

/**
 * Check worktrees.json for sprint-level worktrees whose sprint is no longer active.
 * Called from CLI validate command (not the core validator — worktrees.json is CLI-only state).
 */
export async function findLeakedSprintWorktrees(
  activeSprintIds: ReadonlySet<string>,
  controlCwd: string,
): Promise<Finding[]> {
  const opRoot = await operationalRoot(controlCwd);
  const data = await readWorktreesJson(opRoot);
  const findings: Finding[] = [];

  for (const record of data.worktrees) {
    if (record.type !== 'sprint' || !record.sprintId) continue;
    if (activeSprintIds.has(record.sprintId)) continue;
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.SPRINT_WORKTREE_LEAKED,
      message: `sprint worktree at ${record.path} (branch ${record.branch}) exists but sprint ${record.sprintId} is not active`,
      entityType: 'sprint',
      entityId: record.sprintId,
      data: { path: record.path, branch: record.branch, epicId: record.epicId },
    });
  }

  return findings;
}
