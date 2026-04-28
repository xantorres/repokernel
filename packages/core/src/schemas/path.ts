import { z } from 'zod';

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
