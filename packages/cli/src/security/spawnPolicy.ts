import {
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  spawn,
} from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  type AgentDefinition,
  type Automation,
  docsUrl,
  evaluateAgentGrant,
  evaluateChecksCmdGrant,
  evaluateReviewerGrant,
  RepoKernelError,
  type RepoTrustGrant,
  type ReviewerGrant,
  repoGrantFor,
  trustFilePath,
} from '@repokernel/core';
import { trackActiveChild } from '../lifecycle/abortHandler.js';

/**
 * Default env names the spawn chokepoint will forward to children. This is
 * the floor — every spawn gets at least these. Trust-granted env_passthrough
 * names are layered on top per call. Anything else from the parent process
 * environment is dropped.
 *
 * Kept here, not in agents/external.ts, because the policy applies to every
 * spawn (checks, agents, reviewers, future use cases), not just agents.
 */
export const DEFAULT_SPAWN_ENV_ALLOWLIST: readonly string[] = [
  // POSIX essentials
  'PATH',
  'HOME',
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

export function buildPolicyEnv(
  parentEnv: NodeJS.ProcessEnv,
  passthrough: readonly string[],
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...DEFAULT_SPAWN_ENV_ALLOWLIST, ...passthrough]);
  const out: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = parentEnv[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

export interface SpawnPolicyOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /** Explicit env passthrough names (from a trust grant). Beyond the default allowlist. */
  readonly envPassthrough?: readonly string[];
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

/**
 * Single chokepoint for spawning child processes. Constructs the env from a
 * trust-checked allowlist (never inherits the full `process.env`), registers
 * the child with the owner's abort handler, and returns the ChildProcess for
 * the caller to wire streams/handlers. shell=true is permitted only when the
 * caller explicitly requests it (and has gone through the trust gate that
 * authorized the command).
 */
export function spawnPolicyEnforced(opts: SpawnPolicyOptions): SpawnPolicyResult {
  const env = buildPolicyEnv(process.env, opts.envPassthrough ?? []);
  const detached = process.platform !== 'win32';
  const child = spawn(opts.command, [...(opts.args ?? [])], {
    cwd: opts.cwd,
    stdio: opts.stdio ?? 'pipe',
    detached,
    env,
    shell: opts.shell ?? false,
  });
  const untrack = child.pid ? trackActiveChild({ pid: child.pid, detached }) : () => {};
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
  const env = buildPolicyEnv(process.env, opts.envPassthrough ?? []);
  const detached = process.platform !== 'win32';
  const child = spawn(opts.command, [...(opts.args ?? [])], {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
    env,
    shell: opts.shell ?? false,
  }) as PipedChild;
  const untrack = child.pid ? trackActiveChild({ pid: child.pid, detached }) : () => {};
  return { child, untrack };
}

/**
 * Throws TRUST_DENIED when the repo declares automation.checksCmd but the
 * user has not granted `checks_cmd: true` for this repo. Returns silently
 * when no checksCmd is configured (no-op for projects without one).
 */
export async function assertChecksCmdTrusted(automation: Automation, cwd: string): Promise<void> {
  if (automation.checksCmd === undefined) return;
  const grant = await repoGrantFor(cwd);
  const result = evaluateChecksCmdGrant(automation, grant);
  if (!result.allowed) {
    throw new RepoKernelError(
      'TRUST_DENIED',
      `${result.reason}. Run \`rk trust audit ${shellQuote(cwd)} > ${shellQuote(trustFilePath())}\` to seed grants, or edit the file by hand. See ${docsUrl('TRUST_DENIED')}`,
    );
  }
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
): Promise<AgentTrustResolution> {
  const grant = await repoGrantFor(cwd);
  const ev = evaluateAgentGrant(agentName, agent, grant);
  if (!ev.allowed) {
    throw new RepoKernelError(
      'TRUST_DENIED',
      `${ev.reason}. Run \`rk trust audit ${shellQuote(cwd)} > ${shellQuote(trustFilePath())}\` to seed grants, or add '${agentName}' to repos.<repo>.agents in ${trustFilePath()}. See ${docsUrl('TRUST_DENIED')}`,
    );
  }
  return { allowedEnv: ev.allowedEnv, droppedEnv: ev.droppedEnv };
}

/**
 * Resolves a reviewer id to the user-granted ReviewerGrant (command + args +
 * env_passthrough). Throws TRUST_DENIED when no grant exists for the id.
 * The reviewer command itself lives in the user-local trust file, not in repo
 * frontmatter, so a repo can declare which reviewer ids it wants but cannot
 * choose the executable.
 */
export async function resolveTrustedReviewer(
  reviewerId: string,
  cwd: string,
): Promise<ReviewerGrant> {
  const grant = await repoGrantFor(cwd);
  const result = evaluateReviewerGrant(reviewerId, grant);
  if (!result.allowed) {
    throw new RepoKernelError('TRUST_DENIED', `${result.reason}. See ${docsUrl('TRUST_DENIED')}`);
  }
  return result.reviewer;
}

// Re-export grant types so callers don't need to depend on core directly.
export type { RepoTrustGrant, ReviewerGrant };

/**
 * Single-quote a path for safe shell interpolation in human-facing hints.
 * Paths with spaces, dollar signs, or other metacharacters would otherwise
 * break the suggested command when copied into a terminal.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
