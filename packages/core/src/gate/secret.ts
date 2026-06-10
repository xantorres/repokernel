import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Override for the gate signing-secret path (tests, non-default homes). */
export const GATE_SECRET_ENV = 'REPOKERNEL_GATE_SECRET_FILE';

/**
 * Machine-local signing secret for reviewer-gate snapshots. Lives at a fixed
 * `~/.repokernel/gate.key` (never inside the repo, so a repo-bound agent cannot
 * read it to forge a snapshot), independent of the trust-file location. The
 * path is deliberately NOT derived from `REPOKERNEL_TRUST_FILE`: a reviewer
 * subprocess with that env set could otherwise redirect the key path as a side
 * effect. Use the explicit `REPOKERNEL_GATE_SECRET_FILE` override to relocate
 * it (tests, alternate homes).
 */
export function gateSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GATE_SECRET_ENV];
  if (override && override.length > 0) return resolve(override);
  return join(homedir(), '.repokernel', 'gate.key');
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
    // A signing key readable/writable by group or other defeats its purpose:
    // any same-host account could read it and forge snapshots. Reject loose
    // permissions on POSIX (the minter writes 0600). Windows ACLs differ — skip.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return null;
    const raw = (await readFile(path, 'utf8')).trim();
    return HEX64_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
