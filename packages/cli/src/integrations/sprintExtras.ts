import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withLockRetrying } from '../lifecycle/locks.js';
import { mutateSprintFrontmatter } from '../lifecycle/mutate.js';

type ExtrasUpdate = (extras: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/**
 * Serialise all sprint `extras` read-modify-write operations through one lock
 * key. PR and tracker metadata share the same frontmatter object, so
 * feature-specific locks would clobber each other's sibling keys.
 *
 * Implementation notes:
 *  - Lock key is a SHA-256 of the canonicalised file path. Avoids the
 *    `/`-collapsed sanitiser collisions where two distinct paths could share
 *    a lock key (`_a_b_c.md` for both `/a/b/c.md` and `/a-b-c.md`).
 *  - File is canonicalised via `realpath` before hashing so two callers that
 *    reach the same file via different absolute or symlinked paths share a
 *    lock. If the file does not exist yet (e.g. caller about to create it),
 *    the resolved path is used instead.
 *  - The mutator receives the existing `extras` object (frozen from the
 *    on-disk frontmatter) and returns the FULL replacement extras. Both
 *    current callers spread `...extras` to preserve siblings — the type does
 *    not enforce this; future callers should follow the same pattern.
 */
export async function mutateSprintExtras(
  file: string,
  opRoot: string,
  mutate: ExtrasUpdate,
): Promise<void> {
  let canonical: string;
  try {
    canonical = await realpath(file);
  } catch {
    canonical = resolve(file);
  }
  await withLockRetrying(`sprint-extras-${hashLockKey(canonical)}`, opRoot, async () => {
    await mutateSprintFrontmatter(file, (data) => {
      const existingExtras =
        data.extras && typeof data.extras === 'object' && !Array.isArray(data.extras)
          ? (data.extras as Record<string, unknown>)
          : {};
      return { ...data, extras: mutate(existingExtras) };
    });
  });
}

function hashLockKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}
