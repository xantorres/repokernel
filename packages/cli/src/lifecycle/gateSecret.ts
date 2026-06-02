import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gateSecretPath, loadGateSecret } from '@repokernel/core';

/**
 * Read the machine-local gate signing secret, minting one on first use. The
 * secret lives outside the repo (`~/.repokernel/gate.key`, mode 0600) so a
 * repo-bound agent cannot read it to forge a snapshot — the same trust boundary
 * as the reviewer command pin. Throws if the secret directory is unwritable
 * (the gate fails closed rather than signing with no durable key).
 */
export async function loadOrCreateGateSecret(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const existing = await loadGateSecret(env);
  if (existing) return existing;

  const path = gateSecretPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  try {
    await writeFile(path, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch {
    // Lost a race (or the file appeared): trust whatever is now on disk.
    const raced = await loadGateSecret(env);
    if (raced) return raced;
    // Re-read raw in case it exists but failed the strict loader; surface a
    // clear failure instead of silently signing with an ephemeral key.
    return (await readFile(path, 'utf8')).trim();
  }
}
