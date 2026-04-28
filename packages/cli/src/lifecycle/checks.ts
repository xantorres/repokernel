import { spawn } from 'node:child_process';
import type { Config } from '@repokernel/core';

export interface ChecksOutcome {
  readonly ran: boolean;
  readonly ok: boolean;
  readonly code: number;
}

/**
 * Run the configured pre-close checks command.
 *
 * Returns `ran: false` when no checksCmd is configured (no-op). Otherwise
 * spawns the command via shell, inheriting stdio so users see check output
 * inline, and resolves with the exit code.
 *
 * Used by `runCloseCommand`, `runEpicCloseCommand --run-checks`, the
 * autonomous run loop, and the fastpath close path so the safety gate the
 * product advertises actually runs in every close path.
 */
export async function runConfiguredChecks(
  checksCmd: string | undefined,
  cwd: string,
): Promise<ChecksOutcome> {
  if (!checksCmd) return { ran: false, ok: true, code: 0 };
  return new Promise<ChecksOutcome>((resolve) => {
    const child = spawn(checksCmd, { shell: true, stdio: 'inherit', cwd });
    child.on('close', (code) => resolve({ ran: true, ok: code === 0, code: code ?? 1 }));
    child.on('error', () => resolve({ ran: true, ok: false, code: 1 }));
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
  return runConfiguredChecks(override ?? config.automation.checksCmd, cwd);
}
