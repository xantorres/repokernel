import { execFile } from 'node:child_process';
import type { TrackerAdapter, TrackerTicket, TrackerWriteOutcome } from './types.js';

const FETCH_TIMEOUT_MS = 5000;

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Invoke `execFile` with a fresh promisification per call. Promisifying at
 * module load would bind to the original `execFile` reference and bypass
 * test-time mocks that swap the named export, so we resolve the reference
 * lazily here.
 */
function execFileAsync(
  cmd: string,
  args: readonly string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolveFn, rejectFn) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err !== null) {
        const errWith = err as NodeJS.ErrnoException & { stderr?: string };
        if (errWith.stderr === undefined && stderr !== '') errWith.stderr = stderr;
        rejectFn(errWith);
      } else {
        resolveFn({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

function ghEnv(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_HOST',
    'GH_ENTERPRISE_TOKEN',
    'GHE_TOKEN',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NO_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

interface GhIssueResponse {
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly labels?: ReadonlyArray<{ readonly name?: string }>;
  readonly assignees?: ReadonlyArray<{ readonly login?: string; readonly name?: string }>;
}

/**
 * GitHub Issues adapter. Shells out to the `gh` CLI rather than calling the
 * REST API directly so we inherit whatever auth the user already has set up
 * (gh auth, GH_TOKEN env, keychain). No raw token handling here.
 *
 * Refs are accepted as `owner/repo#NNN` (validated upstream by parseRef).
 *
 * Returns `null` on any failure: gh not installed, not authenticated,
 * issue not found, network timeout, malformed response.
 */
export const ghAdapter: TrackerAdapter = {
  name: 'gh',
  async fetch(ref: string): Promise<TrackerTicket | null> {
    const hashIdx = ref.indexOf('#');
    if (hashIdx === -1) {
      // parseRef should have caught this, but guard anyway.
      process.stderr.write(
        `tracker: gh ref \`${ref}\` missing \`#\` separator (falling through to plain create)\n`,
      );
      return null;
    }
    const repo = ref.slice(0, hashIdx);
    const issueNumber = ref.slice(hashIdx + 1);

    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['issue', 'view', issueNumber, '--repo', repo, '--json', 'title,body,url,labels,assignees'],
        { timeout: FETCH_TIMEOUT_MS, env: ghEnv() },
      );

      const data = JSON.parse(stdout) as GhIssueResponse;
      if (typeof data.title !== 'string') {
        process.stderr.write(
          `tracker: gh response missing title for ${ref} (falling through to plain create)\n`,
        );
        return null;
      }

      const labels: string[] = (data.labels ?? [])
        .map((l) => l?.name)
        .filter((name): name is string => typeof name === 'string');

      const firstAssignee = (data.assignees ?? [])[0];
      const assignee = firstAssignee?.login ?? firstAssignee?.name ?? null;

      return {
        id: ref,
        title: data.title,
        description: (data.body ?? '').trim(),
        labels,
        assignee,
        url: data.url ?? `https://github.com/${repo}/issues/${issueNumber}`,
      };
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException & {
        stderr?: string;
        killed?: boolean;
        signal?: NodeJS.Signals;
      };
      let reason = 'error';
      if (err.code === 'ENOENT') reason = 'gh CLI not installed';
      else if (err.code === 'ETIMEDOUT' || err.killed === true || err.signal !== undefined)
        reason = 'timeout';
      else if (err.stderr?.includes('authentication')) reason = 'not authenticated';
      else if (err.stderr?.includes('not found')) reason = 'not found';

      process.stderr.write(
        `tracker: gh ${reason} fetching ${ref} (falling through to plain create)\n`,
      );
      return null;
    }
  },

  async comment(ref: string, body: string): Promise<TrackerWriteOutcome> {
    const parsed = parseGhRef(ref);
    if (!parsed) return { ok: false, reason: 'invalid_gh_ref' };
    if (body.length === 0) return { ok: false, reason: 'empty_body' };
    try {
      await execFileAsync(
        'gh',
        ['issue', 'comment', parsed.number, '--repo', parsed.repo, '--body', body],
        { timeout: FETCH_TIMEOUT_MS, env: ghEnv() },
      );
      return { ok: true };
    } catch (cause) {
      return { ok: false, reason: describeGhError(cause) };
    }
  },

  async transition(ref: string, state: string): Promise<TrackerWriteOutcome> {
    const parsed = parseGhRef(ref);
    if (!parsed) return { ok: false, reason: 'invalid_gh_ref' };
    if (state.length === 0) return { ok: false, reason: 'empty_state' };
    const action = state === 'closed' || state === 'close' ? 'close' : 'reopen';
    try {
      await execFileAsync('gh', ['issue', action, parsed.number, '--repo', parsed.repo], {
        timeout: FETCH_TIMEOUT_MS,
        env: ghEnv(),
      });
      return { ok: true, detail: action };
    } catch (cause) {
      return { ok: false, reason: describeGhError(cause) };
    }
  },

  async linkPr(ref: string, prUrl: string): Promise<TrackerWriteOutcome> {
    if (!isHttpUrl(prUrl)) return { ok: false, reason: 'invalid_pr_url' };
    return this.comment
      ? this.comment(ref, `RepoKernel: linked pull request ${prUrl}`)
      : { ok: false, reason: 'not_implemented' };
  },
};

const GH_REPO_RE =
  /^([A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})#([1-9]\d*)$/;

function parseGhRef(ref: string): { repo: string; number: string } | null {
  const m = GH_REPO_RE.exec(ref);
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

function describeGhError(cause: unknown): string {
  // Strip leading "Command failed: gh ..." prefix Node attaches to the
  // promisified execFile error so the rejected reason does not leak the
  // body content of the original invocation through stderr.
  const err = cause as { code?: string | number; stderr?: string; message?: string } | undefined;
  if (err?.code === 'ENOENT') return 'gh_not_installed';
  if (err?.stderr?.includes('authentication')) return 'not_authenticated';
  if (err?.stderr?.includes('not found')) return 'not_found';
  if (err?.stderr) {
    return err.stderr.trim().split('\n')[0]?.slice(0, 160) ?? 'gh_error';
  }
  if (typeof err?.message === 'string') {
    // Drop the "Command failed: gh ..." part so we don't echo --body.
    const stripped = err.message.replace(/^Command failed:.*?(?:\n|$)/, '');
    return stripped.slice(0, 160) || 'gh_error';
  }
  return 'gh_error';
}
