import { RepoKernelError } from '@repokernel/core';
import type { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME, EXIT_USAGE } from '../src/exitCodes.js';
import { errorToCommandResult, RuntimeError, startCwdFor, UsageError } from '../src/util/cli.js';

// Build a minimal fake Command tree without invoking Commander's parser
// (which mutates global state, hooks process.exit on unknown args, etc).
// startCwdFor only reads `cmd.opts()` and `cmd.parent`, so a duck type
// is sufficient and keeps the test deterministic.
function fakeCmd(opts: Record<string, unknown>, parent: Command | null = null): Command {
  return {
    opts: () => opts,
    parent,
  } as unknown as Command;
}

describe('startCwdFor (PR9 backfill)', () => {
  it('returns process.cwd() when no ancestor sets --cwd', () => {
    const program = fakeCmd({});
    const sub = fakeCmd({}, program);
    expect(startCwdFor(sub)).toBe(process.cwd());
  });

  it('walks the parent chain to find --cwd', () => {
    const program = fakeCmd({ cwd: '/tmp/x' });
    const sub = fakeCmd({}, program);
    expect(startCwdFor(sub)).toBe('/tmp/x');
  });

  it('prefers the closest ancestor when multiple set --cwd', () => {
    const program = fakeCmd({ cwd: '/tmp/x' });
    const mid = fakeCmd({ cwd: '/tmp/y' }, program);
    const sub = fakeCmd({}, mid);
    expect(startCwdFor(sub)).toBe('/tmp/y');
  });

  it('treats explicit empty string as absent and walks further up', () => {
    const program = fakeCmd({ cwd: '/tmp/root' });
    const sub = fakeCmd({ cwd: '' }, program);
    expect(startCwdFor(sub)).toBe('/tmp/root');
  });
});

describe('errorToCommandResult (PR9 backfill)', () => {
  it('maps UsageError to EXIT_USAGE with message on stderr', () => {
    const r = errorToCommandResult(new UsageError('bad flag'));
    expect(r.exitCode).toBe(EXIT_USAGE);
    expect(r.stderr).toBe('bad flag\n');
    expect(r.stdout).toBe('');
  });

  it('maps RuntimeError to EXIT_RUNTIME', () => {
    const r = errorToCommandResult(new RuntimeError('something broke'));
    expect(r.exitCode).toBe(EXIT_RUNTIME);
    expect(r.stderr).toBe('something broke\n');
  });

  it('maps RepoKernelError to EXIT_RUNTIME with `error:` prefix', () => {
    const r = errorToCommandResult(new RepoKernelError('IO_ERROR', 'disk full'));
    expect(r.exitCode).toBe(EXIT_RUNTIME);
    expect(r.stderr).toContain('disk full');
    expect(r.stderr.startsWith('error:')).toBe(true);
  });

  it('maps generic Error to EXIT_RUNTIME', () => {
    const r = errorToCommandResult(new Error('boom'));
    expect(r.exitCode).toBe(EXIT_RUNTIME);
    expect(r.stderr).toContain('boom');
  });

  it('maps non-Error thrown values via String()', () => {
    const r = errorToCommandResult({ weird: true });
    expect(r.exitCode).toBe(EXIT_RUNTIME);
    expect(r.stderr).toContain('error:');
  });
});

describe('RuntimeError + UsageError class identity', () => {
  it('UsageError is named "UsageError"', () => {
    expect(new UsageError('x').name).toBe('UsageError');
  });
  it('RuntimeError is named "RuntimeError"', () => {
    expect(new RuntimeError('x').name).toBe('RuntimeError');
  });
});

// exitWithResult is awkward to unit-test (process.exit) but the
// write-and-drain helper underneath is exercised indirectly by every
// CLI integration test in the suite. Skip a direct test here to avoid
// terminating the test runner.
describe.skip('exitWithResult', () => {
  it('exists as exported function', () => {
    expect.fail('see CLI integration tests');
  });
});

// Suppress unused-import lint when vi happens to be tree-shaken.
void vi;
