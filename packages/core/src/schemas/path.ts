import { z } from 'zod';

function hasUnsafePathSegment(value: string): boolean {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .some((part) => part === '..' || part === '.git');
}

export const RepoRelativeGlobSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'path pattern must not contain NUL bytes')
  .refine((value) => !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value), {
    message: 'path pattern must be relative to the project root',
  })
  .refine((value) => !hasUnsafePathSegment(value), {
    message: 'path pattern must not contain .. or .git segments',
  });

export type RepoRelativeGlob = z.infer<typeof RepoRelativeGlobSchema>;
