import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type Finding,
  loadProject,
  meetsThreshold,
  RepoKernelError,
  runValidators,
  type Sprint,
  transitiveDependents,
} from '@repokernel/core';
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
  /**
   * When true, also remove every queued sprint that transitively depends on
   * `id` (status `queued | planned | pending`). All removals happen inside a
   * single lifecycle scope; if the post-removal registry check finds a
   * problem the *whole* transaction is rolled back by the journal and the
   * command exits non-zero with the queue byte-identical to before the call.
   * When false (default), a queue removal that would orphan a dependent
   * is refused: the command exits non-zero with the *unchanged* queue and
   * names every dependent that would need to be removed.
   */
  readonly cascadeDependents?: boolean;
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

    // Compute the transitive-dependent closure BEFORE any mutation. When
    // --cascade-dependents is set we will remove all of them in a single
    // lifecycle scope; when it is not, we refuse the removal if any
    // dependent exists in a queueable status so the user has to opt into
    // the cascade explicitly.
    const dependents = transitiveDependents(outcome.graph, id);
    const dependentRemovals = dependents
      .map((dep) => resolveQueueRemovalForSprint(outcome, dep))
      .filter((r): r is QueueRemovalPlan => r !== null);

    if (!opts.cascadeDependents && dependentRemovals.length > 0) {
      const names = dependentRemovals.map((r) => `${r.sprint.id}@${r.lane}`).join(', ');
      return err(
        'WOULD_ORPHAN_DEPENDENTS',
        `removing ${id} from queue/${opts.lane} would orphan ${dependentRemovals.length} dependent sprint(s): ${names}`,
        `rk queue remove ${id} --lane ${opts.lane} --cascade-dependents`,
      );
    }

    const allRemovals: QueueRemovalPlan[] = [{ sprint, lane: opts.lane, queueFile: queue.file }];
    for (const dep of dependentRemovals) allRemovals.push(dep);

    // Compute the pre-mutation blocking-finding fingerprint so the
    // post-mutation comparison can tell apart "removal introduced a new
    // blocker" (the rollback case) from "blockers that existed before us
    // are still around" (not our problem — propagate as exit-code).
    const preBlocking = preMutationBlockingFingerprint(outcome);

    let removeOutcome:
      | {
          removedSlots: Array<{ sprintId: string; lane: string; slot: string }>;
          statusChanges: Array<{ sprintId: string; from: string; to: string }>;
          findings: readonly Finding[];
        }
      | undefined;

    try {
      removeOutcome = await withLifecycleScope(
        {
          cwd,
          command: 'queue-remove',
          args: { sprintId: id, lane: opts.lane, cascade: opts.cascadeDependents === true },
        },
        async (tx) => {
          const removedSlots: Array<{ sprintId: string; lane: string; slot: string }> = [];
          const statusChanges: Array<{ sprintId: string; from: string; to: string }> = [];
          for (const plan of allRemovals) {
            const removed = await removeSlotFromQueue(
              join(cwd, plan.queueFile),
              plan.sprint.id,
              tx.opRoot,
              plan.lane,
            );
            if (removed.kind === 'missing') continue;
            removedSlots.push({
              sprintId: plan.sprint.id,
              lane: plan.lane,
              slot: removed.removed.id,
            });
            if (plan.sprint.status === 'queued') {
              await mutateSprintFrontmatter(join(cwd, plan.sprint.file), { status: 'planned' });
              statusChanges.push({
                sprintId: plan.sprint.id,
                from: 'queued',
                to: 'planned',
              });
            }
          }

          const { findings } = await tx.refreshRegistry();
          const blockingPost = findings.filter((f) =>
            meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
          );
          const introduced = blockingPost.filter((f) => !preBlocking.has(fingerprintFinding(f)));
          if (introduced.length > 0) {
            // Throw to abort the journal entry. The catch block below maps
            // this back into a CommandResult; the journal pending entry never
            // transitions to done so `rk recover` replays the original
            // on-disk state on next boot. Non-zero exit ⇒ nothing changed.
            const reason = `${introduced.length} new blocking finding(s) after removal: ${introduced
              .slice(0, 3)
              .map((f) => f.code ?? 'UNKNOWN')
              .join(', ')}${introduced.length > 3 ? '…' : ''}`;
            throw new RepoKernelError('IO_ERROR', `__queue_remove_rollback__:${reason}`);
          }
          return { removedSlots, statusChanges, findings };
        },
      );
    } catch (cause) {
      if (
        cause instanceof RepoKernelError &&
        cause.message.startsWith('__queue_remove_rollback__:')
      ) {
        return err(
          'POST_MUTATION_INVALID',
          `queue removal rolled back: ${cause.message.slice('__queue_remove_rollback__:'.length)}`,
          opts.cascadeDependents
            ? `inspect findings with rk validate, then retry`
            : `try --cascade-dependents`,
        );
      }
      throw cause;
    }

    if (!removeOutcome) {
      return err('QUEUE_NOT_UPDATED', `failed to remove ${id} from queue "${opts.lane}"`);
    }

    if (!removeOutcome.removedSlots.some((r) => r.sprintId === id && r.lane === opts.lane)) {
      // Primary removal was a no-op (sprint not actually in queue when we
      // re-checked under the lock). Treat as missing — same UX as the
      // pre-cascade behavior.
      const slotList =
        queue.slots.length > 0 ? queue.slots.map((s) => s.sprint_id).join(', ') : 'empty';
      return err(
        'NOT_IN_QUEUE',
        `${id} is not in queue/${opts.lane} (current slots: [${slotList}])`,
        `rk queue add ${id} --lane ${opts.lane}`,
      );
    }

    const blocking = removeOutcome.findings.filter((f) =>
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
        slot: removeOutcome.removedSlots.find((r) => r.sprintId === id)?.slot ?? null,
        findingCount: blocking.length,
        cascade: opts.cascadeDependents === true,
        cascadedRemovals: removeOutcome.removedSlots.filter((r) => r.sprintId !== id),
        cascadedStatusChanges: removeOutcome.statusChanges.filter((c) => c.sprintId !== id),
      });
      return {
        exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
        stdout: `${payload}\n`,
        stderr: '',
      };
    }

    const primarySlot = removeOutcome.removedSlots.find((r) => r.sprintId === id);
    const out = [
      `Removed ${id} from queue/${opts.lane}`,
      '',
      `  ${pc.bold('Sprint')}    ${id} — ${sprint.title}`,
      `  ${pc.bold('Lane')}      ${opts.lane}`,
      `  ${pc.bold('Slot')}      ${primarySlot?.slot ?? '(none)'} (removed, queue re-ordered)`,
      statusLine,
    ];

    const cascaded = removeOutcome.removedSlots.filter((r) => r.sprintId !== id);
    if (cascaded.length > 0) {
      out.push('', `Cascaded removals (${cascaded.length}):`);
      for (const r of cascaded) out.push(`  ${r.sprintId} from queue/${r.lane} (slot ${r.slot})`);
    }

    out.push('', `Re-add: ${pc.dim(`rk queue add ${id} --lane ${opts.lane}`)}`);

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

export interface QueueMoveOptions {
  readonly cwd: string;
  readonly from: string;
  readonly to: string;
  readonly force: boolean;
  readonly json: boolean;
}

/**
 * Move a sprint from one lane's queue to another in a single atomic step,
 * preserving its `queued` status. This is the supported recovery path for a
 * sprint that landed on a busy lane: `rk queue remove` + `rk queue add` works
 * but churns status (queued → planned → queued) and is two journal entries;
 * `move` keeps status and rolls back as a unit if the target write fails.
 *
 * A lane move cannot orphan dependents — dependencies are sprint-level, not
 * lane-level — so the cascade machinery from `remove` does not apply here.
 */
export async function runQueueMoveCommand(
  id: string,
  opts: QueueMoveOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  if (opts.from === opts.to) {
    return err('SAME_LANE', `--from and --to are both "${opts.from}" — nothing to move`);
  }

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return configError();
    }

    const sprint = outcome.graph.sprints.get(id);
    if (!sprint) {
      return err('SPRINT_NOT_FOUND', `sprint ${id} not found`);
    }

    const fromQueue = outcome.parsed.queues.find((q) => q.lane === opts.from);
    if (!fromQueue) {
      return err(
        'QUEUE_NOT_FOUND',
        `no queue file found for lane "${opts.from}"`,
        `rk create queue --lane ${opts.from}`,
      );
    }
    const toQueue = outcome.parsed.queues.find((q) => q.lane === opts.to);
    if (!toQueue) {
      return err(
        'QUEUE_NOT_FOUND',
        `no queue file found for lane "${opts.to}"`,
        `rk create queue --lane ${opts.to}`,
      );
    }

    const slot = fromQueue.slots.find((s) => s.sprint_id === id);
    if (!slot) {
      const slotList =
        fromQueue.slots.length > 0 ? fromQueue.slots.map((s) => s.sprint_id).join(', ') : 'empty';
      return err(
        'NOT_IN_QUEUE',
        `${id} is not in queue/${opts.from} (current slots: [${slotList}])`,
        `rk queue add ${id} --lane ${opts.from}`,
      );
    }

    const HARD_STOP = new Set(['active', 'review', 'shipped', 'cancelled']);
    if (HARD_STOP.has(sprint.status)) {
      return err(
        'INVALID_STATUS',
        `cannot move a sprint with status ${sprint.status}`,
        sprint.status === 'active'
          ? `rk review ${id} or rk cancel ${id} first`
          : `sprint is ${sprint.status} — queue move not allowed`,
      );
    }
    if (sprint.status === 'pending' && !opts.force) {
      return err(
        'PENDING_STATUS',
        `${id} has status pending — use --force to move anyway`,
        `rk queue move ${id} --from ${opts.from} --to ${opts.to} --force`,
      );
    }
    if (toQueue.slots.some((s) => s.sprint_id === id)) {
      return err('ALREADY_IN_QUEUE', `${id} is already in queue/${opts.to}`);
    }

    let moveOutcome:
      | {
          fromSlot: string;
          toSlot: string;
          order: number;
          newStatus: string;
          findings: readonly Finding[];
        }
      | undefined;
    try {
      moveOutcome = await withLifecycleScope(
        { cwd, command: 'queue-move', args: { sprintId: id, from: opts.from, to: opts.to } },
        async (tx) => {
          const removed = await removeSlotFromQueue(
            join(cwd, fromQueue.file),
            id,
            tx.opRoot,
            opts.from,
          );
          if (removed.kind === 'missing') {
            throw new RepoKernelError(
              'IO_ERROR',
              `__queue_move_abort__:${id} is no longer in queue/${opts.from}`,
            );
          }
          const appended = await appendSlotToQueue(join(cwd, toQueue.file), id, tx.opRoot, opts.to);
          if (appended.kind === 'already') {
            throw new RepoKernelError(
              'IO_ERROR',
              `__queue_move_abort__:${id} is already in queue/${opts.to}`,
            );
          }
          // A queued sprint stays queued; normalize a drifted planned/reopened
          // slot to queued so the move leaves a consistent state.
          const mutations: Record<string, unknown> = { lane: opts.to };
          const newStatus =
            sprint.status === 'planned' || sprint.status === 'reopened' ? 'queued' : sprint.status;
          if (newStatus !== sprint.status) mutations.status = newStatus;
          await mutateSprintFrontmatter(join(cwd, sprint.file), mutations);

          const { findings } = await tx.refreshRegistry();
          return {
            fromSlot: removed.removed.id,
            toSlot: appended.slot.id,
            order: appended.slot.order,
            newStatus,
            findings,
          };
        },
      );
    } catch (cause) {
      if (cause instanceof RepoKernelError && cause.message.startsWith('__queue_move_abort__:')) {
        return err(
          'MOVE_ABORTED',
          `queue move rolled back: ${cause.message.slice('__queue_move_abort__:'.length)}`,
          `rk status --brief to re-check queue state`,
        );
      }
      throw cause;
    }

    if (!moveOutcome) {
      return err('QUEUE_NOT_UPDATED', `failed to move ${id} from queue/${opts.from}`);
    }

    const blocking = moveOutcome.findings.filter((f) =>
      meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
    );
    const nextCommand = `rk start ${id}`;

    if (opts.json) {
      const payload = JSON.stringify({
        id,
        from: opts.from,
        to: opts.to,
        moved: true,
        fromSlot: moveOutcome.fromSlot,
        toSlot: moveOutcome.toSlot,
        order: moveOutcome.order,
        status: moveOutcome.newStatus,
        findingCount: blocking.length,
        next: nextCommand,
      });
      return {
        exitCode: blocking.length > 0 ? EXIT_FINDINGS : EXIT_OK,
        stdout: `${payload}\n`,
        stderr: '',
      };
    }

    const out = [
      `Moved ${id} from queue/${opts.from} to queue/${opts.to}`,
      '',
      `  ${pc.bold('Sprint')}    ${id} — ${sprint.title}`,
      `  ${pc.bold('From')}      ${opts.from} (slot ${moveOutcome.fromSlot})`,
      `  ${pc.bold('To')}        ${opts.to} (slot ${moveOutcome.toSlot}, order ${moveOutcome.order})`,
      `  ${pc.bold('Status')}    ${moveOutcome.newStatus}`,
      '',
      `Next: ${pc.dim(nextCommand)}`,
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

interface QueueRemovalPlan {
  readonly sprint: Sprint;
  readonly lane: string;
  readonly queueFile: string;
}

function resolveQueueRemovalForSprint(
  outcome: Extract<Awaited<ReturnType<typeof loadProject>>, { ok: true }>,
  sprint: Sprint,
): QueueRemovalPlan | null {
  for (const queue of outcome.parsed.queues) {
    if (queue.slots.some((s) => s.sprint_id === sprint.id)) {
      return { sprint, lane: queue.lane, queueFile: queue.file };
    }
  }
  return null;
}

function fingerprintFinding(f: Finding): string {
  return `${f.code ?? 'UNCODED'}|${f.entityType ?? ''}|${f.entityId ?? ''}|${f.severity}`;
}

function preMutationBlockingFingerprint(
  outcome: Extract<Awaited<ReturnType<typeof loadProject>>, { ok: true }>,
): Set<string> {
  const findings = runValidators({
    parsed: outcome.parsed,
    graph: outcome.graph,
    config: outcome.config,
    parseFindings: outcome.parsed.findings,
  });
  const blocking = findings.filter((f) =>
    meetsThreshold(f.severity, outcome.config.policies.severityFailThreshold),
  );
  return new Set(blocking.map(fingerprintFinding));
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
