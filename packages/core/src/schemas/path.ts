import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { RepoKernelError } from '../errors/RepoKernelError.js';

function hasUnsafePathSegment(value: string): boolean {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .some((part) => part === '..' || part === '.git');
}

const baseSafePath = (kind: 'pattern' | 'path') =>
  z
    .string()
    .min(1)
    .refine((value) => !value.includes('\0'), `${kind} must not contain NUL bytes`)
    .refine((value) => !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value), {
      message: `${kind} must be relative to the project root`,
    })
    .refine((value) => !hasUnsafePathSegment(value), {
      message: `${kind} must not contain .. or .git segments`,
    });

/** Path pattern that may contain glob wildcards (*, **, ?, [...]). */
export const RepoRelativeGlobSchema = baseSafePath('pattern');
export type RepoRelativeGlob = z.infer<typeof RepoRelativeGlobSchema>;

/**
 * Literal repo-relative path. Same safety guarantees as the glob schema, but
 * conveys intent: this field stores actual filenames produced/touched by a
 * run, not a pattern users author. We refuse `*` as a fail-loud signal that
 * a glob is being mis-stored as a literal path.
 */
export const RepoRelativePathSchema = baseSafePath('path').refine((value) => !value.includes('*'), {
  message: 'path must not contain glob wildcards (*) — use a literal filename',
});
export type RepoRelativePath = z.infer<typeof RepoRelativePathSchema>;

/**
 * Lane name — single, safe path segment. Lane names are interpolated into
 * filesystem paths (`<queuesDir>/<lane>.md`, `<lanesDir>/<lane>.md`) and into
 * lock IDs, so they must not contain separators, traversal sequences, or NUL
 * bytes. Pattern: `[A-Za-z0-9][A-Za-z0-9._-]{0,79}`. Reject `.`, `..`, `.git`,
 * and anything containing `/`, `\`, or NUL.
 */
const LANE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LANE_NAME_RESERVED = new Set(['.', '..', '.git']);

export const LaneNameSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => !value.includes('\0'), 'lane name must not contain NUL bytes')
  .refine((value) => !LANE_NAME_RESERVED.has(value), {
    message: 'lane name must not be ".", "..", or ".git"',
  })
  .refine((value) => !value.includes('/') && !value.includes('\\'), {
    message: 'lane name must not contain "/" or "\\"',
  })
  .refine((value) => LANE_NAME_PATTERN.test(value), {
    message:
      'lane name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/ (start with alnum; allowed chars: A-Z a-z 0-9 . _ -)',
  });
export type LaneName = z.infer<typeof LaneNameSchema>;

/**
 * Resolve a configured repo-relative path against `cwd` and return the
 * absolute filesystem path, after asserting:
 *  - the resolved target is contained inside `cwd` (no traversal escape)
 *  - no segment is `.git` (so a configured write cannot land inside the
 *    repo's `.git` directory even when the lexical guards in
 *    `RepoRelativePathSchema` were bypassed by symlinks or unusual joins)
 *
 * Throws `RepoKernelError(IO_ERROR)` when either invariant is violated.
 * Schema validation should catch the common case at config load — this is
 * the runtime defense-in-depth at write time.
 */
export function safeRepoPath(cwd: string, rel: string): string {
  if (rel.includes('\0')) {
    throw new RepoKernelError('IO_ERROR', 'path must not contain NUL bytes');
  }
  const cwdAbs = resolve(cwd);
  const target = resolve(cwdAbs, rel);
  const back = relative(cwdAbs, target);
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new RepoKernelError('IO_ERROR', `path "${rel}" escapes project root`);
  }
  // back === '' is OK — caller resolved to cwd itself (rare but legal).
  if (back.length > 0) {
    for (const segment of back.split(sep)) {
      if (segment === '.git') {
        throw new RepoKernelError('IO_ERROR', `path "${rel}" must not include a .git segment`);
      }
    }
  }
  return target;
}
