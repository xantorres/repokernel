import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Override for the gate signing-secret path (tests, non-default homes). */
export const GATE_SECRET_ENV = 'REPOKERNEL_GATE_SECRET_FILE';

/**
 * Machine-local signing secret for reviewer-gate snapshots, co-located with the
 * trust file (`~/.repokernel/`) — never inside the repo, so a repo-bound agent
 * cannot read it to forge a snapshot. Same trust boundary as the reviewer
 * command pin.
 */
const DEFAULT_GATE_SECRET_PATH = join(homedir(), '.repokernel', 'gate.key');

export function gateSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GATE_SECRET_ENV];
  if (override && override.length > 0) return resolve(override);
  return DEFAULT_GATE_SECRET_PATH;
}

const HEX64_RE = /^[a-f0-9]{64}$/u;

/**
 * Read the gate signing secret. Returns the trimmed hex string, or `null` when
 * the file is absent or malformed. Read-only — callers that need to mint a
 * secret use the CLI-side `loadOrCreateGateSecret`.
 */
export async function loadGateSecret(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const raw = (await readFile(gateSecretPath(env), 'utf8')).trim();
    return HEX64_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
