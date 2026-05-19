import { realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { RepoKernelError } from '../errors/RepoKernelError.js';

/**
 * Walk up `target`'s ancestors until one exists on disk, realpath that
 * ancestor, append the un-walked tail, and assert the resulting absolute
 * path is contained inside `cwd`'s realpath. Throws `IO_ERROR` if the
 * target escapes — even when the literal path looks safe and only the
 * symlink resolution reveals the escape.
 *
 * `safeRepoPath` does a lexical containment check (no `..`, no `.git`
 * segment) but cannot detect a symlink like `epics -> /tmp/outside`.
 * `assertContainsRealpath` is the runtime defense layered on top of that:
 * call it from any write site that takes a repo-relative path.
 *
 * Pure-fs, no subprocess. Returns the canonical absolute path of the target
 * when safe.
 */
export async function assertContainsRealpath(cwd: string, target: string): Promise<string> {
  const cwdAbs = resolve(cwd);
  const targetAbs = resolve(cwdAbs, target);

  let realCwd: string;
  try {
    realCwd = await realpath(cwdAbs);
  } catch (cause) {
    throw new RepoKernelError(
      'IO_ERROR',
      `cannot canonicalize cwd ${cwdAbs}: ${(cause as Error).message}`,
      cause,
    );
  }

  // Walk up the target's ancestors until one exists on disk, then realpath
  // it. The tail (anything that doesn't yet exist) gets appended lexically
  // — there's nothing to follow until those parts are written.
  let probe = targetAbs;
  const tail: string[] = [];
  while (true) {
    try {
      const probeReal = await realpath(probe);
      const resolvedAbs = tail.length === 0 ? probeReal : resolve(probeReal, ...tail.reverse());
      const back = relative(realCwd, resolvedAbs);
      if (back === '..' || back.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(back)) {
        throw new RepoKernelError(
          'IO_ERROR',
          `path "${target}" escapes project root via symlink (resolved to ${resolvedAbs})`,
        );
      }
      return resolvedAbs;
    } catch (cause) {
      if (cause instanceof RepoKernelError) throw cause;
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        // Any other error (EACCES on a parent, etc.) is fail-closed: we
        // cannot prove containment, so we refuse the write.
        throw new RepoKernelError(
          'IO_ERROR',
          `cannot canonicalize ${probe}: ${(cause as Error).message}`,
          cause,
        );
      }
      const parent = dirname(probe);
      if (parent === probe) {
        // Reached filesystem root without finding an existing ancestor.
        // The cwd was supposed to exist; if we got here, something is very
        // wrong — refuse.
        throw new RepoKernelError(
          'IO_ERROR',
          `cannot canonicalize any ancestor of ${target}; refusing write`,
        );
      }
      tail.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}
