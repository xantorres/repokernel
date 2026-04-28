import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoKernelError } from '@repokernel/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findSecretInText,
  SECRET_PATTERNS,
  scanStagedPathsForSecrets,
  scanWorkingTreeForSecrets,
} from '../src/lifecycle/secretScanner.js';

const exec = promisify(execFile);

// Template expressions break the literal so static secret scanners don't match.
const STRIPE_LIVE = `sk_live_${'a'.repeat(24)}`;
const STRIPE_TEST = `sk_test_${'a'.repeat(24)}`;
const AWS_KEY = `AKIA${'A'.repeat(16)}`;
const GITHUB_PAT = `ghp_${'a'.repeat(36)}`;
const OPENAI_KEY = `sk-proj-${'a'.repeat(32)}`;
const SLACK_TOKEN = `xoxb-${'a'.repeat(20)}`;

async function initGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-secret-scan-'));
  await exec('git', ['-C', dir, '-c', 'init.defaultBranch=main', 'init']);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@rk.dev']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'RK Test']);
  await writeFile(join(dir, 'README.md'), 'init\n', 'utf8');
  await exec('git', ['-C', dir, 'add', 'README.md']);
  await exec('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

describe('findSecretInText', () => {
  it('detects Stripe live key', () => {
    const match = findSecretInText(`+const key = "${STRIPE_LIVE}";`);
    expect(match?.name).toBe('Stripe live key');
  });

  it('detects AWS access key ID', () => {
    const match = findSecretInText(`+AWS_ACCESS_KEY_ID=${AWS_KEY}`);
    expect(match?.name).toBe('AWS access key ID');
  });

  it('detects RSA private key block', () => {
    const match = findSecretInText('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
    expect(match?.name).toBe('Private key block');
  });

  it('detects EC private key block', () => {
    const match = findSecretInText('-----BEGIN EC PRIVATE KEY-----\nMHQC...');
    expect(match?.name).toBe('Private key block');
  });

  it('detects generic private key block', () => {
    const match = findSecretInText('-----BEGIN PRIVATE KEY-----\nMIIE...');
    expect(match?.name).toBe('Private key block');
  });

  it('detects GitHub PAT', () => {
    const match = findSecretInText(`+token = "${GITHUB_PAT}";`);
    expect(match?.name).toBe('GitHub PAT');
  });

  it('detects OpenAI API key', () => {
    const match = findSecretInText(`+OPENAI_API_KEY="${OPENAI_KEY}"`);
    expect(match?.name).toBe('OpenAI API key');
  });

  it('detects Slack token', () => {
    const match = findSecretInText(`+SLACK_BOT_TOKEN="${SLACK_TOKEN}"`);
    expect(match?.name).toBe('Slack token');
  });

  it('returns undefined for clean text', () => {
    expect(findSecretInText('+const message = "hello world";\n+const count = 42;')).toBeUndefined();
  });

  it('does not false-positive on sk_test_ keys', () => {
    expect(findSecretInText(`+const key = "${STRIPE_TEST}";`)).toBeUndefined();
  });

  it('does not false-positive on short AWS-like strings', () => {
    expect(findSecretInText('+const id = "AKIA123";')).toBeUndefined();
  });
});

describe('SECRET_PATTERNS', () => {
  it('exports curated built-in patterns', () => {
    expect(SECRET_PATTERNS.length).toBe(6);
  });

  it('covers all expected pattern names', () => {
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(names).toContain('Stripe live key');
    expect(names).toContain('AWS access key ID');
    expect(names).toContain('Private key block');
    expect(names).toContain('GitHub PAT');
    expect(names).toContain('OpenAI API key');
    expect(names).toContain('Slack token');
  });
});

describe('scanStagedPathsForSecrets', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await initGitRepo();
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('passes when given an empty path list', async () => {
    await expect(scanStagedPathsForSecrets(repoDir, [])).resolves.toBeUndefined();
  });

  it('throws SECRET_DETECTED when staged path contains a Stripe key', async () => {
    const file = join(repoDir, 'meta.json');
    await writeFile(file, `{"key":"${STRIPE_LIVE}"}\n`, 'utf8');
    await exec('git', ['-C', repoDir, 'add', '--', 'meta.json']);
    await expect(scanStagedPathsForSecrets(repoDir, ['meta.json'])).rejects.toMatchObject({
      kind: 'SECRET_DETECTED',
    });
    await exec('git', ['-C', repoDir, 'rm', '--cached', '--', 'meta.json']);
    await rm(file);
  });

  it('error message includes the offending path', async () => {
    const file = join(repoDir, 'leaks.txt');
    await writeFile(file, `${AWS_KEY}\n`, 'utf8');
    await exec('git', ['-C', repoDir, 'add', '--', 'leaks.txt']);
    await expect(scanStagedPathsForSecrets(repoDir, ['leaks.txt'])).rejects.toSatisfy(
      (e: unknown) => (e as RepoKernelError).message.includes('leaks.txt'),
    );
    await exec('git', ['-C', repoDir, 'rm', '--cached', '--', 'leaks.txt']);
    await rm(file);
  });

  it('ignores secrets in unrelated untracked files (regression: scoped scan)', async () => {
    // Unrelated user file that should NOT block a scoped metadata commit.
    const unrelated = join(repoDir, 'scratch-env');
    await writeFile(unrelated, `${OPENAI_KEY}\n`, 'utf8');

    // Scoped commit on a totally separate path.
    const target = join(repoDir, 'note.md');
    await writeFile(target, 'safe content\n', 'utf8');
    await exec('git', ['-C', repoDir, 'add', '--', 'note.md']);
    await expect(scanStagedPathsForSecrets(repoDir, ['note.md'])).resolves.toBeUndefined();
    await exec('git', ['-C', repoDir, 'rm', '--cached', '--', 'note.md']);
    await rm(target);
    await rm(unrelated);
  });

  it('ignores modifications to other staged paths', async () => {
    // Stage a secret in fileA, but scan only fileB.
    const a = join(repoDir, 'a.txt');
    const b = join(repoDir, 'b.txt');
    await writeFile(a, `${GITHUB_PAT}\n`, 'utf8');
    await writeFile(b, 'clean\n', 'utf8');
    await exec('git', ['-C', repoDir, 'add', '--', 'a.txt', 'b.txt']);
    await expect(scanStagedPathsForSecrets(repoDir, ['b.txt'])).resolves.toBeUndefined();
    await exec('git', ['-C', repoDir, 'rm', '--cached', '--', 'a.txt', 'b.txt']);
    await rm(a);
    await rm(b);
  });
});

describe('scanWorkingTreeForSecrets', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await initGitRepo();
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('passes on a clean working tree', async () => {
    await expect(scanWorkingTreeForSecrets(repoDir)).resolves.toBeUndefined();
  });

  it('throws SECRET_DETECTED for an untracked file containing a secret', async () => {
    await writeFile(join(repoDir, 'untracked.env'), `${SLACK_TOKEN}\n`, 'utf8');
    await expect(scanWorkingTreeForSecrets(repoDir)).rejects.toMatchObject({
      kind: 'SECRET_DETECTED',
    });
    await rm(join(repoDir, 'untracked.env'));
  });
});
