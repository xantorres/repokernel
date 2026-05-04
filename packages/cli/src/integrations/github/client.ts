import { execFile } from 'node:child_process';
import type { PrStatus } from '@repokernel/core';

const DEFAULT_TIMEOUT_MS = 10_000;

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

// Resolve `execFile` lazily inside each call so test-time `vi.mock`
// substitutions of the named export reach this code path. A
// `promisify(execFile)` at module load would freeze the original
// reference and bypass the mock.
function execFileAsync(
  cmd: string,
  args: readonly string[],
  opts: { timeout: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        if (e.stderr === undefined && stderr !== '') e.stderr = String(stderr);
        reject(e);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export type GhOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

interface GhPrViewResponse {
  readonly state?: string;
  readonly url?: string;
  readonly title?: string;
  readonly isDraft?: boolean;
  readonly mergedAt?: string | null;
}

/**
 * Lightweight wrapper around the `gh` CLI. We deliberately shell out
 * (rather than using octokit) so we inherit user auth and respect any
 * enterprise host config the operator already has set up.
 *
 * Every operation returns `GhOutcome<T>` instead of throwing. Network
 * errors, missing `gh`, and unauth flows are all expressible as a clean
 * `{ ok: false, reason }` so callers don't pile try/catch into the CLI
 * layer.
 */

export async function ghPrView(prUrl: string): Promise<
  GhOutcome<{
    status: PrStatus;
    url: string;
    title: string;
  }>
> {
  return runGh(['pr', 'view', prUrl, '--json', 'state,url,title,isDraft,mergedAt'], (stdout) => {
    const data = JSON.parse(stdout) as GhPrViewResponse;
    const state = (data.state ?? '').toLowerCase();
    let status: PrStatus = 'open';
    if (data.isDraft === true) status = 'draft';
    else if (state === 'merged' || data.mergedAt) status = 'merged';
    else if (state === 'closed') status = 'closed';
    return {
      status,
      url: data.url ?? prUrl,
      title: data.title ?? '',
    };
  });
}

export async function ghPrComment(prUrl: string, body: string): Promise<GhOutcome<void>> {
  return runGh(['pr', 'comment', prUrl, '--body', body], () => undefined);
}

export async function ghPrEditBody(prUrl: string, body: string): Promise<GhOutcome<void>> {
  return runGh(['pr', 'edit', prUrl, '--body', body], () => undefined);
}

async function runGh<T>(
  args: readonly string[],
  parse: (stdout: string) => T,
): Promise<GhOutcome<T>> {
  try {
    const { stdout } = await execFileAsync('gh', [...args], { timeout: DEFAULT_TIMEOUT_MS });
    return { ok: true, value: parse(String(stdout)) };
  } catch (cause) {
    return { ok: false, reason: describe(cause) };
  }
}

function describe(cause: unknown): string {
  const err = cause as { code?: string; stderr?: string; message?: string } | undefined;
  if (err?.code === 'ENOENT') return 'gh_not_installed';
  if (err?.stderr?.includes('authentication')) return 'not_authenticated';
  if (err?.stderr?.includes('not found')) return 'not_found';
  return err?.message ?? String(cause);
}
