import { resolve } from 'node:path';
import {
  type Config,
  LaneNameSchema,
  loadConfig,
  loadProject,
  RepoKernelError,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { type LaneResolution, resolveHotfixLane } from '../lifecycle/laneResolve.js';
import { shellQuote } from '../security/spawnPolicy.js';
import { synthesizeTaskState } from './fastpath/synthesize.js';
import type { TaskInput } from './fastpath/types.js';
import type { CommandResult } from './validate.js';

export interface HotfixOptions {
  readonly cwd: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly denyPaths: readonly string[];
  /** Repo-relative globs the hotfix may touch. Empty leaves the hotfix unscoped. */
  readonly allowPaths?: readonly string[];
  /**
   * Lane placement: `undefined` → default lane (non-breaking), `"auto"` → first
   * free lane else default, any other value → that named lane.
   */
  readonly lane?: string;
  readonly json: boolean;
}

/**
 * Create a minimal plan entity for an out-of-band fix that does not warrant a
 * full sprint planning cycle.
 *
 * Internally synthesizes a fastpath task (T-NNN) with `kind: hotfix` recorded
 * in the description. The user references the T-NNN id in their commit
 * message and later runs `rk close T-NNN`. No agent run, no review pipeline —
 * the goal is solely to keep git history traceable to plan state for ad-hoc
 * fixes that previously bypassed `rk` entirely (per ADR 49).
 *
 * This is the rk-canonical answer to DomicileVault's 2026-04-28 friction-log
 * entry asking for a path that records ad-hoc bug fixes without forcing a
 * full sprint scaffold.
 */
export async function runHotfixCommand(opts: HotfixOptions): Promise<CommandResult> {
  if (opts.description.trim().length === 0) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: 'rk hotfix: <description> is required\n',
    };
  }

  const cwd = resolve(opts.cwd);

  let cfg: Awaited<ReturnType<typeof loadConfig>>;
  try {
    cfg = await loadConfig({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!cfg.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'repokernel.config.yaml is invalid; run rk validate for details\n',
    };
  }

  // Validate a named lane before it reaches synthesis, where it becomes a
  // `<lane>.md` path under queues/. LaneNameSchema rejects `/`, `\`, `..`, and
  // reserved names, closing a path-traversal hole (e.g. `--lane ../sprints/S-001`).
  if (opts.lane !== undefined && opts.lane !== 'auto') {
    const parsed = LaneNameSchema.safeParse(opts.lane);
    if (!parsed.success) {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr: `rk hotfix: invalid --lane "${opts.lane}": ${parsed.error.issues[0]?.message ?? 'invalid lane name'}\n`,
      };
    }
  }

  const lane = await resolveLaneForHotfix(cfg.cwd, cfg.config, opts.lane);

  const allowPaths = opts.allowPaths ?? [];
  const unscoped = allowPaths.length === 0;

  const body = `[hotfix] ${opts.description.trim()}`;
  const input: TaskInput = {
    body,
    acceptanceCriteria: opts.acceptanceCriteria,
    constraints: opts.denyPaths.map((p) => `denied path: ${p}`),
    allowedPaths: allowPaths,
    source: 'inline',
  };

  let result: Awaited<ReturnType<typeof synthesizeTaskState>>;
  try {
    // Hotfix sprints intentionally skip the review pipeline — pass
    // reviewRequired:false so the synthesize step renders the sprint with
    // the right value on the first write. No post-synthesis mutate.
    result = await synthesizeTaskState(cfg.cwd, cfg.config, input, {
      reviewRequired: false,
      lane: lane.lane,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: `rk hotfix: ${message}\n`,
    };
  }

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({
        taskId: result.taskId,
        epicId: result.epicId,
        sprintId: result.sprintId,
        sprintFile: result.sprintFile,
        epicFile: result.epicFile,
        aliasFile: result.aliasFile,
        lane: lane.lane,
        laneFellBackToDefault: lane.fellBackToDefault,
        unscoped,
        kind: 'hotfix',
      }),
      stderr: '',
    };
  }

  // Single-quote the whole commit message so the suggested command is safe to
  // copy-paste verbatim. rk never executes it, but a description containing
  // `$(...)`, backticks, or quotes would otherwise produce a command that
  // executes or corrupts when pasted (and `next_actions` may be run by tools).
  const commitMessage = `fix: ${opts.description.trim()} (${result.taskId})`;
  const lines = [
    `Created hotfix ${result.taskId}`,
    '',
    `  ${pc.bold('Task')}    ${result.taskId} — ${result.title}`,
    `  ${pc.bold('Sprint')}  ${result.sprintId}`,
    `  ${pc.bold('Epic')}    ${result.epicId}`,
    `  ${pc.bold('Lane')}    ${lane.lane}`,
    '',
    'Updated:',
    `  ${result.epicFile}`,
    `  ${result.sprintFile}`,
    `  ${result.queueFile}`,
    `  ${result.aliasFile}`,
  ];
  if (lane.fellBackToDefault) {
    lines.push(
      '',
      pc.yellow(
        `Note: --lane auto found no free lane; placed on default lane "${lane.lane}" (it may be busy).`,
      ),
    );
  }
  if (unscoped) {
    lines.push(
      '',
      pc.yellow(
        'Warning: hotfix is UNSCOPED — any path may change. Pass --allow <glob> to constrain it.',
      ),
    );
  }
  lines.push(
    '',
    `Next: ${pc.dim(`git commit -m ${shellQuote(commitMessage)} && rk close ${result.taskId}`)}`,
  );
  return {
    exitCode: EXIT_OK,
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
  };
}

/**
 * Resolve the lane for a hotfix. `auto` needs the project graph to find a free
 * lane; named/default placements only need config, so we avoid loading the
 * graph for them. If the graph fails to load for `auto`, degrade to the default
 * lane (flagged) rather than failing the hotfix.
 */
async function resolveLaneForHotfix(
  cwd: string,
  config: Config,
  laneOpt: string | undefined,
): Promise<LaneResolution> {
  if (laneOpt === undefined) {
    return { lane: config.policies.defaultLane, requested: 'default', fellBackToDefault: false };
  }
  if (laneOpt !== 'auto') {
    return { lane: laneOpt, requested: 'named', fellBackToDefault: false };
  }
  const outcome = await loadProject({ cwd }).catch(() => null);
  if (outcome?.ok) {
    return resolveHotfixLane(outcome.graph, config, 'auto');
  }
  return { lane: config.policies.defaultLane, requested: 'auto', fellBackToDefault: true };
}
