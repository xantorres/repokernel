import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '@repokernel/core';
import {
  assertChecksCmdTrusted,
  killProcessTree,
  SIGTERM_GRACE_MS,
  spawnPolicyEnforced,
  trustCandidatesForCwd,
} from '../security/spawnPolicy.js';
import { operationalRoot } from './controlPaths.js';
import { git } from './gitExec.js';
import { StickyRedactor } from './secretScanner.js';

const CHECK_OUTPUT_LIMIT = 64 * 1024;

export interface ChecksOutcome {
  readonly ran: boolean;
  readonly ok: boolean;
  readonly code: number;
  /** True when the command was killed by our timeout instead of exiting on its own. */
  readonly timedOut?: boolean;
  readonly output?: string;
  /**
   * Per-phase outcomes when `automation.checksPhases` is configured. Each
   * configured phase contributes one entry; the overall `ok` is the AND of
   * every phase's outcome. Undefined when the flat `checksCmd` form is in
   * use.
   */
  readonly phases?: ReadonlyArray<{
    readonly phase: 'check' | 'typecheck' | 'build' | 'test';
    readonly command: string;
    readonly ok: boolean;
    readonly code: number;
    readonly timedOut?: boolean;
  }>;
  readonly cached?: boolean;
  readonly cacheKey?: string;
}

/**
 * Run the configured pre-close checks command.
 *
 * Returns `ran: false` when no checksCmd is configured (no-op). Otherwise
 * routes the command through the spawn-policy chokepoint, which restricts
 * the env to the default allowlist (no API keys, tokens, or other
 * repo-irrelevant secrets), registers the child with the owner abort
 * handler, and uses shell parsing only because users legitimately need
 * `npm test && npm run lint`-style pipelines. The TRUST_DENIED gate must
 * pass before this runs.
 *
 * `timeoutSeconds` (defaults to a long-but-finite value) bounds wall-clock
 * runtime. On expiry we send SIGTERM to the entire process group, then
 * SIGKILL after a short grace period, so a wedged test runner cannot stall
 * the close pipeline indefinitely. The detached process group is the
 * Unix-only path; on Windows we fall back to direct kill of the shell.
 */
export async function runConfiguredChecks(
  checksCmd: string | undefined,
  cwd: string,
  timeoutSeconds = 1800,
): Promise<ChecksOutcome> {
  if (!checksCmd) return { ran: false, ok: true, code: 0 };
  return new Promise<ChecksOutcome>((resolve) => {
    const { child, untrack } = spawnPolicyEnforced({
      command: checksCmd,
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = new BoundedRedactedBuffer(CHECK_OUTPUT_LIMIT);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      process.stdout.write(chunk);
      output.append(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      process.stderr.write(chunk);
      output.append(chunk);
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const detached = process.platform !== 'win32';

    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `rk: configured checks exceeded ${timeoutSeconds}s timeout — sending SIGTERM\n`,
      );
      if (child.pid) killProcessTree({ pid: child.pid, detached }, 'SIGTERM');
      killTimer = setTimeout(() => {
        process.stderr.write('rk: configured checks did not exit on SIGTERM — sending SIGKILL\n');
        if (child.pid) killProcessTree({ pid: child.pid, detached }, 'SIGKILL');
      }, SIGTERM_GRACE_MS);
    }, Math.max(1, timeoutSeconds) * 1000);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      untrack();
      if (timedOut) {
        resolve({
          ran: true,
          ok: false,
          code: code ?? 124,
          timedOut: true,
          output: output.flush(),
        });
        return;
      }
      resolve({ ran: true, ok: code === 0, code: code ?? 1, output: output.flush() });
    });
    child.on('error', () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      untrack();
      resolve({ ran: true, ok: false, code: 1, output: output.flush() });
    });
  });
}

/**
 * Convenience wrapper that resolves the effective checks shape from config
 * + an optional override and runs it. Trust gate runs against the config's
 * declared checks; an override passed by the user is not gated (the user
 * is explicitly typing the command themselves at that point).
 *
 * Order of precedence:
 *   1. `override` argument (user-supplied command on the CLI) — wins over
 *      both `checksCmd` and `checksPhases`.
 *   2. `automation.checksCmd` (single rolled-up command).
 *   3. `automation.checksPhases` (per-phase commands run in order:
 *      check → typecheck → build → test, stopping at the first failure).
 *
 * `checksCmd` and `checksPhases` are mutually exclusive at config-load time,
 * so cases 2 and 3 never both apply.
 */
export async function runConfiguredChecksFromConfig(
  config: Config,
  cwd: string,
  override?: string,
): Promise<ChecksOutcome> {
  if (override === undefined) {
    const candidates = await trustCandidatesForCwd(cwd);
    await assertChecksCmdTrusted(config.automation, cwd, { fallbackCwd: candidates[1] });
  }
  if (override === undefined && config.automation.checksPhases !== undefined) {
    return runPhasedChecks(config, cwd);
  }
  return runConfiguredChecks(
    override ?? config.automation.checksCmd,
    cwd,
    config.automation.checksTimeoutSeconds,
  );
}

export type GateCacheProfile = 'focused' | 'sprint' | 'epic' | 'release';

export async function runConfiguredChecksFromConfigCached(
  config: Config,
  cwd: string,
  profile: GateCacheProfile,
): Promise<ChecksOutcome> {
  const checksDescriptor = checksCacheDescriptor(config);
  if (profile === 'release' || checksDescriptor === null) {
    return runConfiguredChecksFromConfig(config, cwd);
  }

  const candidates = await trustCandidatesForCwd(cwd);
  await assertChecksCmdTrusted(config.automation, cwd, { fallbackCwd: candidates[1] });

  let cacheKey: string;
  let cachePath: string;
  try {
    const dirtyStatus = await git(['-C', cwd, 'status', '--porcelain=v1', '-z', '-uall'])
      .then((result) => result.stdout)
      .catch(() => '');
    if (dirtyStatus.length > 0) {
      return runConfiguredChecksFromConfig(config, cwd);
    }
    cacheKey = await checksCacheKey(cwd, profile, checksDescriptor);
    cachePath = await checksCachePath(cwd, cacheKey);
  } catch {
    return runConfiguredChecksFromConfig(config, cwd);
  }
  const cached = await readChecksCache(cachePath, checksDescriptor);
  if (cached !== null) return { ...cached, cached: true, cacheKey };

  const outcome =
    config.automation.checksPhases !== undefined
      ? await runPhasedChecks(config, cwd)
      : await runConfiguredChecks(
          config.automation.checksCmd,
          cwd,
          config.automation.checksTimeoutSeconds,
        );
  // Re-check the worktree AFTER the run. The pre-run dirty check (above) and
  // this one bracket the actual check execution: if the tree became dirty
  // while checks ran (a concurrent agent write, `git stash apply`, a file
  // watcher), the result no longer corresponds to a clean HEAD and must NOT
  // be cached — a later clean run at the same HEAD would otherwise get a
  // stale pass. Skip the write; still return the live result to this caller.
  const stillClean = await git(['-C', cwd, 'status', '--porcelain=v1', '-z', '-uall'])
    .then((result) => result.stdout.length === 0)
    .catch(() => false);
  if (stillClean) {
    await writeChecksCache(cachePath, checksDescriptor, outcome).catch(() => {});
  }
  return { ...outcome, cached: false, cacheKey };
}

async function runPhasedChecks(config: Config, cwd: string): Promise<ChecksOutcome> {
  const phases = config.automation.checksPhases;
  if (!phases) return { ran: false, ok: true, code: 0 };
  const order: Array<'check' | 'typecheck' | 'build' | 'test'> = [
    'check',
    'typecheck',
    'build',
    'test',
  ];
  const results: Array<{
    phase: 'check' | 'typecheck' | 'build' | 'test';
    command: string;
    ok: boolean;
    code: number;
    timedOut?: true;
  }> = [];
  const outputs: string[] = [];
  let firstFailureCode: number | null = null;
  for (const phase of order) {
    const command = phases[phase];
    if (command === undefined) continue;
    const outcome = await runConfiguredChecks(command, cwd, config.automation.checksTimeoutSeconds);
    if (outcome.output !== undefined && outcome.output.length > 0) outputs.push(outcome.output);
    results.push({
      phase,
      command,
      ok: outcome.ok,
      code: outcome.code,
      ...(outcome.timedOut === true ? { timedOut: true as const } : {}),
    });
    if (!outcome.ok) {
      firstFailureCode = outcome.code;
      // Stop at the first failure — later phases would only be noise.
      break;
    }
  }
  if (results.length === 0) {
    return { ran: false, ok: true, code: 0, phases: results };
  }
  return {
    ran: true,
    ok: firstFailureCode === null,
    code: firstFailureCode ?? 0,
    phases: results,
    ...(outputs.length > 0 ? { output: outputs.join('\n') } : {}),
  };
}

function checksCacheDescriptor(config: Config): string | null {
  const timeoutSeconds = config.automation.checksTimeoutSeconds;
  if (config.automation.checksPhases !== undefined) {
    return JSON.stringify({ checksPhases: config.automation.checksPhases, timeoutSeconds });
  }
  return config.automation.checksCmd === undefined
    ? null
    : JSON.stringify({ checksCmd: config.automation.checksCmd, timeoutSeconds });
}

async function checksCacheKey(
  cwd: string,
  profile: GateCacheProfile,
  descriptor: string,
): Promise<string> {
  const head = await git(['-C', cwd, 'rev-parse', 'HEAD'])
    .then((result) => result.stdout.trim())
    .catch(() => 'unknown');
  return createHash('sha256').update(JSON.stringify({ profile, descriptor, head })).digest('hex');
}

async function checksCachePath(cwd: string, key: string): Promise<string> {
  return join(await operationalRoot(cwd), 'gate-cache', 'checks', `${key}.json`);
}

async function readChecksCache(path: string, descriptor: string): Promise<ChecksOutcome | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      descriptor?: unknown;
      outcome?: unknown;
    };
    if (raw.descriptor !== descriptor) return null;
    const outcome = raw.outcome as Partial<ChecksOutcome> | undefined;
    if (
      typeof outcome?.ran !== 'boolean' ||
      typeof outcome.ok !== 'boolean' ||
      typeof outcome.code !== 'number'
    ) {
      return null;
    }
    const parsed: ChecksOutcome = {
      ran: outcome.ran,
      ok: outcome.ok,
      code: outcome.code,
      ...(outcome.timedOut === true ? { timedOut: true } : {}),
      ...(typeof outcome.output === 'string' ? { output: outcome.output } : {}),
    };
    if (!Array.isArray(outcome.phases)) return parsed;
    // Validate each cached phase element rather than blind-casting — an
    // older rk could have written a different `phases` shape; a malformed
    // element would otherwise surface as `undefined.phase` at a call site.
    const phases = outcome.phases.filter(isCachedPhase);
    if (phases.length !== outcome.phases.length) return parsed;
    return { ...parsed, phases };
  } catch {
    return null;
  }
}

class BoundedRedactedBuffer {
  private readonly redactor = new StickyRedactor();
  private buffer = '';
  private pending = '';

  constructor(private readonly limit: number) {}

  append(chunk: Buffer | string): void {
    this.pending += chunk.toString();
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.push(`${this.redactor.redact(line)}\n`);
      newline = this.pending.indexOf('\n');
    }
    if (this.pending.length > 4096) {
      this.push(this.redactor.redact(this.pending));
      this.pending = '';
    }
  }

  flush(): string {
    if (this.pending.length > 0) {
      this.push(this.redactor.redact(this.pending));
      this.pending = '';
    }
    return this.buffer;
  }

  private push(text: string): void {
    this.buffer += text;
    if (this.buffer.length > this.limit) {
      this.buffer = this.buffer.slice(this.buffer.length - this.limit);
    }
  }
}

function isCachedPhase(value: unknown): value is NonNullable<ChecksOutcome['phases']>[number] {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.phase === 'check' || v.phase === 'typecheck' || v.phase === 'build' || v.phase === 'test') &&
    typeof v.command === 'string' &&
    typeof v.ok === 'boolean' &&
    typeof v.code === 'number'
  );
}

async function writeChecksCache(
  path: string,
  descriptor: string,
  outcome: ChecksOutcome,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ descriptor, cached_at: new Date().toISOString(), outcome }, null, 2)}\n`,
    'utf8',
  );
}
