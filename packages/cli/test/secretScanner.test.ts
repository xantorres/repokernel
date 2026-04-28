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
  scanDiffForSecrets,
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

describe('scanDiffForSecrets', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await initGitRepo();
  });

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('passes on a clean working tree', async () => {
    await expect(scanDiffForSecrets(repoDir)).resolves.toBeUndefined();
  });

  it('passes when modified file has no secrets', async () => {
    await writeFile(join(repoDir, 'safe.ts'), 'const x = 1;\n', 'utf8');
    await expect(scanDiffForSecrets(repoDir)).resolves.toBeUndefined();
    await exec('git', ['-C', repoDir, 'checkout', '--', '.']);
  });

  it('throws SECRET_DETECTED for Stripe key in modified tracked file', async () => {
    await writeFile(join(repoDir, 'README.md'), `${STRIPE_LIVE}\n`, 'utf8');
    await expect(scanDiffForSecrets(repoDir)).rejects.toMatchObject({ kind: 'SECRET_DETECTED' });
    await exec('git', ['-C', repoDir, 'checkout', '--', '.']);
  });

  it('throws SECRET_DETECTED for AWS key in new untracked file', async () => {
    await writeFile(join(repoDir, 'new-config.env'), `${AWS_KEY}\n`, 'utf8');
    await expect(scanDiffForSecrets(repoDir)).rejects.toMatchObject({ kind: 'SECRET_DETECTED' });
    await rm(join(repoDir, 'new-config.env'));
  });

  it('throws SECRET_DETECTED for GitHub PAT in staged file', async () => {
    const secretFile = join(repoDir, 'staged.ts');
    await writeFile(secretFile, `${GITHUB_PAT}\n`, 'utf8');
    await exec('git', ['-C', repoDir, 'add', secretFile]);
    await expect(scanDiffForSecrets(repoDir)).rejects.toMatchObject({ kind: 'SECRET_DETECTED' });
    await exec('git', ['-C', repoDir, 'rm', '--cached', secretFile]);
    await rm(secretFile);
  });

  it('error message identifies the pattern name', async () => {
    await writeFile(join(repoDir, 'README.md'), `${STRIPE_LIVE}\n`, 'utf8');
    await expect(scanDiffForSecrets(repoDir)).rejects.toSatisfy((e: unknown) =>
      (e as RepoKernelError).message.includes('Stripe live key'),
    );
    await exec('git', ['-C', repoDir, 'checkout', '--', '.']);
  });
});
