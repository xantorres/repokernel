import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { docsUrl, RepoKernelError } from '../errors/RepoKernelError.js';
import {
  EMPTY_REPO_GRANT,
  EMPTY_USER_TRUST,
  type RepoTrustGrant,
  type UserLocalTrust,
  UserLocalTrustSchema,
} from './schema.js';

export const TRUST_FILE_ENV = 'REPOKERNEL_TRUST_FILE';
const DEFAULT_TRUST_PATH = join(homedir(), '.repokernel', 'trust.yaml');

export function trustFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TRUST_FILE_ENV];
  if (override && override.length > 0) return resolve(override);
  return DEFAULT_TRUST_PATH;
}

let cache: { path: string; trust: UserLocalTrust } | null = null;

export function clearTrustCache(): void {
  cache = null;
}

export async function loadUserTrust(env: NodeJS.ProcessEnv = process.env): Promise<UserLocalTrust> {
  const path = trustFilePath(env);
  if (cache && cache.path === path) return cache.trust;

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      cache = { path, trust: EMPTY_USER_TRUST };
      return EMPTY_USER_TRUST;
    }
    throw new RepoKernelError(
      'CONFIG_FILE_UNREADABLE',
      `cannot read trust file at ${path}: ${(cause as Error).message}`,
      cause,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true });
  } catch (cause) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `trust file at ${path} is not valid YAML: ${(cause as Error).message}. See ${docsUrl('TRUST_DENIED')}`,
      cause,
    );
  }

  if (raw === null || raw === undefined) {
    cache = { path, trust: EMPTY_USER_TRUST };
    return EMPTY_USER_TRUST;
  }

  const parsed = UserLocalTrustSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `trust file at ${path} failed validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. See ${docsUrl('TRUST_DENIED')}`,
    );
  }

  cache = { path, trust: parsed.data };
  return parsed.data;
}

export async function repoGrantFor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RepoTrustGrant> {
  const trust = await loadUserTrust(env);
  let canonical: string;
  try {
    canonical = await realpath(cwd);
  } catch {
    canonical = resolve(cwd);
  }
  return trust.repos[canonical] ?? EMPTY_REPO_GRANT;
}
