import { resolve } from 'node:path';
import type { Sprint } from '@repokernel/core';
import { loadProject, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { type LaneHealth, laneHealthDot } from '../format/progress.js';
import { padEnd } from '../format/table.js';
import { operationalRoot } from '../lifecycle/controlPaths.js';
import { claimLane, getLaneState } from '../lifecycle/laneState.js';
import { withLock } from '../lifecycle/locks.js';
import { acquireWorktree, releaseWorktree, worktreeBranch } from '../lifecycle/worktree.js';
import type { CommandResult } from './validate.js';

export interface LanesOptions {
  readonly cwd: string;
  readonly json: boolean;
}

interface LaneInfo {
  readonly name: string;
  readonly health: LaneHealth;
  readonly claimedBy: string | undefined;
  readonly queueDepth: number;
  readonly activeSprint: Sprint | undefined;
  readonly nextSprint: Sprint | undefined;
  readonly blockerNote: string | undefined;
}

export async function runLanesCommand(opts: LanesOptions): Promise<CommandResult> {
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

    const { graph, config } = outcome;
    const laneNames = [...graph.lanes.keys()].sort();

    if (laneNames.length === 0) {
      return { exitCode: EXIT_OK, stdout: '(no lanes configured)\n', stderr: '' };
    }

    const infos: LaneInfo[] = laneNames.map((name) => {
      const state = graph.lanes.get(name)!;
      const rawSlots = graph.queuesByLane.get(name);
      const slots = rawSlots ?? [];

      const activeSprints = [...graph.sprints.values()].filter(
        (s) => s.lane === name && s.status === 'active',
      );
      const activeSprint = activeSprints[0];

      const sortedSlots = [...slots].sort((a, b) => a.order - b.order);
      const nextSprint = sortedSlots
        .map((slot) => graph.sprints.get(slot.sprint_id))
        .find((s): s is Sprint => s !== undefined && s.status === 'queued');

      const health = classifyHealth(
        activeSprints,
        rawSlots,
        graph.sprints,
        config.policies.allowMultipleActivePerLane,
      );

      const blockerNote = buildBlockerNote(
        health,
        activeSprints,
        rawSlots,
        graph.sprints,
        config.policies.allowMultipleActivePerLane,
      );

      return {
        name,
        health,
        claimedBy: state.claimed_by,
        queueDepth: slots.length,
        activeSprint,
        nextSprint,
        blockerNote,
      };
    });

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            lanes: infos.map((info) => ({
              name: info.name,
              health: info.health,
              claimed_by: info.claimedBy ?? null,
              queueDepth: info.queueDepth,
              activeSprint: info.activeSprint?.id ?? null,
              nextSprint: info.nextSprint?.id ?? null,
              blockerNote: info.blockerNote ?? null,
            })),
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    const title = pc.bold('Lane Health');
    const sep = '─'.repeat(64);
    const lines = [title, sep];

    const nameWidth = Math.max(...infos.map((i) => i.name.length), 4);
    const claimWidth = Math.max(...infos.map((i) => (i.claimedBy ?? '—').length), 5);

    for (const info of infos) {
      const dot = laneHealthDot(info.health);
      const name = padEnd(info.name, nameWidth);
      const claim = padEnd(info.claimedBy ?? '—', claimWidth);
      const depth = `depth: ${info.queueDepth}`;
      const active = `active: ${info.activeSprint?.id ?? 'none'}`;
      const next = `next: ${info.nextSprint?.id ?? 'none'}`;
      const note = info.blockerNote ? `  ${pc.dim(`[${info.blockerNote}]`)}` : '';
      lines.push(`${dot} ${name}  ${claim}  ${depth}  ${active}  ${next}${note}`);
    }

    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError)
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

// — lane acquire/release —

export interface LaneAcquireOptions {
  readonly cwd: string;
  readonly force: boolean;
  readonly allowDirty: boolean;
}

export async function runLaneAcquireCommand(
  epicId: string,
  opts: LaneAcquireOptions,
): Promise<CommandResult> {
  const controlCwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd: controlCwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
      };
    }

    const { config } = outcome;
    const opRoot = await operationalRoot(controlCwd);

    const laneClaimKey = `epic-${epicId}`;
    const existing = await getLaneState(laneClaimKey, opRoot);
    if (existing && !opts.force) {
      return {
        exitCode: EXIT_BLOCKED,
        stdout: '',
        stderr: `error: epic ${epicId} already has an active lane claim (run ${existing.run_id})\n  → use --force to override\n`,
      };
    }

    const worktreeInfo = await withLock(`worktree-${epicId}`, opRoot, () =>
      acquireWorktree(epicId as `E-${string}`, config, controlCwd, {
        allowDirty: opts.allowDirty,
      }),
    );

    await claimLane(
      laneClaimKey,
      `manual-${epicId}`,
      epicId as `E-${string}`,
      worktreeInfo.path,
      worktreeInfo.branch,
      opRoot,
      { replace: opts.force },
    );

    return {
      exitCode: EXIT_OK,
      stdout: [
        `Lane acquired`,
        '',
        `  Epic:     ${epicId}`,
        `  Lane:     epic-${epicId}`,
        `  Worktree: ${worktreeInfo.path}`,
        `  Branch:   ${worktreeInfo.branch}`,
        `  Reused:   ${worktreeInfo.reused}`,
        '',
      ].join('\n'),
      stderr: '',
    };
  } catch (e) {
    if (e instanceof RepoKernelError)
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

export interface LaneReleaseOptions {
  readonly cwd: string;
  readonly force: boolean;
}

export async function runLaneReleaseCommand(
  epicId: string,
  opts: LaneReleaseOptions,
): Promise<CommandResult> {
  const controlCwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd: controlCwd });
    if (!outcome.ok) {
      return {
        exitCode: EXIT_RUNTIME,
        stdout: '',
        stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
      };
    }

    const { config } = outcome;
    const opRoot = await operationalRoot(controlCwd);

    await releaseWorktree(epicId as `E-${string}`, config, controlCwd, opts.force);

    const { releaseLane } = await import('../lifecycle/laneState.js');
    await releaseLane(`epic-${epicId}`, opRoot);

    return {
      exitCode: EXIT_OK,
      stdout: [
        `Lane released`,
        '',
        `  Epic:   ${epicId}`,
        `  Lane:   epic-${epicId}`,
        `  Branch: ${worktreeBranch(epicId as `E-${string}`, config)} (kept — merge or delete manually)`,
        '',
      ].join('\n'),
      stderr: '',
    };
  } catch (e) {
    if (e instanceof RepoKernelError)
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function classifyHealth(
  activeSprints: Sprint[],
  rawSlots: readonly { sprint_id: string; order: number }[] | undefined,
  sprints: ReadonlyMap<string, Sprint>,
  allowMultipleActive: boolean,
): LaneHealth {
  // blocked: multiple actives when policy disallows it, or no queue file exists at all
  if (!allowMultipleActive && activeSprints.length > 1) return 'blocked';
  if (rawSlots === undefined && activeSprints.length === 0) return 'blocked';

  const slots = rawSlots ?? [];

  // healthy: has active sprint or has at least one unblocked queued sprint
  if (activeSprints.length > 0) return 'healthy';
  const hasUnblockedQueued = slots.some((slot) => {
    const s = sprints.get(slot.sprint_id);
    if (!s || s.status !== 'queued') return false;
    return s.depends_on.every((d) => sprints.get(d)?.status === 'shipped');
  });
  if (hasUnblockedQueued) return 'healthy';

  return 'stalled';
}

function buildBlockerNote(
  health: LaneHealth,
  activeSprints: Sprint[],
  rawSlots: readonly { sprint_id: string; order: number }[] | undefined,
  sprints: ReadonlyMap<string, Sprint>,
  allowMultipleActive: boolean,
): string | undefined {
  if (health !== 'blocked' && health !== 'stalled') return undefined;
  if (!allowMultipleActive && activeSprints.length > 1)
    return `${activeSprints.length} active sprints`;
  if (rawSlots === undefined) return 'no queue';
  const slots = rawSlots;
  if (slots.length === 0) return 'empty queue';
  if (health === 'stalled') {
    const allBlocked = slots.every((slot) => {
      const s = sprints.get(slot.sprint_id);
      if (!s || s.status !== 'queued') return true;
      return s.depends_on.some((d) => sprints.get(d)?.status !== 'shipped');
    });
    if (allBlocked) return 'all queued sprints blocked by deps';
  }
  return undefined;
}
