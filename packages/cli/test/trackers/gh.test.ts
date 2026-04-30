import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const SECRET_ENV_KEYS = ['JIRA_API_TOKEN', 'LINEAR_API_KEY'] as const;
const ORIGINAL_SECRET_ENV = Object.fromEntries(
  SECRET_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof SECRET_ENV_KEYS)[number], string | undefined>;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: execFileMock };
});

const { ghAdapter } = await import('../../src/trackers/gh.js');

describe('ghAdapter.fetch', () => {
  const stderrLines: string[] = [];

  beforeEach(() => {
    stderrLines.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation(((data: unknown) => {
      stderrLines.push(typeof data === 'string' ? data : String(data));
      return true;
    }) as never);
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of SECRET_ENV_KEYS) {
      const value = ORIGINAL_SECRET_ENV[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function setExec(
    impl: (args: readonly string[]) => {
      stdout?: string;
      stderr?: string;
      err?: NodeJS.ErrnoException;
    },
  ) {
    execFileMock.mockImplementation(((
      _cmd: string,
      args: readonly string[],
      _opts: object,
      cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
    ) => {
      const r = impl(args);
      if (r.err) {
        const errWith = r.err as NodeJS.ErrnoException & { stderr?: string };
        if (r.stderr !== undefined) errWith.stderr = r.stderr;
        cb(errWith, r.stdout ?? '', r.stderr ?? '');
      } else {
        cb(null, r.stdout ?? '', r.stderr ?? '');
      }
    }) as never);
  }

  it('parses a successful gh issue view JSON response', async () => {
    process.env.JIRA_API_TOKEN = 'jira-secret';
    process.env.LINEAR_API_KEY = 'linear-secret';
    setExec(() => ({
      stdout: JSON.stringify({
        title: 'Add login',
        body: 'Description body',
        url: 'https://github.com/acme/web/issues/42',
        labels: [{ name: 'frontend' }, { name: 'p1' }],
        assignees: [{ login: 'alice', name: 'Alice' }],
      }),
    }));

    const result = await ghAdapter.fetch('acme/web#42');
    expect(result?.id).toBe('acme/web#42');
    expect(result?.title).toBe('Add login');
    expect(result?.description).toBe('Description body');
    expect(result?.labels).toEqual(['frontend', 'p1']);
    expect(result?.assignee).toBe('alice');
    expect(result?.url).toBe('https://github.com/acme/web/issues/42');
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['issue', 'view', '42', '--repo', 'acme/web', '--json', 'title,body,url,labels,assignees'],
      expect.objectContaining({
        timeout: expect.any(Number),
        env: expect.not.objectContaining({
          JIRA_API_TOKEN: expect.any(String),
          LINEAR_API_KEY: expect.any(String),
        }),
      }),
      expect.any(Function),
    );
  });

  it('returns null when gh CLI is not installed (ENOENT)', async () => {
    const err: NodeJS.ErrnoException = new Error('not found');
    err.code = 'ENOENT';
    setExec(() => ({ err }));

    const result = await ghAdapter.fetch('acme/web#42');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/not installed/);
  });

  it('returns null on auth failure (stderr contains "authentication")', async () => {
    const err: NodeJS.ErrnoException = new Error('exit 1');
    setExec(() => ({ err, stderr: 'authentication required' }));

    const result = await ghAdapter.fetch('acme/web#42');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/not authenticated/);
  });

  it('returns null when issue not found', async () => {
    const err: NodeJS.ErrnoException = new Error('exit 1');
    setExec(() => ({ err, stderr: 'GraphQL: Could not resolve to an Issue (not found)' }));

    const result = await ghAdapter.fetch('acme/web#999');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/not found/);
  });

  it('detects execFile timeout shape', async () => {
    const err = new Error('spawn timed out') as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals;
    };
    err.killed = true;
    err.signal = 'SIGTERM';
    setExec(() => ({ err }));

    const result = await ghAdapter.fetch('acme/web#42');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/timeout/);
  });

  it('falls back to assignee name when login missing', async () => {
    setExec(() => ({
      stdout: JSON.stringify({
        title: 'Bug',
        body: '',
        url: 'https://github.com/acme/web/issues/1',
        labels: [],
        assignees: [{ name: 'No Login User' }],
      }),
    }));

    const result = await ghAdapter.fetch('acme/web#1');
    expect(result?.assignee).toBe('No Login User');
  });

  it('returns null on missing title in response', async () => {
    setExec(() => ({ stdout: JSON.stringify({ body: 'no title' }) }));

    const result = await ghAdapter.fetch('acme/web#1');
    expect(result).toBeNull();
    expect(stderrLines.join('')).toMatch(/missing title/);
  });
});
