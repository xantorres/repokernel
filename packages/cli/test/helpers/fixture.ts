import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checksCmdFingerprint,
  clearTrustCache,
  loadConfig,
  type RepoTrustGrant,
  UserLocalTrustSchema,
} from '@repokernel/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const tracked: string[] = [];

export interface FileSpec {
  readonly path: string;
  readonly content: string;
}

export async function makeFixture(files: readonly FileSpec[]): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'repokernel-cli-'));
  tracked.push(cwd);
  for (const f of files) {
    const abs = join(cwd, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content, 'utf8');
  }
  return cwd;
}

export async function cleanupAllFixtures(): Promise<void> {
  await Promise.all(tracked.map((d) => rm(d, { recursive: true, force: true })));
  tracked.length = 0;
}

/**
 * Seed a user-local trust grant for a fixture cwd. Writes to the trust file
 * pointed at by `REPOKERNEL_TRUST_FILE` (or to a freshly-created temp file
 * when the env var is unset, returning the path so the caller can set the
 * env var for subsequent rk invocations). Merges into existing grants if the
 * file already exists, so tests can seed multiple repos.
 *
 * Use this from tests that invoke any code path which spawns a configured
 * checksCmd, an external agent, or a panel reviewer — without it the
 * runtime trust gate will reject the action.
 */
export async function seedTrustForCwd(
  cwd: string,
  grant: Partial<RepoTrustGrant>,
): Promise<string> {
  const canonical = await realpath(cwd);
  // Mirror `rk trust grant checks_cmd`: when a caller grants checks_cmd without
  // an explicit pin, derive it from the repo config so the seeded grant is
  // enforceable exactly like a real grant. Repos without a loadable config or
  // any checks command stay unpinned (the trust gate is a no-op there).
  let checksPin = grant.checks_cmd_sha256;
  if (grant.checks_cmd && checksPin === undefined) {
    const load = await loadConfig({ cwd: canonical }).catch(() => null);
    if (load?.ok) checksPin = checksCmdFingerprint(load.config.automation);
  }
  let trustPath = process.env.REPOKERNEL_TRUST_FILE;
  if (!trustPath) {
    const dir = await mkdtemp(join(tmpdir(), 'rk-trust-'));
    tracked.push(dir);
    trustPath = join(dir, 'trust.yaml');
    process.env.REPOKERNEL_TRUST_FILE = trustPath;
  }

  let raw: Record<string, unknown> = { version: 1, repos: {} };
  try {
    const text = await readFile(trustPath, 'utf8');
    const parsed = parseYaml(text, { strict: true, maxAliasCount: 100 });
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    if (!raw.repos || typeof raw.repos !== 'object') raw.repos = {};
  } catch {
    /* fresh file is fine */
  }
  const repos = raw.repos as Record<string, unknown>;
  repos[canonical] = {
    checks_cmd: grant.checks_cmd ?? false,
    ...(checksPin !== undefined ? { checks_cmd_sha256: checksPin } : {}),
    env_passthrough: grant.env_passthrough ?? [],
    agents: grant.agents ?? [],
    reviewers: grant.reviewers ?? {},
  };

  // Validate before write so a fixture drift surfaces here loudly instead of
  // producing a malformed trust file that passes early tests for the wrong
  // reason. Matches the production write path's invariant.
  UserLocalTrustSchema.parse(raw);
  await writeFile(trustPath, stringifyYaml(raw), 'utf8');
  clearTrustCache();
  return trustPath;
}

/**
 * Reset the trust state between tests. Call from `afterEach` in suites that
 * use `seedTrustForCwd`.
 */
export function resetTrustForTest(originalEnv: string | undefined): void {
  if (originalEnv === undefined) delete process.env.REPOKERNEL_TRUST_FILE;
  else process.env.REPOKERNEL_TRUST_FILE = originalEnv;
  clearTrustCache();
}

export function defaultConfigYaml(): string {
  return `schemaVersion: 1
projectId: demo
projectName: Demo
paths:
  epics: epics
  sprints: sprints
  reviews: reviews
  queues: queues
  lanes: lanes
  generated: .repokernel
  registry: .repokernel/registry.json
`;
}

export function fm(data: Record<string, unknown>, body = ''): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${k}: ${formatYamlValue(v)}`);
  }
  lines.push('---', body);
  return lines.join('\n');
}

function formatYamlValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `\n${v.map((x) => `  - ${inline(x)}`).join('\n')}`;
  }
  return JSON.stringify(v);
}

function inline(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
