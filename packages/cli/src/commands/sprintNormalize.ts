import { join, resolve } from 'node:path';
import { loadProject, RepoKernelError, SPRINT_ID_RE } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { mutateSprintFrontmatter } from '../lifecycle/mutate.js';
import {
  inferredTestPathsForAllowedPath,
  normalizeGeneratedPathsForSprint,
} from '../lifecycle/pathPolicy.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import { runCreateReviewCommand } from './create.js';
import type { CommandResult } from './validate.js';

export interface SprintNormalizeOptions {
  readonly cwd: string;
  readonly target?: string;
  readonly all?: boolean;
  readonly write?: boolean;
  readonly json?: boolean;
}

interface NormalizeItem {
  readonly sprint_id: string;
  readonly file: string;
  readonly changed: boolean;
  readonly review_needed: boolean;
  readonly review_created: string | null;
  readonly allowed_paths_added: readonly string[];
  readonly generated_paths_added: readonly string[];
  readonly generated_paths_removed: readonly string[];
}

export async function runSprintNormalizeCommand(
  opts: SprintNormalizeOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  if (opts.all !== true && opts.target === undefined) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr: 'rk sprint normalize requires <S-NNN> or --all\n',
    };
  }
  if (opts.target !== undefined && !SPRINT_ID_RE.test(opts.target)) {
    return { exitCode: EXIT_USAGE, stdout: '', stderr: `invalid sprint id: ${opts.target}\n` };
  }

  try {
    let outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();
    const ids =
      opts.all === true
        ? [...outcome.graph.sprints.keys()].sort()
        : opts.target !== undefined
          ? [opts.target]
          : [];
    const missing = ids.find((id) => !outcome.ok || !outcome.graph.sprints.has(id));
    if (missing)
      return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `sprint not found: ${missing}\n` };

    const items: NormalizeItem[] = [];
    for (const id of ids) {
      outcome = await loadProject({ cwd });
      if (!outcome.ok) return configError();
      let sprint = outcome.graph.sprints.get(id);
      if (!sprint) continue;
      let reviewCreated: string | null = null;
      const reviewNeeded = sprint.review_required && !sprint.review_id;
      if (opts.write === true && sprint.review_required && !sprint.review_id) {
        const created = await runCreateReviewCommand({
          cwd,
          sprint: sprint.id,
          json: true,
        });
        if (created.exitCode !== 0) return created;
        const payload = JSON.parse(created.stdout) as { id?: string };
        reviewCreated = payload.id ?? null;
        outcome = await loadProject({ cwd });
        if (!outcome.ok) return configError();
        sprint = outcome.graph.sprints.get(id);
        if (!sprint) continue;
      }

      const desiredAllowed = uniq([
        ...sprint.allowed_paths,
        ...sprint.allowed_paths.flatMap(inferredTestPathsForAllowedPath),
      ]);
      const generated = normalizeGeneratedPathsForSprint({ config: outcome.config, sprint });
      const allowedAdded = desiredAllowed.filter((path) => !sprint.allowed_paths.includes(path));
      const generatedAdded = generated.filter((path) => !sprint.generated_paths.includes(path));
      const generatedRemoved = sprint.generated_paths.filter((path) => !generated.includes(path));
      const changed =
        allowedAdded.length > 0 ||
        generatedAdded.length > 0 ||
        generatedRemoved.length > 0 ||
        reviewNeeded;
      if (
        opts.write === true &&
        (allowedAdded.length > 0 || generatedAdded.length > 0 || generatedRemoved.length > 0)
      ) {
        await withLifecycleScope(
          { cwd, command: 'sprint-normalize', args: { sprintId: sprint.id } },
          async (tx) => {
            await mutateSprintFrontmatter(join(cwd, sprint.file), {
              allowed_paths: desiredAllowed,
              generated_paths: generated,
            });
            await tx.refreshRegistry();
          },
        );
      }
      items.push({
        sprint_id: sprint.id,
        file: sprint.file,
        changed,
        review_needed: reviewNeeded,
        review_created: reviewCreated,
        allowed_paths_added: allowedAdded,
        generated_paths_added: generatedAdded,
        generated_paths_removed: generatedRemoved,
      });
    }

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: emitJson({ write: opts.write === true, items }),
        stderr: '',
      };
    }
    const lines = [`Sprint normalize ${opts.write === true ? 'write' : 'preview'}`, ''];
    for (const item of items) {
      lines.push(`${item.changed ? 'changed' : 'ok'} ${item.sprint_id}`);
      for (const path of item.allowed_paths_added) lines.push(`  allowed + ${path}`);
      for (const path of item.generated_paths_added) lines.push(`  generated + ${path}`);
      for (const path of item.generated_paths_removed) lines.push(`  generated - ${path}`);
      if (item.review_needed && !item.review_created) lines.push('  review needed');
      if (item.review_created) lines.push(`  review + ${item.review_created}`);
    }
    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}
