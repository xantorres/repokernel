import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  clearTrustCache,
  EMPTY_REPO_GRANT,
  evaluateRepo,
  type LoadConfigResult,
  loadConfig,
  loadProject,
  loadUserTrust,
  RepoKernelError,
  type RepoTrustGrant,
  RepoTrustGrantSchema,
  repoGrantFor,
  summarizeRepoRequests,
  summarizeReviewerRequests,
  type TrustScope,
  trustFilePath,
  UserLocalTrustSchema,
} from '@repokernel/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { shellQuote } from '../security/spawnPolicy.js';
import type { CommandResult } from './validate.js';

export interface TrustListOptions {
  readonly json: boolean;
}

export async function runTrustListCommand(opts: TrustListOptions): Promise<CommandResult> {
  const trust = await loadUserTrust();
  if (opts.json) {
    return { exitCode: EXIT_OK, stdout: `${JSON.stringify(trust, null, 2)}\n`, stderr: '' };
  }
  const repos = Object.entries(trust.repos);
  if (repos.length === 0) {
    return {
      exitCode: EXIT_OK,
      stdout: `no trust grants at ${trustFilePath()}\n`,
      stderr: '',
    };
  }
  const lines = [`trust file: ${trustFilePath()}`, ''];
  for (const [path, grant] of repos) {
    lines.push(`${path}:`);
    lines.push(`  checks_cmd:       ${grant.checks_cmd}`);
    lines.push(
      `  env_passthrough:  ${grant.env_passthrough.length === 0 ? '(none)' : grant.env_passthrough.join(', ')}`,
    );
    lines.push(
      `  agents:           ${grant.agents.length === 0 ? '(none)' : grant.agents.join(', ')}`,
    );
    const reviewerIds = Object.keys(grant.reviewers);
    lines.push(
      `  reviewers:        ${reviewerIds.length === 0 ? '(none)' : reviewerIds.join(', ')}`,
    );
    lines.push('');
  }
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

export interface TrustAuditOptions {
  readonly cwd: string;
  readonly apply: boolean;
  readonly json: boolean;
}

/**
 * Read the target repo's `repokernel.config.yaml` plus every epic's
 * frontmatter and emit the trust YAML fragment needed to reproduce current
 * runtime behavior. Pure stdout when --apply is absent. With --apply, merges
 * the fragment into the user-local trust file.
 *
 * The emitted grant deliberately surfaces ALL privileged actions the repo
 * declares — even sensitive env-var passthroughs — so the user can review
 * before consenting. The decision of what to grant stays with the user.
 * Reviewer ids are listed separately as a "manual completion" note because
 * the user-local trust file owns the executable for each reviewer id (the
 * audit cannot fill in command/args/env_passthrough without user input).
 */
export async function runTrustAuditCommand(opts: TrustAuditOptions): Promise<CommandResult> {
  const projectCwd = resolve(opts.cwd);
  const load = await loadConfig({ cwd: projectCwd });
  if (!load.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `cannot audit ${projectCwd}: config invalid (${load.finding.message})\n`,
    };
  }

  const canonical = await realpath(load.cwd);
  const configRequests = summarizeRepoRequests(load.config);

  const passthrough = new Set<string>();
  const agents = new Set<string>();
  let wantChecks = false;

  for (const r of configRequests) {
    if (r.scope === 'checks_cmd') wantChecks = true;
    if (r.scope === 'agent' && r.key) agents.add(r.key);
    if (r.scope === 'env_passthrough' && r.key) passthrough.add(r.key);
  }

  const stubReviewerIds = new Set<string>();
  try {
    const project = await loadProject({ cwd: projectCwd });
    if (project.ok) {
      for (const req of summarizeReviewerRequests(project.parsed.epics)) {
        if (req.key) stubReviewerIds.add(req.key);
      }
    }
  } catch {
    // loadProject failure during audit is non-fatal: emit what we have from
    // the config alone and let the user run audit again after fixing project
    // state.
  }

  const grantToWrite: RepoTrustGrant = {
    checks_cmd: wantChecks,
    env_passthrough: [...passthrough].sort(),
    agents: [...agents].sort(),
    reviewers: {},
  };
  const reviewerIdsNeedingGrants = [...stubReviewerIds].sort();

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify({ repo: canonical, requests: configRequests, grant: grantToWrite, reviewer_ids_needing_grants: reviewerIdsNeedingGrants }, null, 2)}\n`,
      stderr: '',
    };
  }

  const fragment = {
    version: 1 as const,
    repos: { [canonical]: grantToWrite },
  };
  const yaml = stringifyYaml(fragment);
  const reviewerNote =
    reviewerIdsNeedingGrants.length > 0
      ? `\n# Reviewer IDs declared in epic frontmatter but not granted: ${reviewerIdsNeedingGrants.join(', ')}\n# Add each as repos.<repo>.reviewers.<id> with { command, args, env_passthrough, timeout_seconds } before \`rk review\`.\n`
      : '';

  if (!opts.apply) {
    return {
      exitCode: EXIT_OK,
      stdout: `${yaml}${reviewerNote}\n# pipe this into ${trustFilePath()} (or run with --apply)\n`,
      stderr: '',
    };
  }

  const path = trustFilePath();
  await mkdir(dirname(path), { recursive: true });
  let merged: Record<string, unknown> = { version: 1, repos: {} };
  try {
    const text = await readFile(path, 'utf8');
    const parsed = parseYaml(text, { strict: true, maxAliasCount: 100 });
    if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
    if (!merged.repos || typeof merged.repos !== 'object') merged.repos = {};
  } catch {
    /* fresh file is fine */
  }
  (merged.repos as Record<string, unknown>)[canonical] = grantToWrite;
  // Validate before write so we never persist a malformed trust file.
  UserLocalTrustSchema.parse(merged);
  await writeFile(path, stringifyYaml(merged), 'utf8');
  clearTrustCache();
  const reviewerStderr =
    reviewerIdsNeedingGrants.length > 0
      ? `note: ${reviewerIdsNeedingGrants.length} reviewer id(s) declared in epic frontmatter still need manual grants in ${path}: ${reviewerIdsNeedingGrants.join(', ')}\n`
      : '';
  return {
    exitCode: EXIT_OK,
    stdout: `trust grants for ${canonical} written to ${path}\n`,
    stderr: reviewerStderr,
  };
}

export interface TrustCheckOptions {
  readonly cwd: string;
  readonly json: boolean;
}

/**
 * Non-mutating: exit 0 if the current cwd has all needed grants (including
 * reviewer ids declared in epic frontmatter), exit `EXIT_FINDINGS` with a
 * one-line hint otherwise. Designed for the plugin's `session-start.sh` hook
 * so trust gaps surface at session boot, not mid-task.
 */
export async function runTrustCheckCommand(opts: TrustCheckOptions): Promise<CommandResult> {
  const projectCwd = resolve(opts.cwd);
  let load: LoadConfigResult;
  try {
    load = await loadConfig({ cwd: projectCwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError && cause.kind === 'CONFIG_FILE_NOT_FOUND') {
      // Not a repokernel project — nothing to check.
      return { exitCode: EXIT_OK, stdout: '', stderr: '' };
    }
    throw cause;
  }
  if (!load.ok) {
    return { exitCode: EXIT_OK, stdout: '', stderr: '' };
  }

  const grant = await repoGrantFor(load.cwd);
  let epics: Awaited<ReturnType<typeof loadProject>> | undefined;
  try {
    epics = await loadProject({ cwd: load.cwd });
  } catch {
    epics = undefined;
  }
  const evaluation = evaluateRepo(load.config, grant, {
    epics: epics?.ok ? epics.parsed.epics : undefined,
  });

  if (opts.json) {
    return {
      exitCode: evaluation.violations.length === 0 ? EXIT_OK : EXIT_FINDINGS,
      stdout: `${JSON.stringify(evaluation, null, 2)}\n`,
      stderr: '',
    };
  }

  if (evaluation.violations.length === 0) {
    return { exitCode: EXIT_OK, stdout: '', stderr: '' };
  }

  const hint = `repokernel: trust grants missing — run \`rk trust audit ${shellQuote(load.cwd)} > ${shellQuote(trustFilePath())}\` before any rk command`;
  return { exitCode: EXIT_FINDINGS, stdout: '', stderr: `${hint}\n` };
}

export type TrustScopeArg = Exclude<TrustScope, 'reviewer'>;

export interface TrustGrantOptions {
  readonly cwd: string;
  readonly scope: TrustScopeArg;
  readonly key?: string;
}

function sortedSetAdd(arr: readonly string[], value: string): string[] {
  const next = new Set(arr);
  next.add(value);
  return [...next].sort();
}

function setRemove(arr: readonly string[], value: string): string[] {
  return arr.filter((v) => v !== value);
}

export async function runTrustGrantCommand(opts: TrustGrantOptions): Promise<CommandResult> {
  if ((opts.scope === 'agent' || opts.scope === 'env_passthrough') && !opts.key) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: `scope '${opts.scope}' requires a key (e.g., 'rk trust grant ${opts.scope} <name>')\n`,
    };
  }
  return applyTrustGrant(opts.cwd, (grant) => {
    switch (opts.scope) {
      case 'checks_cmd':
        return { ...grant, checks_cmd: true };
      case 'agent':
        return { ...grant, agents: sortedSetAdd(grant.agents, opts.key!) };
      case 'env_passthrough':
        return { ...grant, env_passthrough: sortedSetAdd(grant.env_passthrough, opts.key!) };
    }
  });
}

export async function runTrustRevokeCommand(opts: TrustGrantOptions): Promise<CommandResult> {
  if ((opts.scope === 'agent' || opts.scope === 'env_passthrough') && !opts.key) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: `scope '${opts.scope}' requires a key (e.g., 'rk trust revoke ${opts.scope} <name>')\n`,
    };
  }
  return applyTrustGrant(opts.cwd, (grant) => {
    switch (opts.scope) {
      case 'checks_cmd':
        return { ...grant, checks_cmd: false };
      case 'agent':
        return { ...grant, agents: setRemove(grant.agents, opts.key!) };
      case 'env_passthrough':
        return { ...grant, env_passthrough: setRemove(grant.env_passthrough, opts.key!) };
    }
  });
}

/**
 * Read the user-local trust file, apply `mutator` to the per-repo grant
 * (creating a fresh empty grant when the file has no entry for this repo),
 * validate the resulting whole-file shape, and write it back. Pure functional
 * with respect to the in-memory grant — the on-disk write happens once at the
 * end, never partially.
 */
async function applyTrustGrant(
  cwd: string,
  mutator: (grant: RepoTrustGrant) => RepoTrustGrant,
): Promise<CommandResult> {
  const projectCwd = resolve(cwd);
  const canonical = await realpath(projectCwd).catch(() => projectCwd);
  const path = trustFilePath();
  await mkdir(dirname(path), { recursive: true });
  let raw: Record<string, unknown> = { version: 1, repos: {} };
  try {
    const text = await readFile(path, 'utf8');
    const parsed = parseYaml(text, { strict: true, maxAliasCount: 100 });
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    if (!raw.repos || typeof raw.repos !== 'object') raw.repos = {};
  } catch {
    /* fresh file */
  }
  const repos = raw.repos as Record<string, unknown>;
  // Validate the existing per-repo entry before passing to the mutator so a
  // hand-edited or corrupt trust file fails loudly here instead of producing
  // a malformed grant that only fails the schema check on write-back.
  const existing = Object.hasOwn(repos, canonical)
    ? RepoTrustGrantSchema.parse(repos[canonical])
    : EMPTY_REPO_GRANT;
  const next = mutator(existing);
  repos[canonical] = next;
  UserLocalTrustSchema.parse(raw);
  await writeFile(path, stringifyYaml(raw), 'utf8');
  clearTrustCache();
  return {
    exitCode: EXIT_OK,
    stdout: `updated trust for ${canonical} in ${path}\n`,
    stderr: '',
  };
}
