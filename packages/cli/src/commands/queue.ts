import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Finding, loadProject, meetsThreshold, RepoKernelError } from '@repokernel/core';
import matter from 'gray-matter';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { ambientJournalWrite } from '../lifecycle/journal.js';
import { withLockRetrying } from '../lifecycle/locks.js';
import { mutateSprintFrontmatter, removeSlotFromQueue } from '../lifecycle/mutate.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import type { CommandResult } from './validate.js';

export { removeSlotFromQueue } from '../lifecycle/mutate.js';

export interface QueueAddOptions {
  readonly cwd: string;
  readonly lane: string;
  readonly force: boolean;
  readonly json: boolean;
}

export async function runQueueAddCommand(
  id: string,
  opts: QueueAddOptions,
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

    // status gating
    const HARD_STOP = new Set(['active', 'review', 'shipped', 'cancelled']);
    if (HARD_STOP.has(sprint.status)) {
      return err(
        'INVALID_STATUS',
        `cannot queue a sprint with status ${sprint.status}`,
        sprint.status === 'shipped'
          ? `use rk reopen ${id} first`
          : `sprint is ${sprint.status} — queue add not allowed`,
      );
    }
    if (sprint.status === 'pending' && !opts.force) {
      return err(
        'PENDING_STATUS',
        `${id} has status pending — use --force to queue anyway`,
        `rk queue add ${id} --lane ${opts.lane} --force`,
      );
    }

    // find queue file for lane
    const queue = outcome.parsed.queues.find((q) => q.lane === opts.lane);
    if (!queue) {
      return err(
        'QUEUE_NOT_FOUND',
        `no queue file found for lane "${opts.lane}"`,
        `rk create queue --lane ${opts.lane}`,
      );
    }

    // Quick check on the cached graph for a friendlier error path; the
    // authoritative check (against the current on-disk file) happens below
    // under the per-lane lock, so a concurrent rk queue add for the same
    // sprint can't both succeed.
    const existing = queue.slots.find((s) => s.sprint_id === id);
    if (existing) {
      return err(
        'ALREADY_IN_QUEUE',
        `${id} is already in queue for lane "${opts.lane}" (slot ${existing.id}, order ${existing.order})`,
      );
    }

    // mutations
    const statusWillChange = sprint.status === 'planned' || sprint.status === 'reopened';
    const previousStatus = sprint.status;

    const addResult = await withLifecycleScope(
      { cwd, command: 'queue-add', args: { sprintId: id, lane: opts.lane } },
      async (tx) => {
        const appended = await appendSlotToQueue(join(cwd, queue.file), id, tx.opRoot, opts.lane);
        const updated: string[] = [];
        let findings: readonly Finding[] = [];
        if (appended.kind === 'already') return { appended, findings, updated };

        updated.push(`${queue.file}  (slot ${appended.slot.id} added)`);

        const laneWillChange = sprint.lane !== opts.lane;
        if (statusWillChange || laneWillChange) {
          const mutations: Record<string, unknown> = {};
          if (statusWillChange) mutations.status = 'queued';
          if (laneWillChange) mutations.lane = opts.lane;
          await mutateSprintFrontmatter(join(cwd, sprint.file), mutations);
          if (statusWillChange) updated.push(`${sprint.file}  (status ${previousStatus} → queued)`);
          if (laneWillChange) updated.push(`${sprint.file}  (lane: ${sprint.lane} → ${opts.lane})`);
        }

        ({ findings } = await tx.refreshRegistry());
        updated.push(outcome.config.paths.registry);
        return { appended, findings, updated };
      },
    );
    const { appended, findings, updated } = addResult;

    if (appended.kind === 'already') {
      return err(
        'ALREADY_IN_QUEUE',
        `${id} is already in queue for lane "${opts.lane}" (slot ${appended.existing.id}, order ${appended.existing.order})`,
      );
    }

    const nextSlotId = appended.slot.id;
    const nextOrder = appended.slot.order;

    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const statusLine = statusWillChange
      ? `  ${pc.bold('Status')}    ${previousStatus} → queued`
      : `  ${pc.bold('Status')}    ${sprint.status} (unchanged)`;

    const out = [
      `Added ${id} to queue ${opts.lane}`,
      '',
      `  ${pc.bold('Sprint')}    ${id} — ${sprint.title}`,
      `  ${pc.bold('Lane')}      ${opts.lane}`,
      `  ${pc.bold('Slot')}      ${nextSlotId}`,
      `  ${pc.bold('Order')}     ${nextOrder}`,
      statusLine,
      '',
      'Updated:',
      ...updated.map((u) => `  ${u}`),
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
    return runtimeErr(e);
  }
}

export interface QueueRemoveOptions {
  readonly cwd: string;
  readonly lane: string;
  readonly json: boolean;
}

export async function runQueueRemoveCommand(
  id: string,
  opts: QueueRemoveOptions,
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

    const queue = outcome.parsed.queues.find((q) => q.lane === opts.lane);
    if (!queue) {
      return err(
        'QUEUE_NOT_FOUND',
        `no queue file found for lane "${opts.lane}"`,
        `rk create queue --lane ${opts.lane}`,
      );
    }

    const existing = queue.slots.find((s) => s.sprint_id === id);
    if (!existing) {
      const presentInAnyQueue = outcome.parsed.queues.some((q) =>
        q.slots.some((s) => s.sprint_id === id),
      );
      if (sprint.status === 'queued' && !presentInAnyQueue) {
        let findings: readonly Finding[] = [];
        await withLifecycleScope(
          { cwd, command: 'queue-remove', args: { sprintId: id, lane: opts.lane, repair: true } },
          async (tx) => {
            await mutateSprintFrontmatter(join(cwd, sprint.file), { status: 'planned' });
            ({ findings } = await tx.refreshRegistry());
          },
        );
        const blocking = findings.filter((f) =>
          meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
        );

        if (opts.json) {
          const payload = JSON.stringify({
            id,
            lane: opts.lane,
            removed: false,
            repaired: true,
            newStatus: 'planned',
            slot: null,
            findingCount: blocking.length,
          });
          return {
            exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
            stdout: `${payload}\n`,
            stderr: '',
          };
        }

        const out = [
          `Repaired ${id}: status queued → planned`,
          '',
          `  ${pc.bold('Sprint')}    ${id} — ${sprint.title}`,
          `  ${pc.bold('Lane')}      ${opts.lane}`,
          `  ${pc.bold('Slot')}      already absent`,
          `  ${pc.bold('Status')}    queued → planned`,
        ];

        if (blocking.length > 0) {
          out.push('', pc.yellow(`Warning: ${blocking.length} finding(s) — run rk validate`));
        }

        return {
          exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
          stdout: `${out.join('\n')}\n`,
          stderr: '',
        };
      }

      const slotList =
        queue.slots.length > 0 ? queue.slots.map((s) => s.sprint_id).join(', ') : 'empty';
      return err(
        'NOT_IN_QUEUE',
        `${id} is not in queue/${opts.lane} (current slots: [${slotList}])`,
        `rk queue add ${id} --lane ${opts.lane}`,
      );
    }

    if (sprint.status === 'active') {
      return err(
        'INVALID_STATUS',
        `cannot remove active sprint ${id} from queue/${opts.lane}`,
        `rk review ${id}, rk close ${id}, or rk cancel ${id} first`,
      );
    }

    const removeResult = await withLifecycleScope(
      { cwd, command: 'queue-remove', args: { sprintId: id, lane: opts.lane } },
      async (tx) => {
        const removed = await removeSlotFromQueue(join(cwd, queue.file), id, tx.opRoot, opts.lane);
        let findings: readonly Finding[] = [];
        if (removed.kind === 'missing') return { removed, findings };

        if (sprint.status === 'queued') {
          await mutateSprintFrontmatter(join(cwd, sprint.file), { status: 'planned' });
        }

        ({ findings } = await tx.refreshRegistry());
        return { removed, findings };
      },
    );
    if (removeResult === undefined)
      return err('QUEUE_NOT_UPDATED', `failed to remove ${id} from queue "${opts.lane}"`);
    const { removed, findings } = removeResult;
    if (removed.kind === 'missing') {
      const slotList =
        removed.currentSprintIds.length > 0 ? removed.currentSprintIds.join(', ') : 'empty';
      return err(
        'NOT_IN_QUEUE',
        `${id} is not in queue/${opts.lane} (current slots: [${slotList}])`,
        `rk queue add ${id} --lane ${opts.lane}`,
      );
    }
    const blocking = findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );

    const newStatus = sprint.status === 'queued' ? 'planned' : sprint.status;
    const statusLine =
      sprint.status === 'queued'
        ? `  ${pc.bold('Status')}    queued → planned`
        : `  ${pc.bold('Status')}    ${sprint.status} (unchanged)`;

    if (opts.json) {
      const payload = JSON.stringify({
        id,
        lane: opts.lane,
        removed: true,
        newStatus,
        slot: removed.removed.id,
        findingCount: blocking.length,
      });
      return {
        exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
        stdout: `${payload}\n`,
        stderr: '',
      };
    }

    const out = [
      `Removed ${id} from queue/${opts.lane}`,
      '',
      `  ${pc.bold('Sprint')}    ${id} — ${sprint.title}`,
      `  ${pc.bold('Lane')}      ${opts.lane}`,
      `  ${pc.bold('Slot')}      ${removed.removed.id} (removed, queue re-ordered)`,
      statusLine,
      '',
      `Re-add: ${pc.dim(`rk queue add ${id} --lane ${opts.lane}`)}`,
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
    return runtimeErr(e);
  }
}

// — helpers —

export function computeNextSlot(slots: ReadonlyArray<{ id: string; order: number }>): {
  nextSlotId: string;
  nextOrder: number;
} {
  const re = /^Q-(\d+)$/;
  let maxNum = 0;
  let maxOrder = -1;
  for (const s of slots) {
    const m = re.exec(s.id);
    if (m?.[1] !== undefined) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    maxOrder = Math.max(maxOrder, s.order);
  }
  return {
    nextSlotId: `Q-${String(maxNum + 1).padStart(3, '0')}`,
    nextOrder: maxOrder + 1,
  };
}

export type AppendSlotResult =
  | { kind: 'added'; slot: { id: string; sprint_id: string; order: number } }
  | {
      kind: 'already';
      existing: { id: string; sprint_id: string; order: number };
    };

/**
 * Append a slot for `sprintId` to `queueFile`, atomically and under a
 * per-lane queue lock. Reload + slot computation + write all happen inside
 * the lock so two concurrent `rk queue add` invocations cannot allocate
 * the same Q-NNN id or duplicate sprint_id, and a crash mid-write leaves
 * the previous queue intact (atomicWriteText publishes via temp+rename).
 *
 * Returns 'already' when the sprint is already in the queue (reflects the
 * on-disk state inside the lock, not the loadProject snapshot the caller
 * may hold).
 */
export async function appendSlotToQueue(
  queueFile: string,
  sprintId: string,
  opRoot: string,
  lane: string,
): Promise<AppendSlotResult> {
  return withLockRetrying(`queue-${lane}`, opRoot, async () => {
    const raw = await readFile(queueFile, 'utf8');
    const parsed = matter(raw);
    const currentSlots = (Array.isArray(parsed.data.slots) ? parsed.data.slots : [])
      .filter(
        (s): s is Record<string, unknown> =>
          typeof s === 'object' && s !== null && !Array.isArray(s),
      )
      .map((s) => ({
        id: typeof s.id === 'string' ? s.id : '',
        sprint_id: typeof s.sprint_id === 'string' ? s.sprint_id : '',
        order: typeof s.order === 'number' ? s.order : 0,
      }));

    const existing = currentSlots.find((s) => s.sprint_id === sprintId);
    if (existing) return { kind: 'already', existing };

    const { nextSlotId, nextOrder } = computeNextSlot(currentSlots);
    const newSlot = { id: nextSlotId, sprint_id: sprintId, order: nextOrder };
    const newData = { ...parsed.data, slots: [...currentSlots, newSlot] };
    await ambientJournalWrite(queueFile, matter.stringify(parsed.content, newData));
    return { kind: 'added', slot: newSlot };
  });
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

function runtimeErr(e: unknown): CommandResult {
  if (e instanceof RepoKernelError) {
    return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
  }
  throw e;
}
