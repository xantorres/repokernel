import { join, resolve } from 'node:path';
import { type Finding, loadProject, meetsThreshold, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { resolveCommitSha } from '../lifecycle/git.js';
import { mutateSprintFrontmatter } from '../lifecycle/mutate.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import type { CommandResult } from './validate.js';

export interface RebaseSprintOptions {
  readonly cwd: string;
  /** Git ref to realign the recorded base onto. Caller defaults this to HEAD. */
  readonly to: string;
  readonly json: boolean;
}

/**
 * Realign an active sprint's recorded `base_sha` to a git ref (default HEAD).
 *
 * This updates the *recorded* base so diff- and scope-based checks compute
 * against the right starting point after out-of-band commits (e.g. hotfixes)
 * have landed underneath a long-running sprint. It does NOT run a git rebase
 * of any worktree — it only rewrites sprint frontmatter, matching RepoKernel's
 * metadata-only model. The operator (or their tooling) is responsible for the
 * actual git history; `rebase-sprint` keeps the plan state honest about it.
 */
export async function runRebaseSprintCommand(
  id: string,
  opts: RebaseSprintOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return configError();
    }

    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      return err('SPRINT_NOT_FOUND', `sprint ${id} not found`);
    }
    if (sprint.status !== 'active') {
      return err(
        'INVALID_STATUS',
        `cannot rebase ${id}: status is ${sprint.status}, expected active`,
        sprint.status === 'queued' || sprint.status === 'planned'
          ? `rk start ${id} first`
          : `only an active sprint has a base to realign`,
      );
    }

    let newSha: string;
    try {
      newSha = await resolveCommitSha(cwd, opts.to);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err('BAD_REF', message, 'pass a valid git ref (branch, tag, or SHA) to --to');
    }

    const oldSha = sprint.base_sha ?? null;

    if (oldSha === newSha) {
      if (opts.json) {
        return {
          exitCode: EXIT_OK,
          stdout: `${JSON.stringify({ id, base_sha: newSha, ref: opts.to, changed: false })}\n`,
          stderr: '',
        };
      }
      return {
        exitCode: EXIT_OK,
        stdout: `${id} base_sha already at ${newSha.slice(0, 7)} (${opts.to}) — nothing to do\n`,
        stderr: '',
      };
    }

    let findings: readonly Finding[] = [];
    await withLifecycleScope(
      { cwd, command: 'rebase-sprint', args: { sprintId: id, to: newSha } },
      async (tx) => {
        await tx.lockedMutate(`sprint-${id}`, () =>
          mutateSprintFrontmatter(join(cwd, sprint.file), { base_sha: newSha }),
        );
        ({ findings } = await tx.refreshRegistry());
      },
    );

    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    if (opts.json) {
      return {
        exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
        stdout: `${JSON.stringify({
          id,
          base_sha: newSha,
          previous_base_sha: oldSha,
          ref: opts.to,
          changed: true,
          findingCount: blocking.length,
        })}\n`,
        stderr: '',
      };
    }

    const out = [
      `Rebased ${id} base onto ${opts.to}`,
      '',
      `  ${pc.bold('Sprint')}   ${id} — ${sprint.title}`,
      `  ${pc.bold('Base')}     ${oldSha ? `${oldSha.slice(0, 7)} → ` : ''}${newSha.slice(0, 7)}`,
      '',
      pc.dim('Recorded base only — no git rebase was performed.'),
    ];
    if (blocking.length > 0) {
      out.push('', pc.yellow(`Warning: ${blocking.length} finding(s) — run rk validate`));
    }
    return {
      exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
      stdout: `${out.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}

function err(_code: string, message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `${lines.join('\n')}\n` };
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}
