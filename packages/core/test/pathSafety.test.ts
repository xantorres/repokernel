import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LaneNameSchema, RepoKernelError, safeRepoPath } from '../src/index.js';

const tracked: string[] = [];
afterAll(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rk-path-safety-')));
  tracked.push(dir);
  return dir;
}

describe('LaneNameSchema', () => {
  it.each([
    ['main', true],
    ['feature-x', true],
    ['v1.2.3', true],
    ['Lane_A', true],
    ['a', true],
    ['1abc', true],
    ['', false],
    ['.', false],
    ['..', false],
    ['.git', false],
    ['../x', false],
    ['..\\x', false],
    ['lane/sub', false],
    ['lane\\sub', false],
    ['lane\0name', false],
    ['-leading-dash', false],
    ['_leading-underscore', false],
    ['.leading-dot', false],
    ['too-long'.padEnd(81, 'x'), false],
  ])('LaneNameSchema(%j) ok=%s', (input, ok) => {
    const r = LaneNameSchema.safeParse(input);
    expect(r.success).toBe(ok);
  });
});

describe('safeRepoPath', () => {
  it('returns absolute path inside cwd for safe input', async () => {
    const cwd = await tmp();
    const out = safeRepoPath(cwd, 'sub/dir/file.md');
    expect(out.startsWith(cwd)).toBe(true);
    expect(out.endsWith('sub/dir/file.md')).toBe(true);
  });

  it('rejects traversal escape', async () => {
    const cwd = await tmp();
    expect(() => safeRepoPath(cwd, '../escape')).toThrow(RepoKernelError);
  });

  it('rejects .git segment anywhere in the path', async () => {
    const cwd = await tmp();
    expect(() => safeRepoPath(cwd, '.git/hooks/pre-commit')).toThrow(/\.git segment/);
    expect(() => safeRepoPath(cwd, 'a/.git/b')).toThrow(/\.git segment/);
  });

  it('rejects NUL bytes', async () => {
    const cwd = await tmp();
    expect(() => safeRepoPath(cwd, 'a\0b')).toThrow(/NUL/);
  });

  it('accepts cwd itself (empty relative path)', async () => {
    const cwd = await tmp();
    const out = safeRepoPath(cwd, '.');
    expect(out).toBe(cwd);
  });
});
