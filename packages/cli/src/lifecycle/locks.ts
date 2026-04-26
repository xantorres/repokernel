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

  let fd: Awaited<ReturnType<typeof open>> | null;
  try {
    fd = await tryOpenLock(lockPath);
    if (!fd) {
      const stale = await removeIfStale(lockPath);
      if (stale) fd = await tryOpenLock(lockPath);
    }
  } catch (cause) {
    throw new RepoKernelError('IO_ERROR', `could not acquire lock "${name}"`, cause);
  }
  if (!fd) {
    const owner = await readLockOwner(lockPath);
    throw new RepoKernelError(
      'IO_ERROR',
      `lock "${name}" is held by ${owner} — another rk run may be active`,
    );
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

async function readLockOwner(lockPath: string): Promise<string> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as LockContent;
    return `pid ${parsed.pid} (${parsed.command}) at ${parsed.created_at}`;
  } catch {
    return 'unknown process';
  }
}

async function tryOpenLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>> | null> {
  try {
    return await open(lockPath, 'wx');
  } catch (cause: unknown) {
    const isExist =
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause as NodeJS.ErrnoException).code === 'EEXIST';
    if (isExist) return null;
    throw cause;
  }
}

async function removeIfStale(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as LockContent;
    if (isPidAlive(parsed.pid)) return false;
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EPERM';
  }
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
