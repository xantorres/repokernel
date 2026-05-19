import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { docsUrl, RepoKernelError, toErrorMessage } from '../errors/RepoKernelError.js';
import {
  EMPTY_REPO_GRANT,
  EMPTY_USER_TRUST,
  RESERVED_REPO_KEYS,
  type RepoTrustGrant,
  SUPPORTED_TRUST_FILE_VERSIONS,
  type UserLocalTrust,
  UserLocalTrustSchema,
} from './schema.js';

export const TRUST_FILE_ENV = 'REPOKERNEL_TRUST_FILE';
const DEFAULT_TRUST_PATH = join(homedir(), '.repokernel', 'trust.yaml');
const MAX_TRUST_FILE_BYTES = 256 * 1024;

export function trustFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TRUST_FILE_ENV];
  if (override && override.length > 0) return resolve(override);
  return DEFAULT_TRUST_PATH;
}

let cache: { path: string; trust: UserLocalTrust } | null = null;

export function clearTrustCache(): void {
  cache = null;
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function errnoCode(value: unknown): string | undefined {
  if (!isErrnoException(value)) return undefined;
  return typeof value.code === 'string' ? value.code : undefined;
}

export async function loadUserTrust(env: NodeJS.ProcessEnv = process.env): Promise<UserLocalTrust> {
  const path = trustFilePath(env);
  if (cache && cache.path === path) return cache.trust;

  try {
    const info = await stat(path);
    if (!info.isFile()) {
      throw new RepoKernelError(
        'TRUST_FILE_UNREADABLE',
        `trust file at ${path} is not a regular file. See ${docsUrl('TRUST_FILE_UNREADABLE')}`,
      );
    }
    if (info.size > MAX_TRUST_FILE_BYTES) {
      throw new RepoKernelError(
        'TRUST_FILE_INVALID',
        `trust file at ${path} is ${info.size} bytes (max ${MAX_TRUST_FILE_BYTES}). Trim it or split into multiple repos. See ${docsUrl('TRUST_FILE_INVALID')}`,
      );
    }
  } catch (cause) {
    if (cause instanceof RepoKernelError) throw cause;
    const code = errnoCode(cause);
    if (code === 'ENOENT') {
      cache = { path, trust: EMPTY_USER_TRUST };
      return EMPTY_USER_TRUST;
    }
    throw new RepoKernelError(
      'TRUST_FILE_UNREADABLE',
      `cannot stat trust file at ${path}: ${toErrorMessage(cause)}. See ${docsUrl('TRUST_FILE_UNREADABLE')}`,
      cause,
    );
  }

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === 'ENOENT') {
      cache = { path, trust: EMPTY_USER_TRUST };
      return EMPTY_USER_TRUST;
    }
    throw new RepoKernelError(
      'TRUST_FILE_UNREADABLE',
      `cannot read trust file at ${path}: ${toErrorMessage(cause)}. See ${docsUrl('TRUST_FILE_UNREADABLE')}`,
      cause,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, maxAliasCount: 100 });
  } catch (cause) {
    throw new RepoKernelError(
      'TRUST_FILE_INVALID',
      `trust file at ${path} is not valid YAML: ${toErrorMessage(cause)}. See ${docsUrl('TRUST_FILE_INVALID')}`,
      cause,
    );
  }

  if (raw === null || raw === undefined) {
    cache = { path, trust: EMPTY_USER_TRUST };
    return EMPTY_USER_TRUST;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RepoKernelError(
      'TRUST_FILE_INVALID',
      `trust file at ${path} must be a YAML mapping at the top level. See ${docsUrl('TRUST_FILE_INVALID')}`,
    );
  }

  rejectReservedRepoKeys(raw, path);

  if (
    'version' in (raw as Record<string, unknown>) &&
    typeof (raw as Record<string, unknown>).version === 'number' &&
    !(SUPPORTED_TRUST_FILE_VERSIONS as readonly number[]).includes(
      (raw as { version: number }).version,
    )
  ) {
    throw new RepoKernelError(
      'TRUST_FILE_VERSION_UNSUPPORTED',
      `trust file at ${path} declares version ${(raw as { version: number }).version}; this rk supports ${SUPPORTED_TRUST_FILE_VERSIONS.join(', ')}. Upgrade rk or downgrade the trust file. See ${docsUrl('TRUST_FILE_VERSION_UNSUPPORTED')}`,
    );
  }

  const parsed = UserLocalTrustSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepoKernelError(
      'TRUST_FILE_INVALID',
      `trust file at ${path} failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}. See ${docsUrl('TRUST_FILE_INVALID')}`,
    );
  }

  cache = { path, trust: parsed.data };
  return parsed.data;
}

function rejectReservedRepoKeys(raw: unknown, path: string): void {
  if (!raw || typeof raw !== 'object') return;
  const repos = (raw as { repos?: unknown }).repos;
  if (!repos || typeof repos !== 'object') return;
  for (const key of Object.keys(repos as object)) {
    if (RESERVED_REPO_KEYS.includes(key)) {
      throw new RepoKernelError(
        'TRUST_FILE_INVALID',
        `trust file at ${path} uses a reserved repo key '${key}'. See ${docsUrl('TRUST_FILE_INVALID')}`,
      );
    }
  }
}

async function canonicalize(cwd: string): Promise<string> {
  const absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
  try {
    return await realpath(absolute);
  } catch (cause) {
    const code = errnoCode(cause);
    if (code === 'ENOENT') {
      // Path does not exist on disk. Trust lookup cannot proceed because we
      // would otherwise key the grant against a non-canonical path that an
      // attacker could pre-seed in the trust file via a different symlink.
      throw new RepoKernelError(
        'TRUST_DENIED',
        `cannot canonicalize ${absolute}: path does not exist. See ${docsUrl('TRUST_DENIED')}`,
        cause,
      );
    }
    return absolute;
  }
}

/**
 * Resolve the host repo path for a worktree by reading the `.git` pointer
 * file. Returns null when the cwd is not a worktree (its `.git` is a
 * directory) or when the pointer cannot be parsed. Pure filesystem; no
 * subprocess. Caller may pass the result as a fallback candidate in
 * `repoGrantForAny` so a grant on the host repo applies inside worktrees.
 */
export async function controlRepoForWorktree(cwd: string): Promise<string | null> {
  let gitPointer: string;
  try {
    const info = await stat(join(cwd, '.git'));
    if (info.isDirectory()) return null;
    gitPointer = await readFile(join(cwd, '.git'), 'utf8');
  } catch {
    return null;
  }
  const match = gitPointer.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match?.[1]) return null;
  const gitDir = isAbsolute(match[1]) ? match[1] : resolve(cwd, match[1]);
  // gitDir for a worktree looks like <main>/.git/worktrees/<name>. Strip the
  // tail to recover the host repo path. For non-worktree pointers (rare),
  // strip a trailing /.git instead.
  const worktreeSegment = `${sep}.git${sep}worktrees${sep}`;
  const worktreeIdx = gitDir.indexOf(worktreeSegment);
  if (worktreeIdx !== -1) {
    const mainGit = gitDir.slice(0, worktreeIdx + `${sep}.git`.length);
    return dirname(mainGit);
  }
  if (gitDir.endsWith(`${sep}.git`)) {
    return gitDir.slice(0, -`${sep}.git`.length);
  }
  return null;
}

export async function repoGrantFor(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RepoTrustGrant> {
  const trust = await loadUserTrust(env);
  const canonical = await canonicalize(cwd);
  if (Object.hasOwn(trust.repos, canonical)) {
    return trust.repos[canonical] ?? EMPTY_REPO_GRANT;
  }
  return EMPTY_REPO_GRANT;
}

/**
 * Look up the first explicit grant among the candidate paths. Used to make a
 * grant on the host repo flow through to its worktrees: pass the worktree
 * cwd first, then the resolved control-repo path.
 */
export async function repoGrantForAny(
  cwds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<RepoTrustGrant> {
  const trust = await loadUserTrust(env);
  for (const cwd of cwds) {
    let canonical: string;
    try {
      canonical = await canonicalize(cwd);
    } catch {
      continue;
    }
    if (Object.hasOwn(trust.repos, canonical)) {
      const grant = trust.repos[canonical];
      if (grant) return grant;
    }
  }
  return EMPTY_REPO_GRANT;
}
