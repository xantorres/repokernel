import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RepoKernelError } from '@repokernel/core';
import { lockRoot } from './controlPaths.js';

interface LockContent {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly created_at: string;
  /**
   * crypto.randomUUID per acquire. Release reads the lock file and only
   * unlinks if the nonce matches the in-memory nonce — so a stale-cleanup
   * cycle that happens between acquire and the new owner writing its lock
   * cannot accidentally have the *previous* (already-dead) owner's release
   * delete the new owner's lock.
   */
  readonly nonce: string;
}

export async function acquireLock(name: string, opRoot: string): Promise<() => Promise<void>> {
  const dir = lockRoot(opRoot);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, `${name}.lock`);

  const nonce = randomUUID();
  const content: LockContent = {
    pid: process.pid,
    command: process.argv.slice(2).join(' '),
    cwd: process.cwd(),
    created_at: new Date().toISOString(),
    nonce,
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
    await releaseIfOwned(lockPath, nonce);
  };
}

/**
 * Release the lock at `lockPath` only when its on-disk `nonce` matches the
 * one we acquired with. Without this check, a sequence like:
 *
 *   1. Process A acquires the lock (nonce N1).
 *   2. Process A becomes unresponsive (long stall, killed but PID reused).
 *   3. Process B sees a stale lock (PID dead), removes it.
 *   4. Process B acquires the lock (nonce N2).
 *   5. Process A wakes up, runs its release handler.
 *   6. Without a nonce check, A's `unlink` deletes B's lock.
 *
 * The nonce gates step 6: the lock on disk has N2 (B's), so A's release —
 * which carries N1 — sees a mismatch and refuses to unlink. Best-effort:
 * a corrupt lock file fails the JSON parse and we leave it alone.
 */
async function releaseIfOwned(lockPath: string, expectedNonce: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockContent>;
    if (parsed.nonce !== expectedNonce) {
      // Someone else owns it now — don't touch.
      return;
    }
    await unlink(lockPath);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return; // already gone
    // Corrupt lock file or unreadable parent — give up silently to match
    // the previous best-effort behavior. A subsequent acquire will see the
    // stale file and clean it via removeIfStale.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Variant of `withLock` that retries a busy lock with exponential backoff
 * before giving up. Use for high-contention paths where multiple rk
 * processes (e.g. concurrent worktree agents calling `rk review-allocate`)
 * legitimately race for the same lock for milliseconds at a time.
 *
 * Long-held locks (legitimately busy waves or dead processes) still surface
 * as errors after the deadline.
 */
export async function withLockRetrying<T>(
  name: string,
  opRoot: string,
  fn: () => Promise<T>,
  options: {
    deadlineMs?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  } = {},
): Promise<T> {
  const deadlineMs = options.deadlineMs ?? 5_000;
  const initialDelayMs = options.initialDelayMs ?? 25;
  const maxDelayMs = options.maxDelayMs ?? 200;
  const deadline = Date.now() + deadlineMs;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await withLock(name, opRoot, fn);
    } catch (cause) {
      const isContention =
        cause instanceof RepoKernelError && cause.message.includes(`lock "${name}" is held`);
      if (!isContention || Date.now() >= deadline) {
        throw cause;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
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
