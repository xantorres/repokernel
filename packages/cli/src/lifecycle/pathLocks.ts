import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from './locks.js';

/**
 * Per-path file locks layered on top of the per-name `acquireLock`
 * primitive. Each lock name is the SHA-256 of the normalized path so the
 * lock filename is filesystem-safe regardless of glob characters or
 * separators in the input.
 *
 * Two `rk run --worktree` invocations targeting sprints with overlapping
 * `allowed_paths` use this to serialize on the conflicting subtree. The
 * parallel-plan resolver already groups disjoint sprints into the same
 * wave — these locks are the runtime safety net for the case where a
 * coordinator schedules in defiance of the plan (or two coordinators
 * race).
 *
 * Returns an aggregate release that unlocks every path on rollback or
 * normal completion. Acquisition is all-or-nothing: if any single path
 * cannot be locked, every already-locked path is released before the
 * error propagates.
 */
export async function acquirePathLocks(
  paths: readonly string[],
  opRoot: string,
): Promise<() => Promise<void>> {
  const dir = join(opRoot, 'path-locks');
  await mkdir(dir, { recursive: true });

  // Sort paths so two concurrent acquirers requesting overlapping sets
  // attempt locks in the same order — no AB/BA deadlock possible.
  const ordered = [...new Set(paths.map(normalizePathForLock))].sort();
  const releases: Array<() => Promise<void>> = [];

  for (const path of ordered) {
    const name = pathLockName(path);
    try {
      const release = await acquireLock(name, opRoot);
      releases.push(release);
    } catch (cause) {
      // Roll back partially-acquired locks so the next attempt sees a
      // clean slate.
      await Promise.all(
        releases.map((r) =>
          r().catch(() => {
            // best-effort cleanup
          }),
        ),
      );
      throw cause;
    }
  }

  return async () => {
    await Promise.all(
      releases.map((r) =>
        r().catch(() => {
          // best-effort: a release that fails has already produced its own
          // error trail in the lock file's stale-cleanup path.
        }),
      ),
    );
  };
}

/**
 * Map a path or glob to a deterministic lock name. The SHA-256 is folded
 * to 16 hex chars (64 bits) which is plenty of entropy to avoid
 * collisions across the small set of paths a project tracks, and short
 * enough to keep the on-disk lock filenames readable.
 */
export function pathLockName(path: string): string {
  const hash = createHash('sha256').update(normalizePathForLock(path)).digest('hex').slice(0, 16);
  return `path-${hash}`;
}

function normalizePathForLock(path: string): string {
  // Trim trailing slash and strip glob tail so `apps/web/**` and
  // `apps/web/page.tsx` lock the same subtree (matching the
  // `pathsOverlap` semantics in `planParallelWaves`).
  let p = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const idx = p.search(/[*?{[]/u);
  if (idx !== -1) p = p.slice(0, idx).replace(/\/+$/, '');
  return p || '/';
}

/**
 * Convenience: acquire path locks, run `fn`, release in `finally` (even on
 * throw). Mirrors `withLock` / `withLifecycleScope` ergonomics.
 */
export async function withPathLocks<T>(
  paths: readonly string[],
  opRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquirePathLocks(paths, opRoot);
  try {
    return await fn();
  } finally {
    await release();
  }
}
