import { describe, expect, it, vi } from 'vitest';

// Mock node:child_process at module load so the gh adapter and the PR
// client both call into the mock instead of the real binary.
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile: vi.fn() };
});

import { execFile } from 'node:child_process';
import { ghPrComment, ghPrEditBody, ghPrView } from '../src/integrations/github/client.js';
import { commentOnTicket, transitionTicket } from '../src/integrations/tracker/index.js';

const mockExecFile = vi.mocked(execFile);

function ok(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementationOnce(((
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

function fail(error: { code?: string | number; stderr?: string; message?: string }): void {
  mockExecFile.mockImplementationOnce(((
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const err = Object.assign(new Error(error.message ?? 'command failed'), error);
    cb(err, '', error.stderr ?? '');
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

describe('gh PR client (mocked)', () => {
  it('ghPrView parses a draft PR JSON envelope', async () => {
    ok(
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/o/r/pull/1',
        title: 't',
        isDraft: true,
      }),
    );
    const result = await ghPrView('https://github.com/o/r/pull/1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('draft');
      expect(result.value.url).toBe('https://github.com/o/r/pull/1');
    }
  });

  it('ghPrView reports gh_not_installed when binary is missing', async () => {
    fail({ code: 'ENOENT', message: 'spawn gh ENOENT' });
    const result = await ghPrView('https://github.com/o/r/pull/1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('gh_not_installed');
  });

  it('ghPrComment posts via gh pr comment', async () => {
    ok();
    const result = await ghPrComment('https://github.com/o/r/pull/1', 'agent done');
    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      'gh',
      ['pr', 'comment', 'https://github.com/o/r/pull/1', '--body', 'agent done'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('ghPrEditBody surfaces not_authenticated for auth errors', async () => {
    fail({ stderr: 'gh: authentication required', message: 'auth' });
    const result = await ghPrEditBody('https://github.com/o/r/pull/1', 'body');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_authenticated');
  });
});

describe('tracker writers (mocked gh)', () => {
  const meta = {
    provider: 'gh' as const,
    issue_id: 'owner/repo#42',
    sync_at: '2026-04-25T10:00:00.000Z',
    synced_fields: [] as ('comment' | 'status' | 'link_pr')[],
  };

  it('commentOnTicket calls gh issue comment with the body', async () => {
    ok();
    const result = await commentOnTicket(meta, 'hello');
    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      'gh',
      ['issue', 'comment', '42', '--repo', 'owner/repo', '--body', 'hello'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('commentOnTicket rejects empty body without spawning gh', async () => {
    const beforeCalls = mockExecFile.mock.calls.length;
    const result = await commentOnTicket(meta, '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty_body');
    expect(mockExecFile.mock.calls.length).toBe(beforeCalls);
  });

  it('transitionTicket maps "closed" to gh issue close', async () => {
    ok();
    const result = await transitionTicket(meta, 'closed');
    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      'gh',
      ['issue', 'close', '42', '--repo', 'owner/repo'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('transitionTicket maps any other state to reopen', async () => {
    ok();
    const result = await transitionTicket(meta, 'open');
    expect(result.ok).toBe(true);
    expect(mockExecFile).toHaveBeenLastCalledWith(
      'gh',
      ['issue', 'reopen', '42', '--repo', 'owner/repo'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('declines gracefully when adapter is linear (not_implemented)', async () => {
    const linearMeta = { ...meta, provider: 'linear' as const, issue_id: 'RK-42' };
    const result = await commentOnTicket(linearMeta, 'hello');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_implemented');
  });
});

describe('describe() does not leak --body content', () => {
  it('strips Command failed: prefix from message', async () => {
    fail({
      message: 'Command failed: gh issue comment 42 --repo o/r --body super secret payload',
    });
    const result = await commentOnTicket(
      {
        provider: 'gh',
        issue_id: 'o/r#42',
        sync_at: '2026-04-25T10:00:00.000Z',
        synced_fields: [],
      },
      'super secret payload',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('super secret payload');
      expect(result.reason).not.toMatch(/^Command failed:/);
    }
  });
});
