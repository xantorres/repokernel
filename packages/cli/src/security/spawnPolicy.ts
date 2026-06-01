import {
  type ChildProcess,
  type ChildProcessByStdio,
  exec,
  execFile,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  type AgentDefinition,
  type Automation,
  controlRepoForWorktree,
  docsUrl,
  evaluateAgentGrant,
  evaluateChecksCmdGrant,
  evaluateReviewerGrant,
  RepoKernelError,
  type RepoTrustGrant,
  type ReviewerGrant,
  repoGrantForAny,
  trustFilePath,
} from '@repokernel/core';
import { trackActiveChild } from '../lifecycle/abortHandler.js';

/**
 * Default env names the spawn chokepoint will forward to children. This is
 * the floor — every spawn gets at least these. Trust-granted env_passthrough
 * names are layered on top per call. Anything else from the parent process
 * environment is dropped.
 */
const DEFAULT_SPAWN_ENV_ALLOWLIST_MUTABLE: readonly string[] = [
  // POSIX essentials
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'CI',
  // Windows essentials
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'NUMBER_OF_PROCESSORS',
  'COLOR',
  'NO_COLOR',
  'FORCE_COLOR',
];

export const DEFAULT_SPAWN_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  ...DEFAULT_SPAWN_ENV_ALLOWLIST_MUTABLE,
]);

/**
 * Env names that git itself reads to drive identity/commit metadata. Forwarded
 * to `spawnTooling` calls so commits authored under rk carry the same author/
 * committer/date as the parent process intended, without exposing arbitrary
 * GH_/GITHUB_ secrets that hooks could exfiltrate.
 */
export const GIT_TOOLING_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_EDITOR',
  'GIT_PAGER',
  'GIT_TERMINAL_PROMPT',
  // Block global/system config from poisoning the spawn. Setting these to '1'
  // at the call site (see `spawnTooling`) is preferred, but if the parent
  // has them set we want them to flow through.
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_NOGLOBAL',
  'GIT_OPTIONAL_LOCKS',
  'XDG_CONFIG_HOME',
]);

export const SIGTERM_GRACE_MS = 5_000;

export function buildPolicyEnv(
  parentEnv: NodeJS.ProcessEnv,
  passthrough: readonly string[],
  injectEnv?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...DEFAULT_SPAWN_ENV_ALLOWLIST, ...passthrough]);
  const out: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = parentEnv[name];
    if (typeof value === 'string') out[name] = value;
  }
  if (injectEnv) Object.assign(out, injectEnv);
  return out;
}

export interface SpawnPolicyOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Explicit env passthrough names (from a trust grant). Beyond the default allowlist. */
  readonly envPassthrough?: readonly string[];
  /** Static key-value pairs injected unconditionally into the subprocess env. */
  readonly injectEnv?: Readonly<Record<string, string>>;
  /** True only for `automation.checksCmd` style entries that legitimately need shell parsing. */
  readonly shell?: boolean;
  readonly stdio?: SpawnOptions['stdio'];
}

export interface SpawnPolicyResult<C extends ChildProcess = ChildProcess> {
  readonly child: C;
  /** Call when the child exits (any reason) to release the abort tracker handle. */
  readonly untrack: () => void;
}

export type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

function spawnWithPolicy(
  opts: SpawnPolicyOptions,
  stdio: SpawnOptions['stdio'],
): { child: ChildProcess; untrack: () => void; detached: boolean } {
  const env = buildPolicyEnv(process.env, opts.envPassthrough ?? [], opts.injectEnv);
  const detached = process.platform !== 'win32';
  const child = spawn(opts.command, [...(opts.args ?? [])], {
    cwd: opts.cwd,
    stdio,
    detached,
    env,
    shell: opts.shell ?? false,
    windowsHide: true,
  });
  const untrack = child.pid ? trackActiveChild({ pid: child.pid, detached }) : () => {};
  return { child, untrack, detached };
}

/**
 * Single chokepoint for spawning child processes. Constructs the env from a
 * trust-checked allowlist (never inherits the full `process.env`), registers
 * the child with the owner's abort handler, and returns the ChildProcess for
 * the caller to wire streams/handlers. shell=true is permitted only when the
 * caller explicitly requests it (and has gone through the trust gate that
 * authorized the command).
 */
export function spawnPolicyEnforced(opts: SpawnPolicyOptions): SpawnPolicyResult {
  const { child, untrack } = spawnWithPolicy(opts, opts.stdio ?? 'pipe');
  return { child, untrack };
}

/**
 * Convenience over `spawnPolicyEnforced` for the common agent-runner case
 * where stdin is ignored and stdout/stderr are piped. Returns the precisely
 * typed `ChildProcessByStdio<null, Readable, Readable>` so callers don't
 * have to narrow `child.stdout`/`child.stderr` from `Readable | null`.
 */
export function spawnPolicyPiped(
  opts: Omit<SpawnPolicyOptions, 'stdio'>,
): SpawnPolicyResult<PipedChild> {
  const { child, untrack } = spawnWithPolicy(opts, ['ignore', 'pipe', 'pipe']);
  return { child: child as PipedChild, untrack };
}

export interface ToolingOptions {
  readonly cwd: string;
  /** Subset of GIT_TOOLING_ENV_ALLOWLIST and DEFAULT_SPAWN_ENV_ALLOWLIST to forward. */
  readonly toolingEnv?: readonly string[];
  /**
   * Additional env passthrough names beyond the tooling defaults. Reserved for
   * specific call sites (e.g. `gh` needs `GH_TOKEN`). Caller is responsible
   * for justifying these in code review.
   */
  readonly extraEnv?: readonly string[];
  readonly maxBuffer?: number;
}

const execFileAsyncRaw = promisify(execFile);
const execAsyncRaw = promisify(exec);

/**
 * Run a trusted built-in tool (`git`, `gh`) with a hardened env. Drops the
 * full `process.env` and forwards only:
 *
 *   1. DEFAULT_SPAWN_ENV_ALLOWLIST (PATH, HOME, etc.)
 *   2. GIT_TOOLING_ENV_ALLOWLIST when `toolingEnv` is not explicitly set
 *   3. opts.extraEnv (for e.g. GH_TOKEN on `gh` calls)
 *
 * Sets GIT_CONFIG_NOSYSTEM=1 and GIT_OPTIONAL_LOCKS=0 so a hostile repo
 * cannot poison the spawn via system/global git config or fsmonitor hooks.
 * Use this for every `execFileAsync('git', ...)` site in the codebase.
 */
export async function toolingExecFile(
  command: 'git' | 'gh' | string,
  args: readonly string[],
  opts: ToolingOptions,
): Promise<{ stdout: string; stderr: string }> {
  const env = buildToolingEnv(opts);
  return execFileAsyncRaw(command, [...args], {
    cwd: opts.cwd,
    env,
    maxBuffer: opts.maxBuffer ?? 1 << 20,
    windowsHide: true,
  }) as Promise<{ stdout: string; stderr: string }>;
}

/**
 * Shell-form variant of `toolingExecFile`. Used by the secret scanner and a
 * couple of legacy call sites that pass a command string. Same env hardening.
 */
export async function toolingExec(
  command: string,
  opts: ToolingOptions,
): Promise<{ stdout: string; stderr: string }> {
  const env = buildToolingEnv(opts);
  return execAsyncRaw(command, {
    cwd: opts.cwd,
    env,
    maxBuffer: opts.maxBuffer ?? 1 << 20,
    windowsHide: true,
  }) as Promise<{ stdout: string; stderr: string }>;
}

function buildToolingEnv(opts: ToolingOptions): NodeJS.ProcessEnv {
  const tooling = opts.toolingEnv ?? GIT_TOOLING_ENV_ALLOWLIST;
  const env = buildPolicyEnv(process.env, [...tooling, ...(opts.extraEnv ?? [])]);
  // Force-set the harden flags even if the parent didn't have them. A hostile
  // repo at <cwd>/.git/config sets things like `core.fsmonitor` to an external
  // program; GIT_CONFIG_NOSYSTEM and GIT_OPTIONAL_LOCKS=0 reduce that surface.
  env.GIT_CONFIG_NOSYSTEM = env.GIT_CONFIG_NOSYSTEM ?? '1';
  env.GIT_OPTIONAL_LOCKS = env.GIT_OPTIONAL_LOCKS ?? '0';
  // Terminal prompt MUST be silent: a hostile repo could otherwise cause
  // credential prompts that hang or leak via TTY.
  env.GIT_TERMINAL_PROMPT = env.GIT_TERMINAL_PROMPT ?? '0';
  return env;
}

/**
 * SIGTERM the child's process group (POSIX) or the child itself (Windows),
 * then escalate to SIGKILL after a grace window. Used by every reviewer/agent
 * runner to tear down a spawned child uniformly. Idempotent: calling twice
 * with the same handle is safe — the second call's SIGTERM finds an already-
 * exited PID and the OS no-ops.
 */
export interface KillHandle {
  readonly pid: number;
  readonly detached: boolean;
}

export function killProcessTree(handle: KillHandle, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform === 'win32' || !handle.detached) {
      process.kill(handle.pid, signal);
    } else {
      process.kill(-handle.pid, signal);
    }
  } catch {
    // Already exited or PGID gone; nothing to do.
  }
}

export interface TerminateWithGraceHandle {
  cancel(): void;
}

/**
 * Send SIGTERM now, schedule SIGKILL escalation after `graceMs`. Returns a
 * handle whose `cancel()` clears the kill timer — call when the child exits
 * before the timer fires to avoid SIGKILLing a reused PID on Windows.
 */
export function terminateWithGrace(
  handle: KillHandle,
  graceMs: number = SIGTERM_GRACE_MS,
): TerminateWithGraceHandle {
  let disposed = false;
  killProcessTree(handle, 'SIGTERM');
  const timer = setTimeout(() => {
    if (disposed) return;
    killProcessTree(handle, 'SIGKILL');
  }, graceMs);
  timer.unref();
  return {
    cancel(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export interface TrustGateOptions {
  /**
   * Optional control-repo cwd to consider as a fallback when the primary cwd
   * (typically a worktree) has no explicit grant. Passing both makes a grant
   * on the host repo apply inside its worktrees. Resolved via
   * `controlRepoForWorktree(cwd)` at the caller — keeps trust lookup pure.
   */
  readonly fallbackCwd?: string | undefined;
}

async function grantForGate(cwd: string, opts: TrustGateOptions): Promise<RepoTrustGrant> {
  const candidates = opts.fallbackCwd ? [cwd, opts.fallbackCwd] : [cwd];
  return repoGrantForAny(candidates);
}

/**
 * Convenience for callers that don't already know the control repo. Returns
 * the candidate list with the worktree's host repo appended when the cwd is
 * a worktree checkout. Pure filesystem; no subprocess.
 */
export async function trustCandidatesForCwd(cwd: string): Promise<readonly string[]> {
  const control = await controlRepoForWorktree(cwd);
  return control ? [cwd, control] : [cwd];
}

/**
 * Throws TRUST_DENIED when the repo declares automation checks but the
 * user has not granted `checks_cmd: true` for this repo. Returns silently
 * when no checks command is configured (no-op for projects without one).
 */
export async function assertChecksCmdTrusted(
  automation: Automation,
  cwd: string,
  opts: TrustGateOptions = {},
): Promise<void> {
  if (automation.checksCmd === undefined && automation.checksPhases === undefined) return;
  const grant = await grantForGate(cwd, opts);
  const result = evaluateChecksCmdGrant(automation, grant);
  if (result.allowed) return;
  throw new RepoKernelError(
    'TRUST_DENIED',
    `${result.reason}. Run \`rk trust audit --apply ${shellQuote(cwd)}\` to merge the grants this repo needs (additive — existing grants are preserved), or edit ${trustFilePath()} by hand. See ${docsUrl('TRUST_DENIED')}`,
  );
}

export interface AgentTrustResolution {
  readonly allowedEnv: readonly string[];
  readonly droppedEnv: ReadonlyArray<{ name: string; reason: string }>;
}

/**
 * Throws TRUST_DENIED when the agent name is not granted in user-local trust
 * for this repo. Returns the env passthrough list that survived filtering.
 * Dropped env names are returned for diagnostic logging by the caller.
 */
export async function assertAgentTrusted(
  agentName: string,
  agent: AgentDefinition,
  cwd: string,
  opts: TrustGateOptions = {},
): Promise<AgentTrustResolution> {
  const grant = await grantForGate(cwd, opts);
  const ev = evaluateAgentGrant(agentName, agent, grant);
  if (!ev.allowed) {
    throw new RepoKernelError(
      'TRUST_DENIED',
      `${ev.reason}. Run \`rk trust grant agent ${shellQuote(agentName)}\` to grant just this agent, or \`rk trust audit --apply ${shellQuote(cwd)}\` to merge every grant this repo needs (both are additive). See ${docsUrl('TRUST_DENIED')}`,
    );
  }
  return { allowedEnv: ev.allowedEnv, droppedEnv: ev.droppedEnv };
}

/**
 * Resolves a reviewer id to the user-granted ReviewerGrant (command + args +
 * env_passthrough). Throws TRUST_DENIED when no grant exists for the id.
 */
export async function resolveTrustedReviewer(
  reviewerId: string,
  cwd: string,
  opts: TrustGateOptions = {},
): Promise<ReviewerGrant> {
  const grant = await grantForGate(cwd, opts);
  const result = evaluateReviewerGrant(reviewerId, grant);
  if (!result.allowed) {
    throw new RepoKernelError(
      'TRUST_DENIED',
      `${result.reason}. Run \`rk trust audit --apply ${shellQuote(cwd)}\` to merge the grants this repo needs (additive — existing grants are preserved). See ${docsUrl('TRUST_DENIED')}`,
    );
  }
  return result.reviewer;
}

/**
 * Single-quote a path for safe shell interpolation in human-facing hints.
 * Paths with spaces, dollar signs, or other metacharacters would otherwise
 * break the suggested command when copied into a terminal. POSIX shells only;
 * Windows cmd.exe users get a single-quoted string that is informational, not
 * directly executable.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
