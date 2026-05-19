import { git } from './gitExec.js';

/**
 * Entry in `git status --porcelain=v1 -z` output. The `-z` form is
 * NUL-delimited so filenames with newlines, spaces, quotes, or other shell
 * metacharacters round-trip safely. Rename pairs (`R<score>` / `C<score>`)
 * carry the original path in `from` and the new path in `path`.
 */
export interface PorcelainEntry {
  /** Two-char status code: ` M`, `M ` , `MM`, `A `, `??`, `R100`, `C075`, etc. */
  readonly indexCode: string;
  readonly workCode: string;
  readonly path: string;
  /** Source path for renames/copies (`R<score>` / `C<score>`); undefined otherwise. */
  readonly from?: string;
}

/**
 * Run `git status --porcelain=v1 -z -uall` and parse the NUL-delimited
 * stream into typed entries. Handles renames + copies, where git emits
 * the new path first then the old path separated by NUL (so we consume
 * one extra token).
 *
 * Why -z and not -uall newline-split: filenames may legitimately contain
 * `\n` (POSIX permits it), spaces, quotes, or backslashes. Newline-split
 * parsers either escape via `core.quotePath` (lossy round-trip) or fail
 * outright. The -z form is the only stable shape.
 */
export async function gitPorcelainV1Z(cwd: string): Promise<readonly PorcelainEntry[]> {
  const { stdout } = await git(['-C', cwd, 'status', '--porcelain=v1', '-z', '-uall']);
  return parsePorcelainV1Z(stdout);
}

export function parsePorcelainV1Z(raw: string): readonly PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  // git's -z form terminates each record with NUL. The first 2 bytes are
  // the X/Y status codes, then a space, then the path. Rename/copy records
  // append a second NUL-delimited token: the original path.
  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token.length === 0) {
      i++;
      continue;
    }
    if (token.length < 3) {
      // Malformed: shorter than `XY ` — skip defensively.
      i++;
      continue;
    }
    const indexCode = token[0] ?? ' ';
    const workCode = token[1] ?? ' ';
    const path = token.slice(3);
    const isRenameOrCopy = indexCode === 'R' || indexCode === 'C';
    if (isRenameOrCopy && i + 1 < tokens.length) {
      const from = tokens[i + 1] ?? '';
      entries.push({ indexCode, workCode, path, from });
      i += 2;
    } else {
      entries.push({ indexCode, workCode, path });
      i++;
    }
  }
  return entries;
}

/**
 * Run `git diff --name-only -z <range>` and return the list of changed
 * paths. NUL-delimited so paths with newlines or spaces survive intact.
 */
export async function gitDiffNameOnlyZ(cwd: string, range: string): Promise<readonly string[]> {
  const { stdout } = await git(['-C', cwd, 'diff', '--name-only', '-z', range]);
  return stdout.split('\0').filter((s) => s.length > 0);
}

/**
 * Run `git diff --name-only --diff-filter=<filter> -z <range>` and return
 * the typed path list. Used by validators that need to distinguish A/M/D
 * changes against a base.
 */
export async function gitDiffNameOnlyFilteredZ(
  cwd: string,
  range: string,
  filter: string,
): Promise<readonly string[]> {
  const { stdout } = await git([
    '-C',
    cwd,
    'diff',
    '--name-only',
    `--diff-filter=${filter}`,
    '-z',
    range,
  ]);
  return stdout.split('\0').filter((s) => s.length > 0);
}
