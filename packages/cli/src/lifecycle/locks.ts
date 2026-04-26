import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RepoKernelError } from '@repokernel/core';
import { lockRoot } from './controlPaths.js';

interface LockContent {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly created_at: string;
}

export async function acquireLock(name: string, opRoot: string): Promise<() => Promise<void>> {
  const dir = lockRoot(opRoot);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, `${name}.lock`);

  const content: LockContent = {
    pid: process.pid,
    command: process.argv.slice(2).join(' '),
    cwd: process.cwd(),
    created_at: new Date().toISOString(),
  };

  let fd: Awaited<ReturnType<typeof open>>;
  try {
    fd = await open(lockPath, 'wx');
  } catch (cause: unknown) {
    const isExist =
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause as NodeJS.ErrnoException).code === 'EEXIST';
    if (isExist) {
      let owner = 'unknown process';
      try {
        const raw = await readFile(lockPath, 'utf8');
        const parsed = JSON.parse(raw) as LockContent;
        owner = `pid ${parsed.pid} (${parsed.command}) at ${parsed.created_at}`;
      } catch {
        // ignore read failure
      }
      throw new RepoKernelError(
        'IO_ERROR',
        `lock "${name}" is held by ${owner} — another rk run may be active`,
      );
    }
    throw new RepoKernelError('IO_ERROR', `could not acquire lock "${name}"`, cause);
  }

  await fd.writeFile(JSON.stringify(content, null, 2), 'utf8');
  await fd.close();

  return async () => {
    try {
      await unlink(lockPath);
    } catch {
      // ignore — lock file already gone
    }
  };
}

export async function withLock<T>(name: string, opRoot: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(name, opRoot);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Acquire the wave lock for a run.
 * Protects wave transitions: alloc, pending_wave mutations, merge, close, advance.
 * Lock name: wave-<runId>
 */
export function withWaveLock<T>(runId: string, opRoot: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`wave-${runId}`, opRoot, fn);
}
