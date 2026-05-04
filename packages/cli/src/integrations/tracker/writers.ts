import type { TrackerMetadata } from '@repokernel/core';
import { getTrackerAdapter } from '../../trackers/index.js';
import type { TrackerWriteOutcome } from '../../trackers/types.js';

/**
 * Write-side bridge dispatch.
 *
 * Each operation looks up the adapter for the metadata's provider and
 * forwards the call. Adapters express capability via the optional
 * methods on `TrackerAdapter` — when an adapter does not implement an
 * operation, the dispatch surface returns `{ ok: false, reason: 'not_implemented' }`
 * so the caller never has to enumerate provider capability tables.
 *
 * Linear and Jira adapters do NOT yet implement write operations. The
 * behaviour is "graceful decline" rather than "throw", because v1.13's
 * tracker bridge advertises read-only ingest plus best-effort writes,
 * and a thrown error in the close-loop would crash the dispatch layer.
 */

export type { TrackerWriteOutcome } from '../../trackers/types.js';

export async function commentOnTicket(
  metadata: TrackerMetadata,
  body: string,
): Promise<TrackerWriteOutcome> {
  if (body.length === 0) return { ok: false, reason: 'empty_body' };
  const adapter = getTrackerAdapter(metadata.provider);
  if (typeof adapter.comment !== 'function') {
    return { ok: false, reason: 'not_implemented' };
  }
  return adapter.comment(metadata.issue_id, body);
}

export async function linkPrToTicket(
  metadata: TrackerMetadata,
  prUrl: string,
): Promise<TrackerWriteOutcome> {
  if (!isHttpUrl(prUrl)) return { ok: false, reason: 'invalid_pr_url' };
  const adapter = getTrackerAdapter(metadata.provider);
  if (typeof adapter.linkPr === 'function') {
    return adapter.linkPr(metadata.issue_id, prUrl);
  }
  // Fall back to a comment containing the URL for adapters that haven't
  // implemented a dedicated link primitive yet.
  if (typeof adapter.comment === 'function') {
    return adapter.comment(metadata.issue_id, `RepoKernel: linked pull request ${prUrl}`);
  }
  return { ok: false, reason: 'not_implemented' };
}

export async function transitionTicket(
  metadata: TrackerMetadata,
  state: string,
): Promise<TrackerWriteOutcome> {
  if (state.length === 0) return { ok: false, reason: 'empty_state' };
  const adapter = getTrackerAdapter(metadata.provider);
  if (typeof adapter.transition !== 'function') {
    return { ok: false, reason: 'not_implemented' };
  }
  return adapter.transition(metadata.issue_id, state);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
