/**
 * Tests for the SIGTERM/SIGINT teardown handler that protects agent
 * grandchildren from being orphaned when the run owner is forcefully aborted.
 */

import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetForTests,
  activeChildCount,
  installOwnerAbortHandler,
  killTrackedChildren,
  trackActiveChild,
} from '../src/lifecycle/abortHandler.js';

afterEach(() => {
  _resetForTests();
});

describe('trackActiveChild', () => {
  it('adds and untracks children via the returned disposer', () => {
    expect(activeChildCount()).toBe(0);
    const untrack = trackActiveChild({ pid: 99999, detached: false });
    expect(activeChildCount()).toBe(1);
    untrack();
    expect(activeChildCount()).toBe(0);
  });

  it('handles multiple tracked children independently', () => {
    const a = trackActiveChild({ pid: 11111, detached: false });
    const b = trackActiveChild({ pid: 22222, detached: true });
    expect(activeChildCount()).toBe(2);
    a();
    expect(activeChildCount()).toBe(1);
    b();
    expect(activeChildCount()).toBe(0);
  });
});

describe('killTrackedChildren', () => {
  it.runIf(process.platform !== 'win32')(
    'sends the requested signal to a real tracked child',
    async () => {
      const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
      });
      // Wait for spawn to settle and pid to be available.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(child.pid).toBeGreaterThan(0);

      const untrack = trackActiveChild({ pid: child.pid!, detached: true });
      try {
        killTrackedChildren('SIGTERM');
        // Child should exit promptly after SIGTERM to its PGID.
        const exited = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          child.on('exit', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        expect(exited).toBe(true);
      } finally {
        untrack();
        if (!child.killed) child.kill('SIGKILL');
      }
    },
    10_000,
  );
});

describe('installOwnerAbortHandler', () => {
  it.runIf(process.platform !== 'win32')(
    'on SIGTERM, kills tracked children and schedules onExit after grace',
    async () => {
      const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const untrackChild = trackActiveChild({ pid: child.pid!, detached: true });

      let exitCalled = false;
      const uninstall = installOwnerAbortHandler({
        graceMs: 100,
        onExit: () => {
          exitCalled = true;
        },
      });

      try {
        // Fire SIGTERM at our own process to invoke the handler. Node delivers
        // signals via process events; the handler should sync-kill the child
        // and async-schedule onExit after the grace.
        process.emit('SIGTERM', 'SIGTERM');

        const childExited = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 3000);
          child.on('exit', () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        expect(childExited).toBe(true);

        // Wait for the grace window to elapse and onExit to fire.
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        expect(exitCalled).toBe(true);
      } finally {
        untrackChild();
        uninstall();
        if (!child.killed) child.kill('SIGKILL');
      }
    },
    10_000,
  );

  it('returns a no-op disposer when called twice', () => {
    const u1 = installOwnerAbortHandler({ onExit: () => {} });
    const u2 = installOwnerAbortHandler({ onExit: () => {} });
    // Both should be callable without throwing; only the first installer
    // actually owns the listener lifecycle.
    expect(() => u2()).not.toThrow();
    expect(() => u1()).not.toThrow();
  });
});
