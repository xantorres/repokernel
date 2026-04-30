import { findProjectRootSync } from '@repokernel/core';

/**
 * Append `value` to `previous` and return the new array. Commander option
 * collector that lets users repeat a flag (`--flag a --flag b`) into a
 * single array argument. No CSV splitting — each invocation is one entry.
 */
export function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/**
 * Collector that also splits comma-separated values inside each occurrence.
 *
 * Lets users mix forms freely: `--flag a,b --flag c` becomes ['a','b','c'].
 * Trims whitespace and drops empty entries so `--flag a, , b` is equivalent
 * to `--flag a --flag b`.
 */
export function collectCsvOption(value: string, previous: string[]): string[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...previous, ...parts];
}

/**
 * Resolve the starting cwd for an `rk` command. If a `repokernel.config.yaml`
 * exists in `startCwd` or any parent, return that project root so commands
 * work from any subdirectory of an initialized repo. If no config is found,
 * return `startCwd` unchanged (preserves current behavior for `rk init` and
 * similar not-yet-initialized commands).
 */
export function resolveProjectCwd(startCwd: string): string {
  const found = findProjectRootSync(startCwd);
  return found?.cwd ?? startCwd;
}
