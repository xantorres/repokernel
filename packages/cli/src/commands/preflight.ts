import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  generateRegistry,
  type LoadProjectOutcome,
  loadProject,
  RepoKernelError,
  runValidators,
  type TeamStatus,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { operationalRoot } from '../lifecycle/controlPaths.js';
import { getTeamStatus } from '../lifecycle/runState.js';
import { RK_GENERATED_BY } from '../version.js';
import type { CommandResult } from './validate.js';

/**
 * Default cache TTL. Long enough that plugin commands invoked back-to-back
 * during a single user session don't all re-scan the worktree, short enough
 * that drift is caught within one operational tick.
 */
const DEFAULT_MAX_AGE_SECONDS = 60;

const CACHE_FILENAME = 'preflight.json';
const PREFLIGHT_SCHEMA_VERSION = 1 as const;

export interface PreflightOptions {
  readonly cwd: string;
  readonly json?: boolean;
  /** Force-refresh the cache. */
  readonly refresh?: boolean;
  /** Cache freshness budget in seconds. Defaults to 60. */
  readonly maxAgeSeconds?: number;
}

interface CachedPreflight {
  readonly schemaVersion: typeof PREFLIGHT_SCHEMA_VERSION;
  readonly captured_at: string;
  readonly status: TeamStatus;
}

interface PreflightResult {
  readonly schemaVersion: typeof PREFLIGHT_SCHEMA_VERSION;
  readonly captured_at: string;
  readonly cache_age_seconds: number;
  readonly cache_hit: boolean;
  readonly warnings_count: number;
  readonly status: TeamStatus;
}

export async function runPreflightCommand(opts: PreflightOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  const maxAge = (opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS) * 1000;

  let opRoot: string;
  try {
    opRoot = await operationalRoot(cwd);
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  const cachePath = join(opRoot, CACHE_FILENAME);

  if (opts.refresh !== true) {
    const cached = await readCache(cachePath);
    if (cached !== null) {
      const ageMs = Date.now() - Date.parse(cached.captured_at);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAge) {
        return formatResult(buildResult(cached, ageMs, true), opts.json === true);
      }
    }
  }

  const fresh = await capture(cwd);
  if ('error' in fresh) return fresh.error;
  await writeCache(cachePath, fresh.cache);
  return formatResult(buildResult(fresh.cache, 0, false), opts.json === true);
}

async function capture(
  cwd: string,
): Promise<{ readonly cache: CachedPreflight } | { readonly error: CommandResult }> {
  let outcome: LoadProjectOutcome;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { error: { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` } };
    }
    throw cause;
  }
  if (!outcome.ok) {
    return {
      error: {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: 'project state is invalid; run `rk validate`\n',
      },
    };
  }
  const findings = runValidators({
    graph: outcome.graph,
    config: outcome.config,
    parsed: outcome.parsed,
    parseFindings: outcome.parsed.findings,
  });
  const registry = generateRegistry({
    graph: outcome.graph,
    config: outcome.config,
    findings,
    generatedBy: RK_GENERATED_BY,
  });
  const opRoot = await operationalRoot(cwd);
  const status = await getTeamStatus({ opRoot, registry, controlCwd: cwd });
  return {
    cache: {
      schemaVersion: PREFLIGHT_SCHEMA_VERSION,
      captured_at: new Date().toISOString(),
      status,
    },
  };
}

async function readCache(cachePath: string): Promise<CachedPreflight | null> {
  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CachedPreflight>;
    if (parsed.schemaVersion !== PREFLIGHT_SCHEMA_VERSION) return null;
    if (typeof parsed.captured_at !== 'string') return null;
    if (parsed.status === undefined) return null;
    return parsed as CachedPreflight;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: CachedPreflight): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

function buildResult(cache: CachedPreflight, ageMs: number, cacheHit: boolean): PreflightResult {
  const op = cache.status.operational;
  const warnings_count =
    op.live_claims.length +
    op.corrupt_run_files.length +
    op.leaked_worktrees.length +
    op.collection_errors.length;
  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    captured_at: cache.captured_at,
    cache_age_seconds: Math.round(ageMs / 1000),
    cache_hit: cacheHit,
    warnings_count,
    status: cache.status,
  };
}

function formatResult(result: PreflightResult, json: boolean): CommandResult {
  if (json) {
    return { exitCode: EXIT_OK, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
  }
  return {
    exitCode: EXIT_OK,
    stdout: renderText(result),
    stderr: '',
  };
}

function renderText(result: PreflightResult): string {
  const lines: string[] = [];
  const cacheLabel = result.cache_hit
    ? pc.dim(`(cached ${result.cache_age_seconds}s ago)`)
    : pc.dim('(fresh)');
  lines.push(`${pc.bold('Preflight')} ${cacheLabel}`);
  lines.push('');

  const op = result.status.operational;

  if (op.collection_errors.length > 0) {
    lines.push(pc.bold(pc.red('Operational data degraded:')));
    for (const err of op.collection_errors) lines.push(`  ${pc.red('•')} ${err}`);
    lines.push('');
  }

  if (op.live_claims.length > 0) {
    lines.push(pc.bold('Live sprint claims:'));
    for (const claim of op.live_claims) {
      lines.push(
        `  ${pc.yellow('•')} ${claim.sprint_id} (run ${claim.run_id}, since ${claim.claimed_at})`,
      );
    }
    lines.push('');
  }

  if (op.leaked_worktrees.length > 0) {
    lines.push(pc.bold('Leaked worktrees:'));
    for (const wt of op.leaked_worktrees) {
      lines.push(`  ${pc.yellow('•')} ${wt.kind} ${wt.id} at ${wt.path}`);
    }
    lines.push('');
  }

  if (op.corrupt_run_files.length > 0) {
    lines.push(pc.bold('Corrupt run files:'));
    for (const c of op.corrupt_run_files) {
      lines.push(`  ${pc.red('•')} ${c.file} (${c.reason})`);
    }
    lines.push('');
  }

  if (result.warnings_count === 0) {
    lines.push(pc.green('No operational warnings. Safe to dispatch.'));
  } else {
    lines.push(
      pc.yellow(`${result.warnings_count} operational warning(s) — surface before dispatch.`),
    );
  }
  return `${lines.join('\n')}\n`;
}
