import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gateSecretPath, loadGateSecret, RepoKernelError } from '@repokernel/core';

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
  } catch (cause) {
    // Lost a create race, or a file already exists. Trust ONLY a strict-valid
    // key on disk — never sign with malformed contents (a snapshot signed by a
    // bad key could never verify, silently dead-ending close).
    const raced = await loadGateSecret(env);
    if (raced) return raced;
    throw new RepoKernelError(
      'GATE_KEY_INVALID',
      `gate signing key at ${path} exists but is not a valid 32-byte hex secret (or is not a regular file); remove it so a fresh key can be minted`,
      cause,
    );
  }
}
