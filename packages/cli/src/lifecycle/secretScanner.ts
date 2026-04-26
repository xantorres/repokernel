import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { RepoKernelError } from '@repokernel/core';

const execFileAsync = promisify(execFile);

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'Stripe live key', pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
  { name: 'AWS access key ID', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key block', pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: 'GitHub PAT', pattern: /ghp_[a-zA-Z0-9]{36}/ },
];

export function findSecretInText(text: string): SecretPattern | undefined {
  return SECRET_PATTERNS.find((p) => p.pattern.test(text));
}

export async function scanDiffForSecrets(cwd: string): Promise<void> {
  const [diffResult, cachedResult] = await Promise.all([
    execFileAsync('git', ['-C', cwd, 'diff']).catch(() => ({ stdout: '' })),
    execFileAsync('git', ['-C', cwd, 'diff', '--cached']).catch(() => ({ stdout: '' })),
  ]);

  const combinedDiff = diffResult.stdout + cachedResult.stdout;

  const diffMatch = findSecretInText(combinedDiff);
  if (diffMatch) {
    throw new RepoKernelError(
      'SECRET_DETECTED',
      `secret pattern detected in staged diff — ${diffMatch.name}. Commit aborted.`,
    );
  }

  // Also scan new untracked files that would be added by git add -A
  const { stdout: untrackedOut } = await execFileAsync('git', [
    '-C',
    cwd,
    'ls-files',
    '--others',
    '--exclude-standard',
  ]).catch(() => ({ stdout: '' }));

  const untrackedFiles = untrackedOut.trim().split('\n').filter(Boolean);

  for (const relPath of untrackedFiles) {
    let content: string;
    try {
      content = await readFile(`${cwd}/${relPath}`, 'utf8');
    } catch {
      continue;
    }
    const fileMatch = findSecretInText(content);
    if (fileMatch) {
      throw new RepoKernelError(
        'SECRET_DETECTED',
        `secret pattern detected in new file ${relPath} — ${fileMatch.name}. Commit aborted.`,
      );
    }
  }
}
