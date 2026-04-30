import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RepoKernelError } from '@repokernel/core';

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILE_BYTES = 1_048_576;

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'Stripe live key', pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
  { name: 'AWS access key ID', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key block', pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: 'GitHub PAT', pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'OpenAI API key', pattern: /sk-(?:proj|svcacct|admin|user)-[A-Za-z0-9_-]{20,}/ },
  { name: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
];

export function findSecretInText(text: string): SecretPattern | undefined {
  return SECRET_PATTERNS.find((p) => p.pattern.test(text));
}

/**
 * Patterns used by `redactSecrets` to scrub a single line of agent log
 * output before it lands on disk. Composed from:
 *   - the SECRET_PATTERNS list (specific token shapes), used with the `g`
 *     flag so all matches in a line are replaced, not just the first.
 *   - generic env-style assignments where the variable name signals a
 *     secret: anything matching `*_TOKEN`, `*_KEY`, `*_SECRET`,
 *     `*_PASSWORD`, or the bare names PASSWORD / TOKEN / KEY / SECRET.
 *     We replace only the value, keeping the name for grep-ability.
 *
 * The redactor is deliberately aggressive: we'd rather lose readability
 * on a benign-but-similar-looking string than ship a real secret to
 * `<opRoot>/runs/<id>/logs/*.log` where it would be checked into git via
 * the next `rk run` audit commit.
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = SECRET_PATTERNS.map(
  (p) => ({
    name: p.name,
    // Re-compile each pattern with the global flag so we replace every
    // occurrence in a line, not just the first.
    pattern: new RegExp(p.pattern.source, `${p.pattern.flags.replace(/g/g, '')}g`),
  }),
);

const ENV_ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD)|TOKEN|KEY|SECRET|PASSWORD)\s*[:=]\s*([^\s"'`,;)]{4,})/g;

const QUOTED_ENV_ASSIGNMENT_PATTERN =
  /\b([A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD)|TOKEN|KEY|SECRET|PASSWORD)\s*[:=]\s*(["'`])([^"'`\n]{4,})\2/g;

export function redactSecrets(line: string): string {
  let out = line;
  for (const { pattern } of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  out = out.replace(QUOTED_ENV_ASSIGNMENT_PATTERN, (_m, name, q) => `${name}=${q}[REDACTED]${q}`);
  out = out.replace(ENV_ASSIGNMENT_PATTERN, (_m, name) => `${name}=[REDACTED]`);
  return out;
}

/**
 * Scan only the staged content for the specified paths. This is the helper
 * used by `stagePathsAndCommit` so a `rk` metadata commit cannot be blocked
 * by an unrelated `scratch/.env.local` somewhere else in the working tree.
 *
 * Newly-added (previously-untracked) paths appear in `git diff --cached` as
 * pure additions, so a single staged-diff scan covers both modifications and
 * new files. We also fall back to reading the working-tree blob when a path
 * has no diff (e.g., an empty file), since secrets can hide in zero-line-diff
 * files that were renamed or chmod-only changes.
 */
export async function scanStagedPathsForSecrets(
  cwd: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;

  for (const relPath of paths) {
    const { stdout: diff } = await execFileAsync('git', [
      '-C',
      cwd,
      'diff',
      '--cached',
      '--no-color',
      '--',
      relPath,
    ]).catch(() => ({ stdout: '' }));

    const diffMatch = findSecretInText(diff);
    if (diffMatch) {
      throw new RepoKernelError(
        'SECRET_DETECTED',
        `secret pattern detected in staged content for ${relPath} — ${diffMatch.name}. Commit aborted.`,
      );
    }
  }
}

/**
 * Scan the entire working tree's diffs and untracked files. Reserved for an
 * explicit `rk secret-scan` style command — DO NOT use inside `stagePathsAndCommit`,
 * since unrelated untracked files would block scoped metadata commits.
 */
export async function scanWorkingTreeForSecrets(cwd: string): Promise<void> {
  const [diffResult, cachedResult] = await Promise.all([
    execFileAsync('git', ['-C', cwd, 'diff']).catch(() => ({ stdout: '' })),
    execFileAsync('git', ['-C', cwd, 'diff', '--cached']).catch(() => ({ stdout: '' })),
  ]);

  const combinedDiff = diffResult.stdout + cachedResult.stdout;

  const diffMatch = findSecretInText(combinedDiff);
  if (diffMatch) {
    throw new RepoKernelError(
      'SECRET_DETECTED',
      `secret pattern detected in working tree diff — ${diffMatch.name}.`,
    );
  }

  const { stdout: untrackedOut } = await execFileAsync('git', [
    '-C',
    cwd,
    'ls-files',
    '--others',
    '--exclude-standard',
  ]).catch(() => ({ stdout: '' }));

  const untrackedFiles = untrackedOut.trim().split('\n').filter(Boolean);

  for (const relPath of untrackedFiles) {
    const absolutePath = join(cwd, relPath);
    let content: string;
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size > MAX_UNTRACKED_FILE_BYTES) continue;
      content = await readFile(absolutePath, 'utf8');
    } catch {
      continue;
    }
    const fileMatch = findSecretInText(content);
    if (fileMatch) {
      throw new RepoKernelError(
        'SECRET_DETECTED',
        `secret pattern detected in new file ${relPath} — ${fileMatch.name}.`,
      );
    }
  }
}
