import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ambientJournalWrite } from './journal.js';

/**
 * Persistent monotonic ID counters for sprint, epic, and review entities.
 *
 * Storage: <opRoot>/counters/<kind>.json where opRoot = <git-common-dir>/repokernel.
 * git-common-dir is shared across all worktrees of the same repository, so the
 * counter is the single source of truth even when parallel worktree agents are
 * each working in their own working-tree copy of sprints/, epics/, and reviews/.
 *
 * Why not tracked in the working tree? merge=union does not produce a valid
 * JSON document, and any tracked counter would still see colliding allocations
 * across separate clones (which a counter scheme without remote synchronization
 * cannot prevent). Storing in the shared .git directory avoids merge conflicts
 * while still solving the in-repo parallel-worktree case that DomicileVault hit.
 *
 * Migration: when the counter file is absent (fresh repo, or first run after
 * upgrade), the initial value is seeded from a one-time scan of the entity
 * directory. Subsequent calls read the counter directly.
 *
 * Locking: each helper here is wrapped in withLock('<kind>-id', opRoot, ...).
 * Callers that already hold a wider lock (e.g. the wave lock in `rk run`) may
 * use the lower-level allocateUnderLock helper to avoid double-locking.
 */

export type CounterKind = 'sprint' | 'epic' | 'review';

const KIND_TO_PREFIX: Record<CounterKind, 'S' | 'E' | 'R'> = {
  sprint: 'S',
  epic: 'E',
  review: 'R',
};

interface CounterFile {
  next: number;
}

function counterPath(opRoot: string, kind: CounterKind): string {
  return join(opRoot, 'counters', `${kind}s.json`);
}

async function readCounter(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const obj = JSON.parse(raw) as CounterFile;
    if (typeof obj.next !== 'number' || !Number.isInteger(obj.next) || obj.next < 1) {
      return null;
    }
    return obj.next;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw cause;
  }
}

async function writeCounter(path: string, next: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await ambientJournalWrite(path, `${JSON.stringify({ next }, null, 2)}\n`);
}

async function seedFromDirectory(entityDir: string, prefix: 'S' | 'E' | 'R'): Promise<number> {
  const files = await readdir(entityDir).catch(() => [] as string[]);
  const re = new RegExp(`^${prefix}-(\\d+)(?:-.+)?\\.md$`);
  const nums = files.flatMap((f) => {
    const m = re.exec(f);
    return m?.[1] !== undefined ? [Number.parseInt(m[1], 10)] : [];
  });
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

/**
 * Read or seed the counter for a kind. Caller must hold the appropriate lock.
 */
export async function readOrSeedCounter(
  opRoot: string,
  kind: CounterKind,
  entityDir: string,
): Promise<number> {
  const path = counterPath(opRoot, kind);
  const stored = await readCounter(path);
  if (stored !== null) return stored;
  return seedFromDirectory(entityDir, KIND_TO_PREFIX[kind]);
}

/**
 * Persist the next-counter value. Caller must hold the appropriate lock.
 */
export async function writeNext(opRoot: string, kind: CounterKind, next: number): Promise<void> {
  await writeCounter(counterPath(opRoot, kind), next);
}

/**
 * Format a numeric counter value as the canonical ID string (e.g. 153 → "S-153").
 */
export function formatId(kind: CounterKind, n: number): string {
  return `${KIND_TO_PREFIX[kind]}-${String(n).padStart(3, '0')}`;
}
