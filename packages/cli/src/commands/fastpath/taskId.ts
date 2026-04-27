import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '@repokernel/core';
import { TASK_ID_RE, type TaskId } from './types.js';

/**
 * Tasks live under `${config.paths.generated}/tasks/T-NNN.json` so they're
 * discoverable next to other RK-generated artifacts but invisible to the
 * existing epic/sprint discovery code.
 */
export function tasksDir(cwd: string, config: Config): string {
  return join(cwd, config.paths.generated, 'tasks');
}

export function taskAliasPath(cwd: string, config: Config, id: TaskId): string {
  return join(tasksDir(cwd, config), `${id}.json`);
}

/**
 * Compute the next sequential task ID by scanning the tasks directory.
 *
 * Stateless: no counter persisted in registry.json. The directory IS the
 * source of truth — `T-NNN` files map 1:1 to allocated IDs. Determinism is
 * preserved as long as callers acquire a lock around the scan + write.
 */
export async function nextTaskId(cwd: string, config: Config): Promise<TaskId> {
  const dir = tasksDir(cwd, config);
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir).catch(() => [] as string[]);
  const re = /^T-(\d+)\.json$/;
  const nums = files.flatMap((f) => {
    const m = re.exec(f);
    return m?.[1] !== undefined ? [parseInt(m[1], 10)] : [];
  });
  const n = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `T-${String(n).padStart(3, '0')}` as TaskId;
}

/**
 * Normalize user input: accept `T-1`, `T-001`, or `t-1` and return the
 * canonical zero-padded `T-NNN` form. Returns null when the input isn't a
 * recognizable task ID.
 */
export function normalizeTaskId(input: string): TaskId | null {
  const trimmed = input.trim();
  const m = /^[Tt]-(\d+)$/.exec(trimmed);
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isInteger(n) || n < 1) return null;
  const canonical = `T-${String(n).padStart(3, '0')}`;
  if (!TASK_ID_RE.test(canonical)) return null;
  return canonical as TaskId;
}

export function isTaskId(input: string): boolean {
  return normalizeTaskId(input) !== null;
}
