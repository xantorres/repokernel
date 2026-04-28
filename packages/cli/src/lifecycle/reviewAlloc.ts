import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SprintId } from '@repokernel/core';
import { formatId, readOrSeedCounter, writeNext } from './counters.js';
import { withLockRetrying } from './locks.js';

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Atomically allocate N review IDs and create stub review files for each sprint.
 *
 * Called under the wave lock to ensure review IDs are reserved before any
 * parallel agents start. Stub files have verdict=pending; the lifecycle close
 * step updates them with final diff details (sha, changed_files, verdict).
 *
 * Allocation source of truth: <opRoot>/counters/reviews.json (worktree-shared
 * via git-common-dir). The counter is seeded from a directory scan on first
 * use to migrate existing repos transparently. Stub files are still created
 * with the `wx` open flag so any pre-existing review file (e.g. a manual one
 * created out-of-band) advances the counter rather than being overwritten.
 *
 * @param sprintIds - Ordered list of sprints needing reviews (one ID per sprint)
 * @param reviewsDir - Absolute path to the project's reviews directory
 * @param opRoot - Operational root (for the review-id lock and counter file)
 * @returns Map from SprintId → allocated ReviewId
 */
export async function allocateReviewIds(
  sprintIds: readonly SprintId[],
  reviewsDir: string,
  opRoot: string,
): Promise<Map<SprintId, string>> {
  if (sprintIds.length === 0) return new Map();

  return withLockRetrying('review-id', opRoot, async () => {
    await mkdir(reviewsDir, { recursive: true });
    let next = await readOrSeedCounter(opRoot, 'review', reviewsDir);
    const result = new Map<SprintId, string>();

    for (const sprintId of sprintIds) {
      // Loop only on EEXIST: if a stub file already occupies this counter slot
      // (from an out-of-band manual create), advance to the next slot.
      while (true) {
        const id = formatId('review', next);
        const filePath = join(reviewsDir, `${id}.md`);
        try {
          const fd = await open(filePath, 'wx');
          await fd.writeFile(buildStubReview(id, sprintId), 'utf8');
          await fd.close();
          result.set(sprintId, id);
          next++;
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'EEXIST') throw cause;
          next++;
        }
      }
    }

    await writeNext(opRoot, 'review', next);
    return result;
  });
}

function buildStubReview(id: string, sprintId: string): string {
  return `---
id: ${id}
sprint_id: ${sprintId}
verdict: pending
reviewer: agent
findings: []
created_at: ${isoNow()}
changed_files: []
paths_checked:
  denied_paths_clean: true
---

# ${id}: Review ${sprintId}

Pending review for wave sprint ${sprintId}.
`;
}
