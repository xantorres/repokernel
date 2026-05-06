import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicCreateText } from './atomicWrite.js';
import { ambientJournalDelete, ambientJournalWrite } from './journal.js';
import { withLockRetrying } from './locks.js';

/**
 * Sprint claim primitive — exclusive lock keyed on a run id.
 *
 * Claims live OUT-OF-TREE under `<opRoot>/claims/<sprintId>.json`. The
 * operational root is inside `.git/repokernel/`, which is implicitly
 * gitignored along with the rest of `.git/`. Storing claims there
 * deliberately keeps them per-machine: two different workstations on
 * separate branches both carrying an active claim is the same kind of
 * race git's branching model already accepts. What we DO prevent is two
 * processes on the same machine (same opRoot) racing for the same sprint.
 *
 * The previous implementation stored `claimed_by_run_id` in the sprint
 * frontmatter file. That defeated the merge-safe registry work — two
 * branches racing the claim each produced a different sprint .md, then
 * conflicted on git merge. Out-of-tree storage avoids that conflict
 * class entirely.
 *
 * `claimSprint` is idempotent for the same `(sprintId, runId)` pair:
 * re-claiming a sprint already held by the same run is `{ ok: true }`,
 * not an error. This matches `releaseSprint`'s no-op-on-missing semantics
 * and lets dispatch retries land safely after a crash.
 */

export type SprintClaimOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'already_claimed'; readonly heldBy: string };

interface ClaimRecord {
  readonly run_id: string;
  readonly claimed_at: string;
}

function claimsRoot(opRoot: string): string {
  return join(opRoot, 'claims');
}

function claimFile(opRoot: string, sprintId: string): string {
  return join(claimsRoot(opRoot), `${sprintId}.json`);
}

async function readClaim(file: string): Promise<ClaimRecord | null> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ClaimRecord>;
    if (typeof parsed.run_id === 'string' && parsed.run_id.length > 0) {
      return {
        run_id: parsed.run_id,
        claimed_at: typeof parsed.claimed_at === 'string' ? parsed.claimed_at : '',
      };
    }
    return null;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    // Corrupt JSON for an existing claim file is treated like "no valid
    // claim". Calling code can re-claim and a fresh file overwrites the
    // garbage. We never throw here — losing a claim because of a parse
    // error would prevent recovery.
    return null;
  }
}

export async function claimSprint(args: {
  readonly file?: string;
  readonly runId: string;
  readonly opRoot: string;
  readonly sprintId: string;
  readonly now?: () => Date;
}): Promise<SprintClaimOutcome> {
  return withLockRetrying(`sprint-claim-${args.sprintId}`, args.opRoot, async () => {
    await mkdir(claimsRoot(args.opRoot), { recursive: true });
    const path = claimFile(args.opRoot, args.sprintId);
    const existing = await readClaim(path);
    if (existing && existing.run_id !== args.runId) {
      return {
        ok: false as const,
        reason: 'already_claimed' as const,
        heldBy: existing.run_id,
      };
    }
    const record: ClaimRecord = {
      run_id: args.runId,
      claimed_at: (args.now ?? (() => new Date()))().toISOString(),
    };
    if (existing) {
      // Same run reclaiming — write through to refresh the timestamp.
      await ambientJournalWrite(path, JSON.stringify(record, null, 2));
    } else {
      // Use create-or-replace via the atomic write path. We do not use
      // atomicCreateText here because a stale-but-equal claim from a
      // crashed run with the same id is benign and should be allowed.
      await ambientJournalWrite(path, JSON.stringify(record, null, 2));
    }
    return { ok: true as const };
  });
}

export async function releaseSprint(args: {
  readonly file?: string;
  readonly opRoot: string;
  readonly sprintId: string;
  readonly runId?: string;
}): Promise<void> {
  await withLockRetrying(`sprint-claim-${args.sprintId}`, args.opRoot, async () => {
    const path = claimFile(args.opRoot, args.sprintId);
    const existing = await readClaim(path);
    if (!existing) return;
    if (args.runId !== undefined && existing.run_id !== args.runId) {
      // Defensive: a different run holds the claim; do not silently steal.
      return;
    }
    await ambientJournalDelete(path);
  });
}

export async function readSprintClaim(args: {
  readonly opRoot: string;
  readonly sprintId: string;
}): Promise<{ runId: string; claimedAt: string } | null> {
  const claim = await readClaim(claimFile(args.opRoot, args.sprintId));
  if (!claim) return null;
  return { runId: claim.run_id, claimedAt: claim.claimed_at };
}

export async function listSprintClaims(
  opRoot: string,
): Promise<ReadonlyArray<{ sprintId: string; runId: string; claimedAt: string }>> {
  const dir = claimsRoot(opRoot);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return [];
    throw cause;
  }
  const out: { sprintId: string; runId: string; claimedAt: string }[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const claim = await readClaim(join(dir, f));
    if (!claim) continue;
    out.push({
      sprintId: f.slice(0, -'.json'.length),
      runId: claim.run_id,
      claimedAt: claim.claimed_at,
    });
  }
  return out.sort((a, b) => a.sprintId.localeCompare(b.sprintId));
}

// Re-export atomicCreateText for tests that need to seed pre-existing
// claim files atomically; production callers should always go through
// claimSprint.
export { atomicCreateText };
