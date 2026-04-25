import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadProject, meetsThreshold, RepoKernelError } from '@repokernel/core';
import matter from 'gray-matter';
import pc from 'picocolors';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { mutateSprintFrontmatter } from '../lifecycle/mutate.js';
import { refreshRegistry } from '../lifecycle/registry.js';
import type { CommandResult } from './validate.js';

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

    // already in this queue?
    const existing = queue.slots.find((s) => s.sprint_id === id);
    if (existing) {
      return err(
        'ALREADY_IN_QUEUE',
        `${id} is already in queue for lane "${opts.lane}" (slot ${existing.id}, order ${existing.order})`,
      );
    }

    // compute next slot id and order from existing slots
    const { nextSlotId, nextOrder } = computeNextSlot(queue.slots);

    // mutations
    const statusWillChange = sprint.status === 'planned' || sprint.status === 'reopened';
    const previousStatus = sprint.status;

    await appendSlotToQueue(join(cwd, queue.file), {
      id: nextSlotId,
      sprint_id: id,
      order: nextOrder,
    });
    const updated: string[] = [`${queue.file}  (slot ${nextSlotId} added)`];

    if (statusWillChange) {
      await mutateSprintFrontmatter(join(cwd, sprint.file), { status: 'queued' });
      updated.push(`${sprint.file}  (status ${previousStatus} → queued)`);
    }

    const { findings } = await refreshRegistry(cwd);
    updated.push('.repokernel/registry.json');

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

// — helpers —

function computeNextSlot(slots: ReadonlyArray<{ id: string; order: number }>): {
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

async function appendSlotToQueue(
  queueFile: string,
  slot: { id: string; sprint_id: string; order: number },
): Promise<void> {
  const raw = await readFile(queueFile, 'utf8');
  const parsed = matter(raw);
  const slots: unknown[] = Array.isArray(parsed.data.slots) ? parsed.data.slots : [];
  slots.push(slot);
  parsed.data.slots = slots;
  await writeFile(queueFile, matter.stringify(parsed.content, parsed.data), 'utf8');
}

function err(_code: string, message: string, suggestion?: string): CommandResult {
  const lines = [`error: ${message}`];
  if (suggestion) lines.push(`  → ${suggestion}`);
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${lines.join('\n')}\n` };
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
