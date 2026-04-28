/**
 * Owner-side abort handler. The `rk run abort` command sets `abort_requested`
 * and sends SIGTERM to the owner process; cooperative polling in the run loop
 * picks up most aborts cleanly, but a SIGTERM that arrives while the owner is
 * blocked inside `runner.runSprint` would otherwise kill the owner instantly
 * and leave the spawned agent (and any grandchildren in its detached process
 * group) orphaned. This module installs a handler that:
 *
 *   1. Synchronously sends SIGTERM to every tracked child process group.
 *   2. Schedules a SIGKILL escalation after a grace window.
 *   3. Exits with code 130 once the grace timer fires (or sooner if the run
 *      loop returns naturally).
 *
 * Run state and lane release are handled by `runRunAbortCommand` BEFORE the
 * SIGTERM is sent, so this handler does not need to write metadata.
 */

const SIGTERM_GRACE_MS = 5_000;

export interface TrackedChild {
  readonly pid: number;
  /** True when the child was spawned with `detached: true` (POSIX PGID kill). */
  readonly detached: boolean;
}

const activeChildren = new Set<TrackedChild>();
let installedHandler: ((signal: NodeJS.Signals) => void) | null = null;

export function trackActiveChild(handle: TrackedChild): () => void {
  activeChildren.add(handle);
  return () => {
    activeChildren.delete(handle);
  };
}

export function killTrackedChildren(signal: NodeJS.Signals): void {
  for (const child of activeChildren) {
    try {
      if (process.platform === 'win32' || !child.detached) {
        process.kill(child.pid, signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      // Already exited or PGID gone; nothing to do.
    }
  }
}

export function activeChildCount(): number {
  return activeChildren.size;
}

export interface OwnerAbortOptions {
  /**
   * Override exit. Defaults to calling `process.exit(130)` after the grace
   * window. Tests pass a no-op so they can observe the handler's effects.
   */
  readonly onExit?: () => void;
  /** Override grace window for tests. */
  readonly graceMs?: number;
}

export function installOwnerAbortHandler(opts: OwnerAbortOptions = {}): () => void {
  if (installedHandler) {
    // Already installed for this owner; subsequent installs are no-ops so
    // nested call sites (resume → executeRunLoop) don't double-register.
    return () => {};
  }
  const graceMs = opts.graceMs ?? SIGTERM_GRACE_MS;
  const onExit =
    opts.onExit ??
    (() => {
      process.exit(130);
    });

  const handler = (_signal: NodeJS.Signals): void => {
    // Sync child kill so a SIGKILL on the owner immediately after this
    // handler still leaves us having signalled the children.
    killTrackedChildren('SIGTERM');
    const timer = setTimeout(() => {
      killTrackedChildren('SIGKILL');
      onExit();
    }, graceMs);
    timer.unref();
  };

  installedHandler = handler;
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);

  return () => {
    if (installedHandler === handler) {
      process.off('SIGTERM', handler);
      process.off('SIGINT', handler);
      installedHandler = null;
    }
  };
}

/** Test-only: clear all tracked children. */
export function _resetForTests(): void {
  activeChildren.clear();
  if (installedHandler) {
    process.off('SIGTERM', installedHandler);
    process.off('SIGINT', installedHandler);
    installedHandler = null;
  }
}
