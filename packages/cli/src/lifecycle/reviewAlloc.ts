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
    const startAt = nums.length ? Math.max(...nums) + 1 : 1;

    const result = new Map<SprintId, string>();

    for (let i = 0; i < sprintIds.length; i++) {
      const sprintId = sprintIds[i]!;
      const n = startAt + i;
      const id = `R-${String(n).padStart(3, '0')}`;
      const filePath = join(reviewsDir, `${id}.md`);

      const stub = buildStubReview(id, sprintId);
      let fd: Awaited<ReturnType<typeof open>>;
      try {
        fd = await open(filePath, 'wx');
      } catch {
        // File exists — ID collision despite the lock (stale state). Use a suffix.
        const altId = `R-${String(n).padStart(3, '0')}-${sprintId.toLowerCase()}`;
        const altPath = join(reviewsDir, `${altId}.md`);
        fd = await open(altPath, 'wx');
        result.set(sprintId, altId);
        await fd.writeFile(buildStubReview(altId, sprintId), 'utf8');
        await fd.close();
        continue;
      }
      await fd.writeFile(stub, 'utf8');
      await fd.close();
      result.set(sprintId, id);
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
---

Pending review — wave sprint ${sprintId}.
`;
}
