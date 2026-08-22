import { type Config, loadConfig, RepoKernelError, toErrorMessage } from '@repokernel/core';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import {
  deleteMergedBranch,
  listMergedSweepableBranches,
  type SweepableBranch,
} from '../lifecycle/worktree.js';
import type { CommandResult } from './validate.js';

export interface WorktreeSweepOptions {
  readonly cwd: string;
  readonly preview: boolean;
  readonly apply: boolean;
  readonly json: boolean;
}

interface SweepFailure {
  readonly branch: string;
  readonly reason: string;
}

interface SweepOutcome {
  readonly deleted: readonly SweepableBranch[];
  readonly failed: readonly SweepFailure[];
}

type ConfigLoad = { readonly config: Config } | { readonly error: CommandResult };

const NOTHING_TO_SWEEP = 'no merged worktree branches to sweep';

function runtimeError(message: string): CommandResult {
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${message}\n` };
}

function rejectedMode(opts: WorktreeSweepOptions): CommandResult | null {
  if (opts.preview && opts.apply) {
    return runtimeError('--preview and --apply are mutually exclusive');
  }
  if (!opts.preview && !opts.apply) {
    return runtimeError('specify --preview to list sweepable branches or --apply to delete them');
  }
  return null;
}

/**
 * loadConfig reports a missing file by throwing and an unparseable one by
 * returning ok:false, so both shapes need handling.
 */
async function resolveConfig(cwd: string): Promise<ConfigLoad> {
  try {
    const loaded = await loadConfig({ cwd });
    if (!loaded.ok) {
      return { error: runtimeError(`repokernel.config.yaml invalid (${loaded.finding.message})`) };
    }
    return { config: loaded.config };
  } catch (cause) {
    if (cause instanceof RepoKernelError && cause.kind === 'CONFIG_FILE_NOT_FOUND') {
      return { error: runtimeError('repokernel.config.yaml not found; run rk init first') };
    }
    return { error: runtimeError(toErrorMessage(cause)) };
  }
}

function renderPreview(candidates: readonly SweepableBranch[], json: boolean): CommandResult {
  if (json) {
    const stdout = `${JSON.stringify({ branches: candidates }, null, 2)}\n`;
    return { exitCode: EXIT_OK, stdout, stderr: '' };
  }
  if (candidates.length === 0) {
    return { exitCode: EXIT_OK, stdout: `${NOTHING_TO_SWEEP}\n`, stderr: '' };
  }
  const lines = [
    `${candidates.length} merged worktree branch(es) with no worktree:`,
    '',
    ...candidates.map((c) => `  ${c.branch}  ${c.head.slice(0, 8)}`),
    '',
    'run `rk worktree sweep --apply` to delete them',
  ];
  return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

async function applySweep(
  candidates: readonly SweepableBranch[],
  config: Config,
  cwd: string,
): Promise<SweepOutcome> {
  const deleted: SweepableBranch[] = [];
  const failed: SweepFailure[] = [];
  for (const candidate of candidates) {
    try {
      await deleteMergedBranch(candidate.branch, config, cwd);
      deleted.push(candidate);
    } catch (cause) {
      failed.push({ branch: candidate.branch, reason: toErrorMessage(cause) });
    }
  }
  return { deleted, failed };
}

function renderApply(outcome: SweepOutcome, json: boolean): CommandResult {
  const exitCode = outcome.failed.length > 0 ? EXIT_RUNTIME : EXIT_OK;
  if (json) {
    return { exitCode, stdout: `${JSON.stringify(outcome, null, 2)}\n`, stderr: '' };
  }
  // Print the SHA in full: it is the only way back to a branch deleted by
  // mistake, and an abbreviation can go ambiguous in a large or old repo.
  const lines = outcome.deleted.map((d) => `deleted ${d.branch} (was ${d.head})`);
  if (lines.length === 0 && outcome.failed.length === 0) lines.push(NOTHING_TO_SWEEP);
  const stderr = outcome.failed.map((f) => `failed ${f.branch}: ${f.reason}`).join('\n');
  return {
    exitCode,
    stdout: `${lines.join('\n')}\n`,
    stderr: stderr ? `${stderr}\n` : '',
  };
}

/**
 * Collect and optionally delete worktree branches that outlived their worktree.
 *
 * Scope is branches only. Leaked worktree directories are already `rk fix`'s
 * job, and duplicating that here would give two commands the power to remove
 * the same directory under different safety rules.
 */
export async function runWorktreeSweepCommand(opts: WorktreeSweepOptions): Promise<CommandResult> {
  const badMode = rejectedMode(opts);
  if (badMode) return badMode;

  const loaded = await resolveConfig(opts.cwd);
  if ('error' in loaded) return loaded.error;

  let candidates: SweepableBranch[];
  try {
    candidates = await listMergedSweepableBranches(loaded.config, opts.cwd);
  } catch (cause) {
    return runtimeError(toErrorMessage(cause));
  }

  if (opts.preview) return renderPreview(candidates, opts.json);
  return renderApply(await applySweep(candidates, loaded.config, opts.cwd), opts.json);
}
