import { dirname, resolve } from 'node:path';
import { loadProject, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson, jsonOk } from '../format/json.js';
import { resolveHotfixLane } from '../lifecycle/laneResolve.js';
import { shellQuote } from '../security/spawnPolicy.js';
import { synthesizeTaskState } from './fastpath/synthesize.js';
import type { TaskInput } from './fastpath/types.js';
import type { CommandResult } from './validate.js';

export interface ForkHotfixOptions {
  readonly cwd: string;
  readonly parentId: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly allowPaths?: readonly string[];
  readonly denyPaths: readonly string[];
  readonly json: boolean;
}

/**
 * Spin a hotfix off an active sprint without disturbing it.
 *
 * Common in test/E2E epics: a bug surfaces that needs product code the parent
 * sprint isn't scoped for. Rather than smear the fix across the wrong sprint,
 * `fork-hotfix-from` synthesizes a review-skipping hotfix that:
 *   - lands on a FREE lane (so it never contends with the parent for a lane),
 *   - inherits the parent's `allowed_paths` scope (overridable via --allow),
 *   - records `forked_from` / `parent_base_sha` for audit.
 *
 * It deliberately does NOT touch the parent: no blocking, no auto-resume. It
 * prints the exact follow-up commands instead — close the hotfix, then
 * `rk rebase-sprint <parent> --to HEAD` so the parent's recorded base picks up
 * the landed fix.
 */
export async function runForkHotfixCommand(opts: ForkHotfixOptions): Promise<CommandResult> {
  if (opts.description.trim().length === 0) {
    return {
      exitCode: EXIT_BLOCKED,
      stdout: '',
      stderr: 'rk fork-hotfix-from: <reason> is required\n',
    };
  }

  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
      };
    }

    const parent = outcome.graph.sprints.get(opts.parentId);
    if (!parent) {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr: `error: parent sprint ${opts.parentId} not found\n`,
      };
    }
    // The whole point is to fork off work in flight: the parent must be active.
    // A non-active parent has a stale or null base_sha, and the printed
    // `rk rebase-sprint <parent> --to HEAD` follow-up would fail (rebase
    // requires an active sprint).
    if (parent.status !== 'active') {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr:
          `error: cannot fork from ${opts.parentId}: status is ${parent.status}, expected active\n` +
          `  → fork-hotfix-from forks off a running sprint; start the parent first or use rk hotfix\n`,
      };
    }

    const projectRoot = dirname(outcome.configPath);
    const lane = resolveHotfixLane(outcome.graph, outcome.config, 'auto');

    // Scope the fork to the parent's surface unless the caller narrows it.
    const allowPaths =
      opts.allowPaths && opts.allowPaths.length > 0 ? opts.allowPaths : [...parent.allowed_paths];
    const unscoped = allowPaths.length === 0;

    const reason = opts.description.trim();
    const body = `[hotfix] ${reason} (forked from ${opts.parentId})`;
    const input: TaskInput = {
      body,
      acceptanceCriteria: opts.acceptanceCriteria,
      constraints: opts.denyPaths.map((p) => `denied path: ${p}`),
      allowedPaths: allowPaths,
      source: 'inline',
    };

    const result = await synthesizeTaskState(projectRoot, outcome.config, input, {
      reviewRequired: false,
      lane: lane.lane,
      extraExtras: { forked_from: opts.parentId, parent_base_sha: parent.base_sha ?? null },
    });

    const closeCommand = `git commit -m ${shellQuote(`fix: ${reason} (${result.taskId})`)} && rk close ${result.taskId}`;
    const realignCommand = `rk rebase-sprint ${opts.parentId} --to HEAD`;
    const nextActions = [closeCommand, realignCommand];

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: emitJson(
          jsonOk(
            {
              taskId: result.taskId,
              sprintId: result.sprintId,
              epicId: result.epicId,
              sprintFile: result.sprintFile,
              lane: lane.lane,
              laneFellBackToDefault: lane.fellBackToDefault,
              forkedFrom: opts.parentId,
              parentBaseSha: parent.base_sha ?? null,
              unscoped,
              kind: 'fork-hotfix',
            },
            { nextActions },
          ),
        ),
        stderr: '',
      };
    }

    const lines = [
      `Forked hotfix ${result.taskId} from ${opts.parentId}`,
      '',
      `  ${pc.bold('Task')}    ${result.taskId} — ${result.title}`,
      `  ${pc.bold('Sprint')}  ${result.sprintId}`,
      `  ${pc.bold('Epic')}    ${result.epicId}`,
      `  ${pc.bold('Lane')}    ${lane.lane}`,
      `  ${pc.bold('Scope')}   ${unscoped ? '(unscoped)' : allowPaths.join(', ')}`,
    ];
    if (lane.fellBackToDefault) {
      lines.push(
        '',
        pc.yellow(
          `Note: no free lane available; placed on default lane "${lane.lane}" (it may contend with the parent).`,
        ),
      );
    }
    if (unscoped) {
      lines.push(
        '',
        pc.yellow(
          'Warning: parent had no allowed_paths, so this hotfix is UNSCOPED. Pass --allow <glob> to constrain it.',
        ),
      );
    }
    lines.push(
      '',
      'Next:',
      `  1. ${pc.dim(closeCommand)}`,
      `  2. ${pc.dim(realignCommand)}  (realign ${opts.parentId} onto the landed fix)`,
    );
    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `rk fork-hotfix-from: ${message}\n` };
  }
}
