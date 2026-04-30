import { spawn } from 'node:child_process';
import type { Config } from '@repokernel/core';

export interface ChecksOutcome {
  readonly ran: boolean;
  readonly ok: boolean;
  readonly code: number;
  /** True when the command was killed by our timeout instead of exiting on its own. */
  readonly timedOut?: boolean;
}

const SIGTERM_GRACE_MS = 5_000;

/**
 * Run the configured pre-close checks command.
 *
 * Returns `ran: false` when no checksCmd is configured (no-op). Otherwise
 * spawns the command via shell, inheriting stdio so users see check output
 * inline, and resolves with the exit code.
 *
 * `timeoutSeconds` (defaults to a long-but-finite value) bounds wall-clock
 * runtime. On expiry we send SIGTERM to the entire process group, then
 * SIGKILL after a short grace period, so a wedged test runner cannot stall
 * the close pipeline indefinitely. The detached process group is the
 * Unix-only path; on Windows we fall back to direct kill of the shell.
 *
 * Used by `runCloseCommand`, `runEpicCloseCommand --run-checks`, the
 * autonomous run loop, and the fastpath close path so the safety gate the
 * product advertises actually runs in every close path.
 */
export async function runConfiguredChecks(
  checksCmd: string | undefined,
  cwd: string,
  timeoutSeconds = 1800,
): Promise<ChecksOutcome> {
  if (!checksCmd) return { ran: false, ok: true, code: 0 };
  return new Promise<ChecksOutcome>((resolve) => {
    const detached = process.platform !== 'win32';
    const child = spawn(checksCmd, {
      shell: true,
      stdio: 'inherit',
      cwd,
      detached,
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        // Already exited.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `rk: configured checks exceeded ${timeoutSeconds}s timeout — sending SIGTERM\n`,
      );
      killTree('SIGTERM');
      killTimer = setTimeout(() => {
        process.stderr.write('rk: configured checks did not exit on SIGTERM — sending SIGKILL\n');
        killTree('SIGKILL');
      }, SIGTERM_GRACE_MS);
    }, Math.max(1, timeoutSeconds) * 1000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        resolve({ ran: true, ok: false, code: code ?? 124, timedOut: true });
        return;
      }
      resolve({ ran: true, ok: code === 0, code: code ?? 1 });
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ ran: true, ok: false, code: 1 });
    });
  });
}

/**
 * Convenience wrapper that resolves the effective checks command from config
 * + an optional override and runs it.
 */
export async function runConfiguredChecksFromConfig(
  config: Config,
  cwd: string,
  override?: string,
): Promise<ChecksOutcome> {
  return runConfiguredChecks(
    override ?? config.automation.checksCmd,
    cwd,
    config.automation.checksTimeoutSeconds,
  );
}
