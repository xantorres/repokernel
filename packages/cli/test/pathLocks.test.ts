import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquirePathLocks, pathLockName, withPathLocks } from '../src/lifecycle/pathLocks.js';

describe('pathLockName', () => {
  it('is deterministic for the same path', () => {
    expect(pathLockName('apps/web/page.tsx')).toBe(pathLockName('apps/web/page.tsx'));
  });

  it('collapses glob siblings to the same name (both root at the same directory)', () => {
    // `apps/web/**` and `apps/web/*` both strip to `apps/web` and lock as
    // the same subtree. A literal filename like `apps/web/page.tsx`
    // locks at its own filename — finer granularity, by design.
    expect(pathLockName('apps/web/**')).toBe(pathLockName('apps/web/*'));
  });

  it('produces different names for distinct subtrees', () => {
    expect(pathLockName('apps/web')).not.toBe(pathLockName('apps/server'));
  });
});

describe('acquirePathLocks', () => {
  it('serializes acquirers requesting the same lock name', async () => {
    const opRoot = mkdtempSync(join(tmpdir(), 'rk-pathlocks-'));
    const release = await acquirePathLocks(['apps/web/**'], opRoot);
    // Second acquirer on the SAME name must throw. acquireLock has no
    // built-in retry — that's withLockRetrying's job for callers that
    // want to wait.
    await expect(acquirePathLocks(['apps/web/**'], opRoot)).rejects.toThrow();
    await release();
    // After release, a fresh acquire succeeds.
    const release2 = await acquirePathLocks(['apps/web/**'], opRoot);
    await release2();
  });

  it('rolls back partial acquisitions when one path fails', async () => {
    const opRoot = mkdtempSync(join(tmpdir(), 'rk-pathlocks-rb-'));
    // First, hold a lock on path B.
    const releaseB = await acquirePathLocks(['apps/b/**'], opRoot);
    // Now an acquirer that wants both A and B should fail; A's
    // intermediate lock must be released so a third acquirer can take it.
    await expect(acquirePathLocks(['apps/a/**', 'apps/b/**'], opRoot)).rejects.toThrow();
    const releaseA = await acquirePathLocks(['apps/a/**'], opRoot);
    await releaseA();
    await releaseB();
  });

  it('withPathLocks releases on throw', async () => {
    const opRoot = mkdtempSync(join(tmpdir(), 'rk-pathlocks-w-'));
    await expect(
      withPathLocks(['apps/c/**'], opRoot, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Lock must have been released so a fresh acquire succeeds.
    const release = await acquirePathLocks(['apps/c/**'], opRoot);
    await release();
  });
});
