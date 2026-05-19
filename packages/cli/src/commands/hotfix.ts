import { resolve } from 'node:path';
import { loadConfig, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { synthesizeTaskState } from './fastpath/synthesize.js';
import type { TaskInput } from './fastpath/types.js';
import type { CommandResult } from './validate.js';

export interface HotfixOptions {
  readonly cwd: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly denyPaths: readonly string[];
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

  const body = `[hotfix] ${opts.description.trim()}`;
  const input: TaskInput = {
    body,
    acceptanceCriteria: opts.acceptanceCriteria,
    constraints: opts.denyPaths.map((p) => `denied path: ${p}`),
    source: 'inline',
  };

  let result: Awaited<ReturnType<typeof synthesizeTaskState>>;
  try {
    // Hotfix sprints intentionally skip the review pipeline — pass
    // reviewRequired:false so the synthesize step renders the sprint with
    // the right value on the first write. No post-synthesis mutate.
    result = await synthesizeTaskState(cfg.cwd, cfg.config, input, { reviewRequired: false });
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
        kind: 'hotfix',
      }),
      stderr: '',
    };
  }

  // Escape any `"` in the user-supplied description so the suggested
  // shell command is safe to copy-paste verbatim. We never execute it
  // — it's a hint string — but a leaky `"` would leave the user with a
  // malformed git command.
  const safeDescription = opts.description.trim().replaceAll('"', '\\"');
  const lines = [
    `Created hotfix ${result.taskId}`,
    '',
    `  ${pc.bold('Task')}    ${result.taskId} — ${result.title}`,
    `  ${pc.bold('Sprint')}  ${result.sprintId}`,
    `  ${pc.bold('Epic')}    ${result.epicId}`,
    '',
    'Updated:',
    `  ${result.epicFile}`,
    `  ${result.sprintFile}`,
    `  ${result.queueFile}`,
    `  ${result.aliasFile}`,
    '',
    `Next: ${pc.dim(`git commit -m "fix: ${safeDescription} (${result.taskId})" && rk close ${result.taskId}`)}`,
  ];
  return {
    exitCode: EXIT_OK,
    stdout: `${lines.join('\n')}\n`,
    stderr: '',
  };
}
