import { join, resolve } from 'node:path';
import { loadProject, type Sprint } from '@repokernel/core';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { deleteSprintFrontmatterKeys, mutateSprintFrontmatter } from '../lifecycle/mutate.js';
import { withLifecycleScope } from '../lifecycle/transaction.js';
import type { CommandResult } from './validate.js';

export interface GateListOptions {
  readonly cwd: string;
  readonly epicId?: string;
  readonly json?: boolean;
}

export interface GateResolveOptions {
  readonly cwd: string;
  readonly epicId?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface GateAddOptions {
  readonly cwd: string;
  readonly sprintIds: readonly string[];
  readonly json?: boolean;
}

/** Sprint states past the planning window — a gate declared now would never pause a run. */
const UNGATEABLE_STATUSES = new Set(['active', 'review', 'shipped', 'cancelled']);

export async function runGateAddCommand(
  gateName: string,
  opts: GateAddOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    if (gateName.trim().length === 0) {
      return err(
        'GATE_NAME_REQUIRED',
        'gate name must not be empty',
        'usage: rk gate add <gate-name> --sprint <S-NNN>',
      );
    }
    if (opts.sprintIds.length === 0) {
      return err(
        'GATE_SPRINT_REQUIRED',
        'at least one --sprint <S-NNN> is required',
        'usage: rk gate add <gate-name> --sprint <S-NNN>',
      );
    }

    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const { graph } = outcome;

    // Resolve and check every sprint BEFORE writing anything, so a bad id in the
    // list leaves the project untouched.
    const targets: Sprint[] = [];
    for (const id of opts.sprintIds) {
      const sprint = graph.sprints.get(id);
      if (sprint === undefined) {
        return err(
          'GATE_SPRINT_NOT_FOUND',
          `sprint ${id} not found`,
          'check the id with: rk ls sprints',
        );
      }
      if (UNGATEABLE_STATUSES.has(sprint.status)) {
        return err(
          'GATE_SPRINT_NOT_GATEABLE',
          `sprint ${id} is ${sprint.status}; declare gates before a sprint starts (planned/pending/queued)`,
          'gate the sprint at planning time, or pause the run another way',
        );
      }
      targets.push(sprint);
    }

    await withLifecycleScope(
      { cwd, command: 'gate-add', args: { gateName, sprintIds: [...opts.sprintIds] } },
      async (tx) => {
        for (const sprint of targets) {
          await mutateSprintFrontmatter(join(cwd, sprint.file), { gate: gateName });
        }
        await tx.refreshRegistry();
      },
    );

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            kind: 'gate',
            name: gateName,
            sprints: targets.map((s) => s.id),
            next_actions: ['rk gate ls', `rk gate resolve ${gateName}`],
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    const lines = [
      '',
      `Gate "${gateName}" added to ${targets.length} sprint(s): ${targets.map((s) => s.id).join(', ')}`,
      '',
      'A run pauses at these sprints until the gate is cleared:',
      `  rk gate resolve ${gateName}`,
      '',
    ];
    return { exitCode: EXIT_OK, stdout: lines.join('\n'), stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

export async function runGateListCommand(opts: GateListOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const { graph } = outcome;

    const gateMap = new Map<string, Sprint[]>();
    for (const sprint of graph.sprints.values()) {
      if (!sprint.gate) continue;
      if (opts.epicId && sprint.epic_id !== opts.epicId) continue;
      const arr = gateMap.get(sprint.gate) ?? [];
      arr.push(sprint);
      gateMap.set(sprint.gate, arr);
    }

    if (gateMap.size === 0) {
      return { exitCode: EXIT_OK, stdout: 'No gates found.\n', stderr: '' };
    }

    if (opts.json) {
      const result = [...gateMap.entries()].map(([name, sprints]) => ({
        name,
        sprints: sprints.map((s) => ({
          id: s.id,
          epic_id: s.epic_id,
          title: s.title,
          status: s.status,
        })),
      }));
      return { exitCode: EXIT_OK, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' };
    }

    const lines: string[] = [''];
    for (const [name, sprints] of gateMap) {
      lines.push(`Gate: ${name}`);
      for (const s of sprints) {
        lines.push(`  ${s.id} [${s.status}] — ${s.title}`);
      }
    }
    lines.push('');
    return { exitCode: EXIT_OK, stdout: lines.join('\n'), stderr: '' };
  } catch (e) {
    return runtimeErr(e);
  }
}

export async function runGateResolveCommand(
  gateName: string,
  opts: GateResolveOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);
  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const { graph } = outcome;

    const gatedSprints = [...graph.sprints.values()].filter(
      (s) => s.gate === gateName && (!opts.epicId || s.epic_id === opts.epicId),
    );

    if (gatedSprints.length === 0) {
      return err(
        'GATE_NOT_FOUND',
        `no sprints with gate "${gateName}" found`,
        opts.epicId
          ? `check gate name and epic ${opts.epicId}`
          : 'check gate name with: rk gate ls',
      );
    }

    if (!opts.force) {
      const epicIds = new Set(gatedSprints.map((s) => s.epic_id));
      for (const epicId of epicIds) {
        const blocking = [...graph.sprints.values()].filter(
          (s) =>
            s.epic_id === epicId && s.gate == null && !['shipped', 'cancelled'].includes(s.status),
        );
        if (blocking.length > 0) {
          const ids = blocking.map((s) => s.id).join(', ');
          return err(
            'GATE_PRECONDITION_FAILED',
            `gate "${gateName}" cannot be resolved: ${ids} not yet shipped`,
            'ship all non-gated sprints first, or use --force to skip this check',
          );
        }
      }
    }

    if (opts.dryRun) {
      const lines = [
        `dry-run: rk gate resolve ${gateName}`,
        '',
        'Would clear gate field from:',
        ...gatedSprints.map((s) => `  ${s.id} — ${s.title}`),
        '',
        'No files written.',
      ];
      return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }

    await withLifecycleScope(
      { cwd, command: 'gate-resolve', args: { gateName, epicId: opts.epicId ?? null } },
      async (tx) => {
        for (const sprint of gatedSprints) {
          await deleteSprintFrontmatterKeys(join(cwd, sprint.file), ['gate']);
        }
        await tx.refreshRegistry();
      },
    );

    const lines = [
      '',
      `Gate "${gateName}" resolved.`,
      `  Cleared from ${gatedSprints.length} sprint(s): ${gatedSprints.map((s) => s.id).join(', ')}`,
      '',
      'Sprints are now runnable. If a run is paused at this gate:',
      `  rk run <epic-id> --resume <run-id>`,
      '',
    ];
    return { exitCode: EXIT_OK, stdout: lines.join('\n'), stderr: '' };
  } catch (e) {
    return runtimeErr(e);
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

function runtimeErr(e: unknown): CommandResult {
  const message = e instanceof Error ? e.message : String(e);
  return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${message}\n` };
}
