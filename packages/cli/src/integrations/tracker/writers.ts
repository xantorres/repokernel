import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TrackerMetadata } from '@repokernel/core';

const execFileAsync = promisify(execFile);

export type TrackerWriteOutcome =
  | { readonly ok: true; readonly detail?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Write-side tracker bridge. Each function takes the sprint's tracker
 * metadata + a payload and posts the corresponding update to the external
 * tracker. Adapters that don't support a given operation return
 * `{ ok: false, reason: 'not_implemented' }` so the caller can surface a
 * clean error instead of silent no-ops.
 *
 * The functions are intentionally side-effect-light: they shell out to
 * `gh` for GitHub Issues (inheriting whatever auth the user has set up)
 * and call the Linear / Jira REST/GraphQL APIs only when an env-provided
 * credential is present. If credentials are missing, the operation is
 * declined cleanly. We never store or log credential values.
 */

export async function commentOnTicket(
  metadata: TrackerMetadata,
  body: string,
): Promise<TrackerWriteOutcome> {
  if (body.length === 0) {
    return { ok: false, reason: 'empty_body' };
  }

  switch (metadata.provider) {
    case 'gh':
      return ghComment(metadata.issue_id, body);
    case 'linear':
      return linearComment(metadata.issue_id, body);
    case 'jira':
      return { ok: false, reason: 'not_implemented' };
    default:
      return { ok: false, reason: `unknown provider: ${String(metadata.provider)}` };
  }
}

export async function linkPrToTicket(
  metadata: TrackerMetadata,
  prUrl: string,
): Promise<TrackerWriteOutcome> {
  if (!isHttpUrl(prUrl)) {
    return { ok: false, reason: 'invalid_pr_url' };
  }
  const message = `RepoKernel: linked pull request ${prUrl}`;

  // PR linkage on every supported tracker boils down to a comment with
  // the URL — the dedicated PR-link primitive belongs to the v2 PR
  // bridge sprint. Until then this preserves the audit trail.
  return commentOnTicket(metadata, message);
}

export async function transitionTicket(
  metadata: TrackerMetadata,
  state: string,
): Promise<TrackerWriteOutcome> {
  if (state.length === 0) {
    return { ok: false, reason: 'empty_state' };
  }

  switch (metadata.provider) {
    case 'gh':
      return ghTransition(metadata.issue_id, state);
    case 'linear':
    case 'jira':
      return { ok: false, reason: 'not_implemented' };
    default:
      return { ok: false, reason: `unknown provider: ${String(metadata.provider)}` };
  }
}

async function ghComment(ref: string, body: string): Promise<TrackerWriteOutcome> {
  const parsed = parseGhRef(ref);
  if (!parsed) return { ok: false, reason: 'invalid_gh_ref' };
  try {
    await execFileAsync(
      'gh',
      ['issue', 'comment', parsed.number, '--repo', parsed.repo, '--body', body],
      { timeout: 10_000 },
    );
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: describe(cause) };
  }
}

async function ghTransition(ref: string, state: string): Promise<TrackerWriteOutcome> {
  const parsed = parseGhRef(ref);
  if (!parsed) return { ok: false, reason: 'invalid_gh_ref' };
  const action = state === 'closed' || state === 'close' ? 'close' : 'reopen';
  try {
    await execFileAsync('gh', ['issue', action, parsed.number, '--repo', parsed.repo], {
      timeout: 10_000,
    });
    return { ok: true, detail: action };
  } catch (cause) {
    return { ok: false, reason: describe(cause) };
  }
}

async function linearComment(_ref: string, _body: string): Promise<TrackerWriteOutcome> {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: 'no_credentials' };
  // Real Linear comment mutation is left for follow-up; we keep the surface
  // ready and signal explicitly to the caller that the integration is
  // recognised but not yet wired up.
  return { ok: false, reason: 'not_implemented' };
}

function parseGhRef(ref: string): { repo: string; number: string } | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref);
  if (!m) return null;
  return { repo: m[1] ?? '', number: m[2] ?? '' };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function describe(cause: unknown): string {
  const err = cause as { code?: string; stderr?: string; message?: string } | undefined;
  if (err?.code === 'ENOENT') return 'gh_not_installed';
  if (err?.stderr?.includes('authentication')) return 'not_authenticated';
  return err?.message ?? String(cause);
}
