import { RepoKernelError } from '@repokernel/core';
import type { Command } from 'commander';
import type { CommandResult } from '../commands/validate.js';
import { EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';

/**
 * Marker for command-line invocation errors (unknown enum value, mutually
 * exclusive flags, malformed numeric option, etc.). Distinct from
 * `RepoKernelError` so the top-level catcher can map it to `EXIT_USAGE`
 * rather than `EXIT_RUNTIME`.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/**
 * Marker for expected runtime failures that should bubble up to `main()`
 * for flush-aware exit handling. Use when a command discovers a
 * pre-condition violation and wants to abort with a user-facing message.
 * Maps to `EXIT_RUNTIME` via `errorToCommandResult`.
 */
export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';
}

/**
 * Result shape accepted by `exitWithResult`. Aligns with `CommandResult` but
 * widens stdout/stderr to optional so callers can pass partial envelopes
 * (e.g. error-only paths that have no stdout).
 */
export interface FlushableResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

/**
 * Walk Commander's parent chain to find the first `--cwd` option value.
 *
 * Replaces the brittle `globals.cwd ?? process.cwd()` pattern that relied on
 * `optsWithGlobals()` correctly surfacing the program-level `--cwd` default
 * through every level of subcommand nesting. With two-level nesting
 * (`program -> epic -> status`), some Commander versions return `undefined`
 * for the program-level default, leading to subcommand-specific
 * config-not-found errors. Walking the parent chain explicitly is resilient
 * to nesting depth.
 *
 * Falls back to `process.cwd()` only when no ancestor command exposes a
 * non-empty `--cwd` value. An explicit empty string is treated as absent
 * (Commander's default is `process.cwd()`, so empty is reachable only via
 * shell-expansion of an unset variable; we deliberately ignore it rather
 * than persist it).
 */
export function startCwdFor(cmd: Command): string {
  let c: Command | null = cmd;
  while (c) {
    const v = (c.opts() as { cwd?: string }).cwd;
    if (typeof v === 'string' && v.length > 0) return v;
    c = c.parent;
  }
  return process.cwd();
}

/**
 * Flush stdout and stderr before exiting. `process.exit()` truncates async
 * writes that haven't yet drained when stdout is a pipe (the common case for
 * subprocess invocations from agents and shell scripts), producing the
 * silent "exit 0 with no output" failure mode reported in DV's rk-issues
 * feedback (2026-04-29). Awaiting the write callbacks guarantees the buffer
 * drains before the process terminates.
 *
 * Write errors other than EPIPE are surfaced to stderr before exit. EPIPE is
 * normal when the consumer closes the pipe early (e.g. `rk validate | head`)
 * and is intentionally swallowed.
 */
export async function exitWithResult(result: FlushableResult): Promise<never> {
  await Promise.all([
    writeAndDrain(process.stdout, result.stdout),
    writeAndDrain(process.stderr, result.stderr),
  ]);
  process.exit(result.exitCode);
}

function writeAndDrain(stream: NodeJS.WriteStream, data: string | undefined): Promise<void> {
  if (!data || data.length === 0) return Promise.resolve();
  return new Promise<void>((res) => {
    stream.write(data, (err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE' && stream !== process.stderr) {
        // Best-effort: surface write errors on stderr (unless the failing
        // stream IS stderr — avoid infinite-loop write-during-failure).
        process.stderr.write(`rk: stream write error: ${err.message}\n`);
      }
      res();
    });
  });
}

/**
 * Convert any thrown value into a `CommandResult`. Used by action handlers
 * to fold exceptions into the same envelope shape that command bodies
 * already return, so a single `exitWithResult` call at the action boundary
 * flushes both happy and error paths.
 *
 * Recognises `RepoKernelError` and surfaces its message verbatim. For any
 * other thrown value, falls back to `Error.message` or `String(e)`.
 */
export function errorToCommandResult(e: unknown): CommandResult {
  if (e instanceof UsageError) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: `${e.message}\n` };
  }
  if (e instanceof RuntimeError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
  }
  if (e instanceof RepoKernelError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${e.message}\n` };
  }
  if (e instanceof Error) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${e.message}\n` };
  }
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `error: ${String(e)}\n` };
}
