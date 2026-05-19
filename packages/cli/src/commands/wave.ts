import { join, resolve } from 'node:path';
import {
  buildSatisfiedSprints,
  EPIC_ID_RE,
  loadProject,
  RepoKernelError,
  type Sprint,
  unmetDependencies,
} from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { mutateSprintFrontmatter } from '../lifecycle/mutate.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import { appendSlotToQueue } from './queue.js';
import type { CommandResult } from './validate.js';

export interface WaveCommandOptions {
  readonly cwd: string;
  readonly apply: boolean;
  readonly createSprint: boolean;
  readonly enqueue: boolean;
  readonly json: boolean;
}

interface WaveEpicPreview {
  readonly epicId: string;
  readonly planned: readonly string[];
  readonly queued: readonly string[];
  readonly blocked: ReadonlyArray<{ sprintId: string; reason: string }>;
  readonly applied: readonly string[];
}

interface QueueCandidate {
  readonly sprintId: string;
  readonly lane: string;
}

const MAX_SELECTOR_EPICS = 200;

export async function runWaveCommand(
  selector: string,
  opts: WaveCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  if (opts.createSprint) {
    return {
      exitCode: EXIT_USAGE,
      stdout: '',
      stderr:
        'rk wave --create-sprint is not supported yet; run rk plan <E-NNN> --create-sprint first\n',
    };
  }
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();
    const parsedSelector = expandEpicSelector(selector);
    if (!parsedSelector.ok) {
      return { exitCode: EXIT_USAGE, stdout: '', stderr: `${parsedSelector.message}\n` };
    }
    const epicIds = [...new Set(parsedSelector.value)];
    if (epicIds.length === 0) {
      return {
        exitCode: EXIT_USAGE,
        stdout: '',
        stderr: 'wave selector did not include any epics\n',
      };
    }

    const previews: WaveEpicPreview[] = [];
    const queueCandidates: QueueCandidate[] = [];
    const satisfied = buildSatisfiedSprints(outcome.graph.sprints.values());
    for (const epicId of epicIds) {
      const epic = outcome.graph.epics.get(epicId);
      if (!epic) {
        return { exitCode: EXIT_BLOCKED, stdout: '', stderr: `epic not found: ${epicId}\n` };
      }
      const sprints = (outcome.graph.sprintsByEpic.get(epicId) ?? [])
        .map((id) => outcome.graph.sprints.get(id))
        .filter((s): s is Sprint => Boolean(s));
      const planned = sprints.filter((s) => s.status === 'planned' || s.status === 'pending');
      const queued = sprints.filter((s) => s.status === 'queued');
      const depBlocked = planned
        .map((s) => ({ sprint: s, unmet: unmetDependencies(s, satisfied) }))
        .filter((x) => x.unmet.length > 0)
        .map((x) => ({ sprintId: x.sprint.id, reason: dependencyBlockReason(x.sprint, x.unmet) }));
      const gateBlocked = planned
        .filter((s) => s.gate)
        .map((s) => ({ sprintId: s.id, reason: `blocked by gate ${s.gate}` }));
      const pendingBlocked = planned
        .filter((s) => s.status === 'pending')
        .map((s) => ({
          sprintId: s.id,
          reason: 'status pending requires an explicit rk queue add --force',
        }));
      const blocked = [...depBlocked, ...gateBlocked, ...pendingBlocked];

      const eligible = planned.filter(
        (s) => s.status === 'planned' && !s.gate && unmetDependencies(s, satisfied).length === 0,
      );
      if (opts.apply && opts.enqueue && pendingBlocked.length > 0) {
        return {
          exitCode: EXIT_BLOCKED,
          stdout: '',
          stderr: `cannot apply wave: ${pendingBlocked.map((b) => `${b.sprintId} is pending`).join(', ')}\n`,
        };
      }
      for (const sprint of eligible) {
        queueCandidates.push({ sprintId: sprint.id, lane: sprint.lane });
      }
      previews.push({
        epicId,
        planned: planned.map((s) => s.id),
        queued: queued.map((s) => s.id),
        blocked,
        applied: [],
      });
    }

    if (opts.apply && opts.enqueue) {
      const missingLane = queueCandidates.find(
        (candidate) => !outcome.parsed.queues.some((q) => q.lane === candidate.lane),
      );
      if (missingLane) {
        return {
          exitCode: EXIT_BLOCKED,
          stdout: '',
          stderr: `cannot apply wave: no queue file found for lane "${missingLane.lane}"\n`,
        };
      }
      const staleQueued = queueCandidates.find((candidate) =>
        outcome.parsed.queues.some((queue) =>
          queue.slots.some((slot) => slot.sprint_id === candidate.sprintId),
        ),
      );
      if (staleQueued) {
        return {
          exitCode: EXIT_BLOCKED,
          stdout: '',
          stderr: `cannot apply wave: ${staleQueued.sprintId} is already present in a queue\n`,
        };
      }

      if (queueCandidates.length > 0) {
        await withLifecycleScope(
          { cwd, command: 'wave', args: { selector, enqueue: true } },
          async (tx) => {
            for (const candidate of queueCandidates) {
              const sprint = outcome.graph.sprints.get(candidate.sprintId);
              const queue = outcome.parsed.queues.find((q) => q.lane === candidate.lane);
              if (!sprint || !queue) {
                throw new RepoKernelError(
                  'INTERNAL',
                  `wave candidate ${candidate.sprintId} became invalid during apply`,
                );
              }
              const appended = await appendSlotToQueue(
                join(cwd, queue.file),
                candidate.sprintId,
                tx.opRoot,
                candidate.lane,
              );
              if (appended.kind === 'already') {
                throw new RepoKernelError(
                  'INTERNAL',
                  `${candidate.sprintId} was queued concurrently while applying wave`,
                );
              }
              const patch: Record<string, unknown> = { status: 'queued' };
              if (sprint.lane !== candidate.lane) patch.lane = candidate.lane;
              await mutateSprintFrontmatter(join(cwd, sprint.file), patch);

              const preview = previews.find((p) =>
                (outcome.graph.sprintsByEpic.get(p.epicId) ?? []).includes(candidate.sprintId),
              );
              if (preview) {
                const updated = {
                  ...preview,
                  applied: [...preview.applied, candidate.sprintId],
                };
                previews.splice(previews.indexOf(preview), 1, updated);
              }
            }
            await tx.refreshRegistry();
          },
        );
      }
    }

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: emitJson({ apply: opts.apply, epics: previews }),
        stderr: '',
      };
    }
    const lines = [`Wave ${selector}`, '', opts.apply ? 'Mode: apply' : 'Mode: preview'];
    for (const preview of previews) {
      lines.push('', preview.epicId);
      lines.push(`  queued: ${preview.queued.join(', ') || '(none)'}`);
      lines.push(`  planned: ${preview.planned.join(', ') || '(none)'}`);
      if (preview.applied.length > 0) lines.push(`  applied: ${preview.applied.join(', ')}`);
      for (const blocked of preview.blocked) {
        lines.push(`  blocked: ${blocked.sprintId} — ${blocked.reason}`);
      }
    }
    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
}

function expandEpicSelector(
  selector: string,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const ids: string[] = [];
  for (const part of selector.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const range = /^(E-)(\d+)\.\.E-(\d+)$/.exec(trimmed);
    if (range) {
      const [, prefix, startRaw, endRaw] = range;
      if (prefix === undefined || startRaw === undefined || endRaw === undefined) {
        return { ok: false, message: `invalid wave range "${trimmed}"` };
      }
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        return { ok: false, message: `invalid wave range "${trimmed}"` };
      }
      const count = Math.abs(end - start) + 1;
      if (count > MAX_SELECTOR_EPICS) {
        return {
          ok: false,
          message: `wave range "${trimmed}" expands to ${count} epics; maximum is ${MAX_SELECTOR_EPICS}`,
        };
      }
      const width = startRaw.length;
      const step = start <= end ? 1 : -1;
      for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
        ids.push(`${prefix}${String(n).padStart(width, '0')}`);
      }
    } else {
      if (!EPIC_ID_RE.test(trimmed)) {
        return {
          ok: false,
          message: `invalid epic selector "${trimmed}" (use E-NNN or E-NNN..E-NNN)`,
        };
      }
      ids.push(trimmed);
    }
    if (ids.length > MAX_SELECTOR_EPICS) {
      return {
        ok: false,
        message: `wave selector expands to ${ids.length} epics; maximum is ${MAX_SELECTOR_EPICS}`,
      };
    }
  }
  return { ok: true, value: ids };
}

function dependencyBlockReason(sprint: Sprint, unmet: readonly string[]): string {
  const dependsOn = unmet.filter((id) => sprint.depends_on.includes(id));
  const blockedBy = unmet.filter(
    (id) => sprint.blocked_by.includes(id) && !sprint.depends_on.includes(id),
  );
  const parts = [];
  if (dependsOn.length > 0) parts.push(`depends on unshipped ${dependsOn.join(', ')}`);
  if (blockedBy.length > 0) parts.push(`blocked by ${blockedBy.join(', ')}`);
  return parts.join('; ');
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}
