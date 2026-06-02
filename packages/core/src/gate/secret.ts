import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { trustFilePath } from '../trust/loader.js';

/** Override for the gate signing-secret path (tests, non-default homes). */
export const GATE_SECRET_ENV = 'REPOKERNEL_GATE_SECRET_FILE';

/**
 * Machine-local signing secret for reviewer-gate snapshots. Co-located with the
 * trust file (`~/.repokernel/gate.key` by default) — never inside the repo, so
 * a repo-bound agent cannot read it to forge a snapshot. Same trust boundary as
 * the reviewer command pin. Deriving from the trust-file directory means any
 * context that isolates the trust file (tests, alternate homes) isolates the
 * gate key too, without a second env override.
 */
export function gateSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GATE_SECRET_ENV];
  if (override && override.length > 0) return resolve(override);
  return join(dirname(trustFilePath(env)), 'gate.key');
}

const HEX64_RE = /^[a-f0-9]{64}$/u;

/**
 * Read the gate signing secret. Returns the trimmed hex string, or `null` when
 * the file is absent, not a regular file (a symlink could redirect the trust
 * boundary), or malformed. Read-only — callers that need to mint a secret use
 * the CLI-side `loadOrCreateGateSecret`. Returning `null` fails close
 * verification closed.
 */
export async function loadGateSecret(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const path = gateSecretPath(env);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return null;
    const raw = (await readFile(path, 'utf8')).trim();
    return HEX64_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
