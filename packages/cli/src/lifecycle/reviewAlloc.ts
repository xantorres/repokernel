import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SprintId } from '@repokernel/core';
import matter from 'gray-matter';
import { atomicCreateText } from './atomicWrite.js';
import { formatId, readOrSeedCounter, writeNext } from './counters.js';
import { withLockRetrying } from './locks.js';

function isoNow(): string {
  return new Date().toISOString();
}

export interface ReviewAllocation {
  readonly reviewId: string;
  /** True when an existing pending stub for the same sprint was reused (no counter advance, no file write). */
  readonly reused: boolean;
}

/**
 * Atomically allocate N review IDs and create stub review files for each sprint.
 *
 * Idempotent by sprint_id: if a `verdict: pending` review file already exists
 * for a given sprint, that ID is returned (no counter advance, no file write).
 * This prevents counter-slot waste from repeated probes (`rk review-allocate`
 * called twice for the same sprint during testing or re-runs).
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
 * @returns Map from SprintId → allocation info ({ reviewId, reused })
 */
export async function allocateReviewIds(
  sprintIds: readonly SprintId[],
  reviewsDir: string,
  opRoot: string,
  reviewer = 'agent',
): Promise<Map<SprintId, ReviewAllocation>> {
  if (sprintIds.length === 0) return new Map();

  return withLockRetrying('review-id', opRoot, async () => {
    await mkdir(reviewsDir, { recursive: true });
    const pendingBySprint = await scanPendingReviewsBySprint(reviewsDir);
    let next = await readOrSeedCounter(opRoot, 'review', reviewsDir);
    const result = new Map<SprintId, ReviewAllocation>();
    let counterAdvanced = false;

    for (const sprintId of sprintIds) {
      // Idempotency: if a pending stub already exists for this sprint, reuse it.
      const existing = pendingBySprint.get(sprintId);
      if (existing) {
        result.set(sprintId, { reviewId: existing, reused: true });
        continue;
      }

      // Loop only on EEXIST: if a stub file already occupies this counter slot
      // (from an out-of-band manual create), advance to the next slot.
      while (true) {
        const id = formatId('review', next);
        const filePath = join(reviewsDir, `${id}.md`);
        try {
          // atomicCreateText: temp+link first-create, EEXIST behaves
          // identically to the previous open(filePath, 'wx') so the
          // counter-advance fallback below is unchanged. A crash mid-write
          // cannot publish a half-written stub.
          await atomicCreateText(filePath, buildStubReview(id, sprintId, reviewer));
          result.set(sprintId, { reviewId: id, reused: false });
          // Track this sprint as now-pending so a duplicate sprintId in the
          // same call reuses the freshly-allocated id rather than advancing.
          pendingBySprint.set(sprintId, id);
          next++;
          counterAdvanced = true;
          break;
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException | undefined)?.code;
          if (code !== 'EEXIST') throw cause;
          next++;
          counterAdvanced = true;
        }
      }
    }

    if (counterAdvanced) await writeNext(opRoot, 'review', next);
    return result;
  });
}

/**
 * Scan reviews dir and return a map of sprintId → reviewId for every review
 * file currently in `verdict: pending` state. First-found wins on duplicates
 * (deterministic via sorted readdir).
 */
async function scanPendingReviewsBySprint(reviewsDir: string): Promise<Map<string, string>> {
  const pending = new Map<string, string>();
  let files: string[];
  try {
    files = await readdir(reviewsDir);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return pending;
    throw cause;
  }
  files.sort();
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    let raw: string;
    try {
      raw = await readFile(join(reviewsDir, f), 'utf8');
    } catch {
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = matter(raw).data as Record<string, unknown>;
    } catch {
      continue;
    }
    if (data.verdict !== 'pending') continue;
    const sprintId = typeof data.sprint_id === 'string' ? data.sprint_id : null;
    const reviewId = typeof data.id === 'string' ? data.id : null;
    if (!sprintId || !reviewId) continue;
    if (!pending.has(sprintId)) pending.set(sprintId, reviewId);
  }
  return pending;
}

function buildStubReview(id: string, sprintId: string, reviewer: string): string {
  return `---
id: ${id}
sprint_id: ${sprintId}
verdict: pending
reviewer: ${JSON.stringify(reviewer)}
findings: []  # LEAVE EMPTY — populate causes REVIEW_INVALID_FINDING_SHAPE (P0). All finding detail goes in the body markdown below.
created_at: ${isoNow()}
changed_files: []
paths_checked:
  denied_paths_clean: true
---

# ${id}: Review ${sprintId}

Pending review for wave sprint ${sprintId}.
`;
}
