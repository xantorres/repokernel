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
        `secret pattern detected in new file ${relPath} — ${fileMatch.name}. Commit aborted.`,
      );
    }
  }
}
