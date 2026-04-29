import { resolve } from 'node:path';
import { EPIC_ID_RE, loadProject, RepoKernelError, SPRINT_ID_RE } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import {
  BRIEF_GATES,
  type BriefGate,
  detectSprintGate,
  renderEpicBrief,
  renderSprintBrief,
} from '../lib/briefRenderer.js';
import type { CommandResult } from './validate.js';

export interface BriefCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly gate?: string;
}

function err(message: string, exitCode: number = EXIT_BLOCKED): CommandResult {
  return { exitCode, stdout: '', stderr: `${message}\n` };
}

function isBriefGate(value: string): value is BriefGate {
  return (BRIEF_GATES as readonly string[]).includes(value);
}

export async function runBriefCommand(
  id: string,
  opts: BriefCommandOptions,
): Promise<CommandResult> {
  if (opts.gate !== undefined && !isBriefGate(opts.gate)) {
    return err(`unknown --gate "${opts.gate}" (use ${BRIEF_GATES.join('|')})`, EXIT_USAGE);
  }

  const isSprint = SPRINT_ID_RE.test(id);
  const isEpic = EPIC_ID_RE.test(id);
  if (!isSprint && !isEpic) {
    return err(`unrecognized id "${id}" (use S-NNN or E-NNN)`, EXIT_USAGE);
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

    if (isSprint) {
      const sprint = outcome.graph.sprints.get(id);
      if (!sprint) return err(`sprint not found: ${id}`);

      const epic = outcome.graph.epics.get(sprint.epic_id);
      const review =
        sprint.review_id !== undefined && sprint.review_id !== null
          ? outcome.graph.reviews.get(sprint.review_id)
          : undefined;

      const unmetDeps = sprint.depends_on.filter((depId) => {
        const dep = outcome.graph.sprints.get(depId);
        return !dep || dep.status !== 'shipped';
      });

      const input = { sprint, epic, review, unmetDeps };
      const gate = (opts.gate as BriefGate | undefined) ?? detectSprintGate(input);
      const out = renderSprintBrief(input, gate);

      if (opts.json) {
        const payload = {
          kind: 'sprint' as const,
          id: sprint.id,
          gate,
          title: sprint.title,
          epic_id: sprint.epic_id,
          lane: sprint.lane,
          status: sprint.status,
          unmet_deps: unmetDeps,
          review: review
            ? {
                id: review.id,
                verdict: review.verdict,
                findings_count: review.findings.length,
                panel_aggregate: review.panel_aggregate ?? null,
              }
            : null,
          next_action: out.nextAction,
          markdown: out.markdown,
        };
        return { exitCode: EXIT_OK, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
      }
      return { exitCode: EXIT_OK, stdout: out.markdown, stderr: '' };
    }

    // epic
    const epic = outcome.graph.epics.get(id);
    if (!epic) return err(`epic not found: ${id}`);

    const sprints = epic.sprints
      .map((sid) => outcome.graph.sprints.get(sid))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);

    const nextRunnable = sprints.find((s) => {
      if (s.status !== 'planned' && s.status !== 'pending' && s.status !== 'queued') return false;
      const unmet = s.depends_on.filter((depId) => {
        const dep = outcome.graph.sprints.get(depId);
        return !dep || dep.status !== 'shipped';
      });
      return unmet.length === 0;
    });

    const out = renderEpicBrief({ epic, sprints, nextRunnable });

    if (opts.json) {
      const payload = {
        kind: 'epic' as const,
        id: epic.id,
        title: epic.title,
        status: epic.status,
        progress: {
          shipped: sprints.filter((s) => s.status === 'shipped').length,
          total: sprints.length,
        },
        next_runnable: nextRunnable ? nextRunnable.id : null,
        next_action: out.nextAction,
        markdown: out.markdown,
      };
      return { exitCode: EXIT_OK, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
    }
    return { exitCode: EXIT_OK, stdout: out.markdown, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}
