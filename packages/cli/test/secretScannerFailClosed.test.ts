import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scanStagedPathsForSecrets,
  scanWorkingTreeForSecrets,
} from '../src/lifecycle/secretScanner.js';

const tracked: string[] = [];
afterEach(async () => {
  await Promise.all(tracked.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rk-secret-fail-'));
  tracked.push(dir);
  return dir;
}

describe('secret scanner fail-closed', () => {
  it('throws SECRET_SCAN_FAILED when invoked against a non-git directory', async () => {
    const cwd = await tmp();
    // No `.git` here — git diff will fail with "not a git repository". We
    // want a typed SECRET_SCAN_FAILED, not a silent pass.
    await expect(scanStagedPathsForSecrets(cwd, ['some/file.txt'])).rejects.toThrow(
      /SECRET_SCAN_FAILED|secret scanner/i,
    );
  });

  it('working tree scan also fails closed on a non-git directory', async () => {
    const cwd = await tmp();
    await expect(scanWorkingTreeForSecrets(cwd)).rejects.toThrow(
      /SECRET_SCAN_FAILED|secret scanner/i,
    );
  });

  it('is a no-op when paths array is empty', async () => {
    const cwd = await tmp();
    await expect(scanStagedPathsForSecrets(cwd, [])).resolves.toBeUndefined();
  });
});
