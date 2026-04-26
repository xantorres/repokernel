import { readFile, writeFile } from 'node:fs/promises';
import matter from 'gray-matter';

export async function mutateSprintFrontmatter(
  file: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const newData = { ...parsed.data, ...patch };
  await writeFile(file, matter.stringify(parsed.content, newData), 'utf8');
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
  await writeFile(file, matter.stringify(parsed.content, newData), 'utf8');
}

export async function mutateReviewFrontmatter(
  file: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const newData = { ...parsed.data, ...patch };
  await writeFile(file, matter.stringify(parsed.content, newData), 'utf8');
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
  await writeFile(queueFile, matter.stringify(parsed.content, newData), 'utf8');
}

export async function removeSprintFromQueue(queueFile: string, sprintId: string): Promise<void> {
  const raw = await readFile(queueFile, 'utf8');
  const parsed = matter(raw);
  const slots: unknown[] = Array.isArray(parsed.data.slots) ? parsed.data.slots : [];
  const filtered = slots.filter(
    (s): s is Record<string, unknown> =>
      typeof s === 'object' && s !== null && (s as Record<string, unknown>).sprint_id !== sprintId,
  );
  const renumbered = filtered.map((s, i) => ({ ...s, order: i }));
  const newData = { ...parsed.data, slots: renumbered };
  await writeFile(queueFile, matter.stringify(parsed.content, newData), 'utf8');
}
