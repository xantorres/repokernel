import { readFile } from 'node:fs/promises';
import {
  RepoKernelError,
  type TrackerMetadata,
  TrackerMetadataSchema,
  type TrackerProvider,
} from '@repokernel/core';
import matter from 'gray-matter';
import { mutateSprintExtras } from '../sprintExtras.js';

/**
 * Read tracker metadata from a sprint file's `extras.tracker` block.
 * Returns `null` when no metadata is present. Throws when the value is
 * present but malformed — corrupting the bridge silently is worse than
 * surfacing the error to the user.
 */
export async function readTrackerMetadata(file: string): Promise<TrackerMetadata | null> {
  const raw = await readFile(file, 'utf8');
  const parsed = matter(raw);
  const extras = (parsed.data as Record<string, unknown>).extras;
  if (!extras || typeof extras !== 'object') return null;
  const tracker = (extras as Record<string, unknown>).tracker;
  if (!tracker || typeof tracker !== 'object') return null;
  const result = TrackerMetadataSchema.safeParse(tracker);
  if (!result.success) {
    throw new RepoKernelError(
      'INVALID_FRONTMATTER',
      `tracker metadata in ${file} is malformed: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

/**
 * Persist tracker metadata under `extras.tracker`. Other entries in
 * `extras` are preserved.
 *
 * Read-modify-write is wrapped in a per-file lock so two concurrent
 * `rk tracker {comment, link-pr, transition}` invocations cannot
 * silently lose each other's writes.
 */
export async function writeTrackerMetadata(
  file: string,
  metadata: TrackerMetadata,
  opRoot: string,
): Promise<void> {
  await mutateSprintExtras(file, opRoot, (extras) => ({ ...extras, tracker: metadata }));
}

/**
 * Convenience helper: stamp a sync timestamp and merge a synced-field
 * marker without losing earlier markers.
 */
export function stampSync(
  metadata: TrackerMetadata,
  field: TrackerMetadata['synced_fields'][number],
  now: () => Date = () => new Date(),
): TrackerMetadata {
  const merged = new Set([...metadata.synced_fields, field]);
  return {
    ...metadata,
    sync_at: now().toISOString(),
    synced_fields: [...merged],
  };
}

export function makeInitialMetadata(args: {
  readonly provider: TrackerProvider;
  readonly issueId: string;
  readonly issueUrl?: string;
  readonly now?: () => Date;
}): TrackerMetadata {
  const now = (args.now ?? (() => new Date()))();
  const result: TrackerMetadata = {
    provider: args.provider,
    issue_id: args.issueId,
    sync_at: now.toISOString(),
    synced_fields: [],
  };
  if (args.issueUrl) {
    return TrackerMetadataSchema.parse({ ...result, issue_url: args.issueUrl });
  }
  return TrackerMetadataSchema.parse(result);
}
