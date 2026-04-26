import { mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SprintId } from '@repokernel/core';
import { withLock } from './locks.js';

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
 * @param sprintIds - Ordered list of sprints needing reviews (one ID per sprint)
 * @param reviewsDir - Absolute path to the project's reviews directory
 * @param opRoot - Operational root (for the review-id lock)
 * @returns Map from SprintId → allocated ReviewId
 */
export async function allocateReviewIds(
  sprintIds: readonly SprintId[],
  reviewsDir: string,
  opRoot: string,
): Promise<Map<SprintId, string>> {
  if (sprintIds.length === 0) return new Map();

  return withLock('review-id', opRoot, async () => {
    await mkdir(reviewsDir, { recursive: true });

    const files = await readdir(reviewsDir).catch(() => [] as string[]);
    const re = /^R-(\d+)(?:-.+)?\.md$/;
    const nums = files.flatMap((f) => {
      const m = re.exec(f);
      return m?.[1] !== undefined ? [parseInt(m[1], 10)] : [];
    });
    const used = new Set(nums);
    let next = nums.length ? Math.max(...nums) + 1 : 1;

    const result = new Map<SprintId, string>();

    for (const sprintId of sprintIds) {
      while (used.has(next)) next++;
      while (true) {
        const id = `R-${String(next).padStart(3, '0')}`;
        const filePath = join(reviewsDir, `${id}.md`);
        try {
          const fd = await open(filePath, 'wx');
          await fd.writeFile(buildStubReview(id, sprintId), 'utf8');
          await fd.close();
          used.add(next);
          next++;
          result.set(sprintId, id);
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'EEXIST') throw cause;
          used.add(next);
          next++;
        }
      }
    }

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
