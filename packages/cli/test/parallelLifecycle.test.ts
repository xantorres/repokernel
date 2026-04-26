import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SprintId } from '@repokernel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeWaveBranches } from '../src/lifecycle/merge.js';
import { allocateReviewIds } from '../src/lifecycle/reviewAlloc.js';

const execFileAsync = promisify(execFile);

const S001 = 'S-001' as SprintId;
const S002 = 'S-002' as SprintId;

// — allocateReviewIds —

describe('allocateReviewIds', () => {
  let tmpDir: string;
  let opRoot: string;
  let reviewsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rk-test-'));
    opRoot = join(tmpDir, 'oproot');
    reviewsDir = join(tmpDir, 'reviews');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map for empty sprint list', async () => {
    const result = await allocateReviewIds([], reviewsDir, opRoot);
    expect(result.size).toBe(0);
  });

  it('allocates consecutive review IDs starting at R-001', async () => {
    const result = await allocateReviewIds([S001, S002], reviewsDir, opRoot);
    expect(result.get(S001)).toBe('R-001');
    expect(result.get(S002)).toBe('R-002');
  });

  it('continues from existing highest ID', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(reviewsDir, { recursive: true });
    await writeFile(join(reviewsDir, 'R-003.md'), 'stub', 'utf8');

    const result = await allocateReviewIds([S001], reviewsDir, opRoot);
    expect(result.get(S001)).toBe('R-004');
  });

  it('creates stub review files', async () => {
    const { readFile } = await import('node:fs/promises');
    const result = await allocateReviewIds([S001], reviewsDir, opRoot);
    const id = result.get(S001)!;
    const content = await readFile(join(reviewsDir, `${id}.md`), 'utf8');
    expect(content).toContain('id: R-001');
    expect(content).toContain('sprint_id: S-001');
    expect(content).toContain('verdict: pending');
  });

  it('sequential calls yield non-overlapping IDs', async () => {
    const r1 = await allocateReviewIds([S001], reviewsDir, opRoot);
    const r2 = await allocateReviewIds([S002], reviewsDir, opRoot);
    const id1 = r1.get(S001)!;
    const id2 = r2.get(S002)!;
    expect(id1).toBe('R-001');
    expect(id2).toBe('R-002');
    expect(id1).not.toBe(id2);
  });
});

// — mergeWaveBranches —

describe('mergeWaveBranches', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rk-merge-test-'));
    await execFileAsync('git', ['init', tmpDir]);
    await execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'test@test.com']);
    await execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
    await writeFile(join(tmpDir, 'README.md'), 'init');
    await execFileAsync('git', ['-C', tmpDir, 'add', 'README.md']);
    await execFileAsync('git', ['-C', tmpDir, 'commit', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('merges empty sprint list successfully', async () => {
    const result = await mergeWaveBranches(tmpDir, []);
    expect(result.success).toBe(true);
    expect(result.merged).toHaveLength(0);
  });

  it('merges a clean branch successfully', async () => {
    await execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', 'rk/E-001/S-001']);
    await writeFile(join(tmpDir, 'feature.ts'), 'export const x = 1;');
    await execFileAsync('git', ['-C', tmpDir, 'add', 'feature.ts']);
    await execFileAsync('git', ['-C', tmpDir, 'commit', '-m', 'add feature']);
    await execFileAsync('git', ['-C', tmpDir, 'checkout', 'main']);

    const result = await mergeWaveBranches(tmpDir, [
      { sprintId: S001, branch: 'rk/E-001/S-001', worktree: tmpDir },
    ]);
    expect(result.success).toBe(true);
    expect(result.merged).toContain('S-001');
    expect(result.firstConflict).toBeUndefined();
  });

  it('detects conflict on first conflicting branch and stops', async () => {
    await execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', 'rk/E-001/S-001']);
    await writeFile(join(tmpDir, 'conflict.ts'), 'const x = 1;');
    await execFileAsync('git', ['-C', tmpDir, 'add', 'conflict.ts']);
    await execFileAsync('git', ['-C', tmpDir, 'commit', '-m', 'S-001 change']);

    await execFileAsync('git', ['-C', tmpDir, 'checkout', 'main']);
    await execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', 'rk/E-001/S-002']);
    await writeFile(join(tmpDir, 'conflict.ts'), 'const x = 2;');
    await execFileAsync('git', ['-C', tmpDir, 'add', 'conflict.ts']);
    await execFileAsync('git', ['-C', tmpDir, 'commit', '-m', 'S-002 change']);

    await execFileAsync('git', ['-C', tmpDir, 'checkout', 'main']);
    await execFileAsync('git', ['-C', tmpDir, 'merge', '--no-ff', '--no-edit', 'rk/E-001/S-001']);

    const result = await mergeWaveBranches(tmpDir, [
      { sprintId: S002, branch: 'rk/E-001/S-002', worktree: tmpDir },
    ]);
    expect(result.success).toBe(false);
    expect(result.firstConflict).toBeDefined();
    expect(result.firstConflict!.sprintId).toBe('S-002');
    const { stdout } = await execFileAsync('git', ['-C', tmpDir, 'status', '--porcelain']);
    expect(stdout.trim()).toBe('');
  });

  it('merges in deterministic sprint-ID order', async () => {
    for (const [id, content] of [
      ['S-002', 'b'],
      ['S-001', 'a'],
    ] as const) {
      await execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', `rk/E-001/${id}`]);
      await writeFile(join(tmpDir, `${id}.ts`), content);
      await execFileAsync('git', ['-C', tmpDir, 'add', `${id}.ts`]);
      await execFileAsync('git', ['-C', tmpDir, 'commit', '-m', id]);
      await execFileAsync('git', ['-C', tmpDir, 'checkout', 'main']);
    }

    const result = await mergeWaveBranches(tmpDir, [
      { sprintId: S002, branch: 'rk/E-001/S-002', worktree: tmpDir },
      { sprintId: S001, branch: 'rk/E-001/S-001', worktree: tmpDir },
    ]);
    expect(result.success).toBe(true);
    expect(result.merged[0]).toBe('S-001');
    expect(result.merged[1]).toBe('S-002');
  });
});
