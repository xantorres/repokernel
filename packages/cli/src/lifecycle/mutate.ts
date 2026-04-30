import { readFile } from 'node:fs/promises';
import {
  EPIC_STATUSES,
  type EpicStatus,
  RepoKernelError,
  SPRINT_STATUSES,
  type SprintStatus,
} from '@repokernel/core';
import matter from 'gray-matter';
import { atomicWriteText } from './atomicWrite.js';
import { withLockRetrying } from './locks.js';

function isSprintStatus(value: string): value is SprintStatus {
  return (SPRINT_STATUSES as readonly string[]).includes(value);
}

function isEpicStatus(value: string): value is EpicStatus {
  return (EPIC_STATUSES as readonly string[]).includes(value);
}

/**
 * Reject `status` patches that fall outside the canonical enum before writing
 * to disk. Treats explicit `undefined` as invalid (the common bug source —
 * a partial transition leaves the field unset and the spread persists
 * `status: null` to YAML). Callers that genuinely want to clear `status`
 * must use `deleteSprintFrontmatterKeys` instead. See rk-issues 2026-04-29
 * entry on S-070.
 */
function assertSprintStatusValid(value: unknown): void {
  if (typeof value !== 'string' || !isSprintStatus(value)) {
    throw new RepoKernelError(
      'INVALID_FRONTMATTER',
      `invalid sprint status "${String(value)}" (must be one of: ${SPRINT_STATUSES.join(' | ')})`,
    );
  }
}

function assertEpicStatusValid(value: unknown): void {
  if (typeof value !== 'string' || !isEpicStatus(value)) {
    throw new RepoKernelError(
      'INVALID_FRONTMATTER',
      `invalid epic status "${String(value)}" (must be one of: ${EPIC_STATUSES.join(' | ')})`,
    );
  }
}

export async function mutateSprintFrontmatter(
  file: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.hasOwn(patch, 'status')) assertSprintStatusValid(patch.status);
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const newData = { ...parsed.data, ...patch };
  await atomicWriteText(file, matter.stringify(parsed.content, newData));
}

export async function deleteSprintFrontmatterKeys(
  file: string,
  keys: readonly string[],
): Promise<void> {
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const newData = { ...parsed.data };
  for (const k of keys) {
    delete (newData as Record<string, unknown>)[k];
  }
  await atomicWriteText(file, matter.stringify(parsed.content, newData));
}

export async function mutateReviewFrontmatter(
  file: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const newData = { ...parsed.data, ...patch };
  await atomicWriteText(file, matter.stringify(parsed.content, newData));
}

export async function mutateEpicFrontmatter(
  file: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.hasOwn(patch, 'status')) assertEpicStatusValid(patch.status);
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const newData = { ...parsed.data, ...patch };
  await atomicWriteText(file, matter.stringify(parsed.content, newData));
}

export async function reorderQueueSlots(
  queueFile: string,
  orderedSprintIds: readonly string[],
): Promise<void> {
  const raw = await readFile(queueFile, 'utf8');
  const parsed = matter(raw);
  const slots: unknown[] = Array.isArray(parsed.data.slots) ? parsed.data.slots : [];

  // Build a lookup from sprint_id → existing slot (preserves Q-NNN id)
  const slotBySprintId = new Map<string, Record<string, unknown>>();
  for (const s of slots) {
    if (typeof s === 'object' && s !== null) {
      const slot = s as Record<string, unknown>;
      if (typeof slot.sprint_id === 'string') {
        slotBySprintId.set(slot.sprint_id, slot);
      }
    }
  }

  // Ordered IDs first, then remaining in their original relative order
  const seenIds = new Set(orderedSprintIds);
  const tailSlots = slots.filter(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as Record<string, unknown>).sprint_id === 'string' &&
      !seenIds.has((s as Record<string, unknown>).sprint_id as string),
  );

  const reordered: Record<string, unknown>[] = [];
  for (const id of orderedSprintIds) {
    const slot = slotBySprintId.get(id);
    if (slot) reordered.push(slot);
  }
  reordered.push(...tailSlots);

  const renumbered = reordered.map((s, i) => ({ ...s, order: i }));
  const newData = { ...parsed.data, slots: renumbered };
  await atomicWriteText(queueFile, matter.stringify(parsed.content, newData));
}

export type RemoveSlotResult =
  | {
      kind: 'removed';
      removed: { id: string; sprint_id: string; order: number };
    }
  | {
      kind: 'missing';
      currentSprintIds: readonly string[];
    };

/**
 * Remove a queue slot under the per-lane queue lock. Reloading inside the lock
 * prevents concurrent add/remove writes from overwriting each other with stale
 * slot snapshots.
 */
export async function removeSlotFromQueue(
  queueFile: string,
  sprintId: string,
  opRoot: string,
  lane: string,
): Promise<RemoveSlotResult> {
  return withLockRetrying(`queue-${lane}`, opRoot, async () => {
    const raw = await readFile(queueFile, 'utf8');
    const parsed = matter(raw);
    const currentSlots = readQueueSlots(parsed.data.slots);

    const existing = currentSlots.find((s) => s.sprint_id === sprintId);
    if (!existing) {
      return { kind: 'missing', currentSprintIds: currentSlots.map((s) => s.sprint_id) };
    }

    const renumbered = currentSlots
      .filter((s) => s.sprint_id !== sprintId)
      .map((s, i) => ({ ...s, order: i }));
    const newData = { ...parsed.data, slots: renumbered };
    await atomicWriteText(queueFile, matter.stringify(parsed.content, newData));
    return { kind: 'removed', removed: existing };
  });
}

function readQueueSlots(value: unknown): Array<{ id: string; sprint_id: string; order: number }> {
  return (Array.isArray(value) ? value : [])
    .filter(
      (s): s is Record<string, unknown> => typeof s === 'object' && s !== null && !Array.isArray(s),
    )
    .map((s) => ({
      id: typeof s.id === 'string' ? s.id : '',
      sprint_id: typeof s.sprint_id === 'string' ? s.sprint_id : '',
      order: typeof s.order === 'number' ? s.order : 0,
    }));
}
