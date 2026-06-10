import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import {
  type Config,
  EpicIdSchema,
  loadProject,
  parseTaskAlias,
  RepoKernelError,
  type SprintStatus,
  toErrorMessage,
} from '@repokernel/core';
import matter from 'gray-matter';
import { git } from '../../lifecycle/gitExec.js';
import { ambientJournalAtomicCreate, ambientJournalWrite } from '../../lifecycle/journal.js';
import { worktreeBranch, worktreePath } from '../../lifecycle/worktree.js';
import { taskAliasPath, tasksDir } from './taskId.js';
import type { TaskAlias, TaskId } from './types.js';

const TASK_ALIAS_FILE_RE = /^T-\d+\.json$/u;

export async function readTaskAlias(
  cwd: string,
  config: Config,
  id: TaskId,
): Promise<TaskAlias | null> {
  const path = taskAliasPath(cwd, config, id);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw cause;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (cause) {
    throw new RepoKernelError(
      'INVALID_FRONTMATTER',
      `task alias ${id} at ${path} is not valid JSON: ${toErrorMessage(cause)}`,
      cause,
    );
  }
  const result = parseTaskAlias(parsedJson, basename(path, '.json'));
  if (!result.ok) {
    throw new RepoKernelError('INVALID_FRONTMATTER', `${result.error} (file: ${path})`);
  }
  return result.alias;
}

export async function writeTaskAlias(cwd: string, config: Config, alias: TaskAlias): Promise<void> {
  const path = taskAliasPath(cwd, config, alias.id);
  await mkdir(dirname(path), { recursive: true });
  // wx prevents accidental overwrite during initial allocation; callers
  // doing intentional updates must use writeTaskAliasUpdate below.
  await ambientJournalAtomicCreate(path, `${JSON.stringify(alias, null, 2)}\n`);
}

export async function writeTaskAliasUpdate(
  cwd: string,
  config: Config,
  alias: TaskAlias,
): Promise<void> {
  const path = taskAliasPath(cwd, config, alias.id);
  await mkdir(dirname(path), { recursive: true });
  await ambientJournalWrite(path, `${JSON.stringify(alias, null, 2)}\n`);
}

export async function listTaskAliases(cwd: string, config: Config): Promise<readonly TaskAlias[]> {
  const dir = tasksDir(cwd, config);
  const files = await readdir(dir).catch(() => [] as string[]);
  const aliases: TaskAlias[] = [];
  for (const f of files) {
    if (!TASK_ALIAS_FILE_RE.test(f)) continue;
    let raw: string;
    try {
      raw = await readFile(`${dir}/${f}`, 'utf8');
    } catch {
      continue; // unreadable file — surfaced separately by rk doctor
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      continue; // malformed JSON — rk doctor quarantines
    }
    const result = parseTaskAlias(parsedJson, f.slice(0, -'.json'.length));
    if (result.ok) aliases.push(result.alias);
    // schema-invalid aliases skipped here; rk doctor surfaces them with detail
  }
  return aliases.sort((a, b) => a.id.localeCompare(b.id));
}

/** Find the unique task currently in `review`, if any. */
export async function findOnlyTaskInStatus(
  cwd: string,
  config: Config,
  status: TaskAlias['status'],
): Promise<TaskAlias | null> {
  const all = await listTaskAliases(cwd, config);
  const matching = all.filter((a) => a.status === status);
  if (matching.length !== 1) return null;
  return matching[0] ?? null;
}

export interface TaskAliasReconciliation {
  readonly id: TaskId;
  readonly path: string;
  readonly relativePath: string;
  readonly previousStatus: string;
  readonly nextStatus: TaskAlias['status'];
  readonly alias: TaskAlias;
}

export interface ReconcileTaskAliasesOptions {
  readonly taskId?: TaskId;
  readonly epicId?: string;
  readonly sprintId?: string;
  readonly apply?: boolean;
}

export async function reconcileTaskAliases(
  cwd: string,
  config: Config,
  opts: ReconcileTaskAliasesOptions = {},
): Promise<readonly TaskAliasReconciliation[]> {
  const aliases = (await listTaskAliases(cwd, config)).filter((alias) => {
    if (opts.taskId !== undefined && alias.id !== opts.taskId) return false;
    if (opts.epicId !== undefined && alias.epic_id !== opts.epicId) return false;
    if (opts.sprintId !== undefined && alias.sprint_id !== opts.sprintId) return false;
    return true;
  });
  if (aliases.length === 0) return [];

  const outcome = await loadProject({ cwd });
  if (!outcome.ok) return [];

  const updates: TaskAliasReconciliation[] = [];
  for (const alias of aliases) {
    const sprint = outcome.graph.sprints.get(alias.sprint_id);
    if (!sprint) continue;
    const epic = outcome.graph.epics.get(alias.epic_id);
    const next = reconcileAliasFromSprint(alias, sprint.status, sprint.closed_at, epic?.closed_at);
    if (!next) continue;

    if (opts.apply !== false) {
      await writeTaskAliasUpdate(cwd, config, next);
    }
    const path = taskAliasPath(cwd, config, alias.id);
    updates.push({
      id: alias.id,
      path,
      relativePath: relative(cwd, path),
      previousStatus: String(alias.status),
      nextStatus: next.status,
      alias: next,
    });
  }
  return updates;
}

export async function reconcileTaskAlias(
  cwd: string,
  config: Config,
  alias: TaskAlias,
  opts: { readonly apply?: boolean } = {},
): Promise<TaskAliasReconciliation | null> {
  const updates = await reconcileTaskAliases(cwd, config, {
    taskId: alias.id,
    ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
  });
  return updates[0] ?? null;
}

export async function reflectSprintStatusInAlias(
  cwd: string,
  config: Config,
  epicId: string,
  sprintId: string,
): Promise<TaskAlias | null> {
  const aliases = await listTaskAliases(cwd, config);
  const alias = aliases.find((a) => a.sprint_id === sprintId);
  if (!alias) return null;

  const worktreeSnapshot = await readSprintSnapshotFromWorktree(
    cwd,
    config,
    epicId,
    sprintId,
  ).catch(() => null);
  const snapshot = worktreeSnapshot ?? (await readSprintSnapshotFromMain(cwd, sprintId));
  if (!snapshot) return null;

  let next = reconcileAliasFromSprint(
    alias,
    snapshot.status,
    snapshot.closedAt,
    snapshot.epicClosedAt,
  );
  if (!next) return null;

  if (next.status === 'review') {
    const reviewSha = await readWorktreeBranchSha(cwd, config, epicId).catch(() => null);
    next = { ...next, review_sha: reviewSha ?? next.review_sha ?? null };
  }

  await writeTaskAliasUpdate(cwd, config, next);
  return next;
}

function reconcileAliasFromSprint(
  alias: TaskAlias,
  sprintStatus: string,
  sprintClosedAt?: string | null,
  epicClosedAt?: string | null,
): TaskAlias | null {
  const nextStatus = mapSprintStatusToAliasStatus(sprintStatus, alias.status);
  const currentStatus = isTaskAliasStatus(alias.status) ? alias.status : null;

  if (currentStatus !== null && isTerminal(currentStatus) && currentStatus !== nextStatus) {
    return null;
  }
  if (currentStatus !== null && statusRank(nextStatus) < statusRank(currentStatus)) {
    return null;
  }

  const nextClosedAt =
    isTerminal(nextStatus) && alias.closed_at === null
      ? (sprintClosedAt ?? epicClosedAt ?? new Date().toISOString())
      : alias.closed_at;

  if (alias.status === nextStatus && alias.closed_at === nextClosedAt) return null;

  return {
    ...alias,
    status: nextStatus,
    closed_at: nextClosedAt,
  };
}

function isTaskAliasStatus(status: unknown): status is TaskAlias['status'] {
  return (
    status === 'active' || status === 'review' || status === 'shipped' || status === 'cancelled'
  );
}

function isTerminal(status: TaskAlias['status']): boolean {
  return status === 'shipped' || status === 'cancelled';
}

function statusRank(status: TaskAlias['status']): number {
  if (status === 'active') return 0;
  if (status === 'review') return 1;
  return 2;
}

function mapSprintStatusToAliasStatus(
  sprintStatus: string,
  current: TaskAlias['status'],
): TaskAlias['status'] {
  switch (sprintStatus as SprintStatus) {
    case 'review':
      return 'review';
    case 'shipped':
      return 'shipped';
    case 'cancelled':
      return 'cancelled';
    case 'active':
    case 'queued':
    case 'planned':
    case 'pending':
    case 'reopened':
      return 'active';
    default:
      return isTaskAliasStatus(current) ? current : 'active';
  }
}

async function readWorktreeBranchSha(
  cwd: string,
  config: Config,
  epicId: string,
): Promise<string | null> {
  const branch = worktreeBranch(EpicIdSchema.parse(epicId), config);
  try {
    const { stdout } = await git(['-C', cwd, 'rev-parse', `refs/heads/${branch}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

interface SprintStatusSnapshot {
  readonly status: string;
  readonly closedAt: string | null;
  readonly epicClosedAt: string | null;
}

async function readSprintSnapshotFromMain(
  cwd: string,
  sprintId: string,
): Promise<SprintStatusSnapshot | null> {
  const outcome = await loadProject({ cwd });
  if (!outcome.ok) return null;
  const sprint = outcome.graph.sprints.get(sprintId);
  if (!sprint) return null;
  const epic = outcome.graph.epics.get(sprint.epic_id);
  return {
    status: sprint.status,
    closedAt: sprint.closed_at ?? null,
    epicClosedAt: epic?.closed_at ?? null,
  };
}

async function readSprintSnapshotFromWorktree(
  cwd: string,
  config: Config,
  epicId: string,
  sprintId: string,
): Promise<SprintStatusSnapshot | null> {
  const wtRoot = worktreePath(EpicIdSchema.parse(epicId), config, cwd);
  const dir = join(wtRoot, config.paths.sprints);
  const files = await readdir(dir).catch(() => [] as string[]);
  const re = new RegExp(`^${sprintId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-.+)?\\.md$`);
  const match = files.find((f) => re.test(f));
  if (!match) return null;
  const raw = await readFile(join(dir, match), 'utf8');
  const data = matter(raw).data as { status?: unknown; closed_at?: unknown };
  return {
    status: typeof data.status === 'string' ? data.status : '',
    closedAt: typeof data.closed_at === 'string' ? data.closed_at : null,
    epicClosedAt: null,
  };
}
