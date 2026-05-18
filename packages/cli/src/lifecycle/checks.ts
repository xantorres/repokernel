import type { Config } from '@repokernel/core';
import { assertChecksCmdTrusted, spawnPolicyEnforced } from '../security/spawnPolicy.js';

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
 * routes the command through the spawn-policy chokepoint, which restricts
 * the env to the default allowlist (no API keys, tokens, or other
 * repo-irrelevant secrets), registers the child with the owner abort
 * handler, and uses shell parsing only because users legitimately need
 * `npm test && npm run lint`-style pipelines. The TRUST_DENIED gate must
 * pass before this runs.
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
    const { child, untrack } = spawnPolicyEnforced({
      command: checksCmd,
      cwd,
      shell: true,
      stdio: 'inherit',
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
      untrack();
      if (timedOut) {
        resolve({ ran: true, ok: false, code: code ?? 124, timedOut: true });
        return;
      }
      resolve({ ran: true, ok: code === 0, code: code ?? 1 });
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      untrack();
      resolve({ ran: true, ok: false, code: 1 });
    });
  });
}

/**
 * Convenience wrapper that resolves the effective checks command from config
 * + an optional override and runs it. Trust gate runs against the config's
 * declared checksCmd; an override passed by the user is not gated (the user
 * is explicitly typing the command themselves at that point).
 */
export async function runConfiguredChecksFromConfig(
  config: Config,
  cwd: string,
  override?: string,
): Promise<ChecksOutcome> {
  if (override === undefined) {
    await assertChecksCmdTrusted(config.automation, cwd);
  }
  return runConfiguredChecks(
    override ?? config.automation.checksCmd,
    cwd,
    config.automation.checksTimeoutSeconds,
  );
}
