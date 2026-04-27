import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Config } from '@repokernel/core';
import { taskAliasPath, tasksDir } from './taskId.js';
import type { TaskAlias, TaskId } from './types.js';

const TASK_ALIAS_FILE_RE = /^T-\d+\.json$/;

export async function readTaskAlias(
  cwd: string,
  config: Config,
  id: TaskId,
): Promise<TaskAlias | null> {
  const path = taskAliasPath(cwd, config, id);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as TaskAlias;
    return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw cause;
  }
}

export async function writeTaskAlias(cwd: string, config: Config, alias: TaskAlias): Promise<void> {
  const path = taskAliasPath(cwd, config, alias.id);
  await mkdir(dirname(path), { recursive: true });
  // wx prevents accidental overwrite during initial allocation; callers
  // doing intentional updates must use writeTaskAliasUpdate below.
  await writeFile(path, `${JSON.stringify(alias, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export async function writeTaskAliasUpdate(
  cwd: string,
  config: Config,
  alias: TaskAlias,
): Promise<void> {
  const path = taskAliasPath(cwd, config, alias.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(alias, null, 2)}\n`, 'utf8');
}

export async function listTaskAliases(cwd: string, config: Config): Promise<readonly TaskAlias[]> {
  const dir = tasksDir(cwd, config);
  const files = await readdir(dir).catch(() => [] as string[]);
  const aliases: TaskAlias[] = [];
  for (const f of files) {
    if (!TASK_ALIAS_FILE_RE.test(f)) continue;
    try {
      const raw = await readFile(`${dir}/${f}`, 'utf8');
      aliases.push(JSON.parse(raw) as TaskAlias);
    } catch {
      // skip corrupt alias files
    }
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
