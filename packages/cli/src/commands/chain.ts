import { resolve } from 'node:path';
import type { Sprint } from '@repokernel/core';
import { loadProject, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import type { CommandResult } from './validate.js';

export interface ChainPreviewOptions {
  readonly cwd: string;
  readonly lane?: string;
  readonly epic?: string;
  readonly limit: number;
  readonly ignoreDisabled: boolean;
  readonly json: boolean;
}

export async function runChainPreviewCommand(opts: ChainPreviewOptions): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const { chaining } = outcome.config;
    const lane = opts.lane ?? outcome.config.policies.defaultLane;
    const limit = opts.limit;
    const epicId = opts.epic;

    const isEnabled = chaining.enabled;

    if (!isEnabled && !opts.ignoreDisabled) {
      // show preview with disabled note
      const { chain, ineligible, gate, plannedForEpic } = buildChain(
        outcome,
        lane,
        limit,
        chaining.sameEpicOnly,
        epicId,
      );
      return formatDisabledOutput(opts, chain, ineligible, gate, lane, chaining, plannedForEpic);
    }

    // enabled (or --ignore-disabled)
    const { chain, ineligible, gate, plannedForEpic } = buildChain(
      outcome,
      lane,
      limit,
      chaining.sameEpicOnly,
      epicId,
    );
    return formatEnabledOutput(
      opts,
      chain,
      ineligible,
      gate,
      lane,
      chaining,
      isEnabled,
      plannedForEpic,
    );
  } catch (e) {
    return runtimeErr(e);
  }
}

// — chain computation —

export interface ChainResult {
  chain: Sprint[];
  ineligible: Array<{ sprint: Sprint; reason: string }>;
  gate: Sprint | null;
  plannedForEpic: Sprint[];
}

export function buildChain(
  outcome: {
    graph: {
      sprints: ReadonlyMap<string, Sprint>;
      queuesByLane: ReadonlyMap<string, readonly { sprint_id: string; order: number }[]>;
    };
    config: { chaining: { sameEpicOnly: boolean; sameLaneOnly: boolean } };
  },
  lane: string,
  limit: number,
  sameEpicOnly: boolean,
  epicId?: string,
): ChainResult {
  const slots = [...(outcome.graph.queuesByLane.get(lane) ?? [])].sort((a, b) => a.order - b.order);

  const chain: Sprint[] = [];
  const ineligible: Array<{ sprint: Sprint; reason: string }> = [];
  let gate: Sprint | null = null;

  // collect all sprint ids already shipped or active (for dependency checks)
  const shipped = new Set(
    [...outcome.graph.sprints.values()].filter((s) => s.status === 'shipped').map((s) => s.id),
  );

  // track what would be shipped in the chain (for transitive dependency resolution)
  const willBeShipped = new Set(shipped);
  let firstEpicId: string | undefined;

  for (const slot of slots) {
    if (chain.length >= limit) break;

    const sprint = outcome.graph.sprints.get(slot.sprint_id);
    if (!sprint) continue;

    // only queued sprints are chain-eligible
    if (sprint.status !== 'queued') {
      ineligible.push({
        sprint,
        reason:
          sprint.status === 'planned' || sprint.status === 'pending'
            ? `not eligible: ${sprint.status} sprints must be queued`
            : `not eligible: status is ${sprint.status}`,
      });
      continue;
    }

    if (epicId !== undefined && sprint.epic_id !== epicId) {
      ineligible.push({ sprint, reason: `not eligible: different epic (${sprint.epic_id})` });
      continue;
    }

    // gate check — stop chain here
    if (sprint.gate) {
      gate = sprint;
      break;
    }

    // same-epic constraint
    if (sameEpicOnly) {
      if (firstEpicId === undefined) {
        firstEpicId = sprint.epic_id;
      } else if (sprint.epic_id !== firstEpicId) {
        ineligible.push({ sprint, reason: `not eligible: different epic (sameEpicOnly: true)` });
        continue;
      }
    }

    // dependency check
    const unshipped = sprint.depends_on.filter((d) => !willBeShipped.has(d));
    if (unshipped.length > 0) {
      ineligible.push({
        sprint,
        reason: `not eligible: depends on unshipped ${unshipped.join(', ')}`,
      });
      continue;
    }

    chain.push(sprint);
    willBeShipped.add(sprint.id);
  }

  const plannedForEpic: Sprint[] =
    epicId !== undefined
      ? [...outcome.graph.sprints.values()].filter(
          (s) => s.epic_id === epicId && (s.status === 'planned' || s.status === 'pending'),
        )
      : [];

  return { chain, ineligible, gate, plannedForEpic };
}

// — formatters —

function formatDisabledOutput(
  opts: ChainPreviewOptions,
  chain: Sprint[],
  ineligible: Array<{ sprint: Sprint; reason: string }>,
  gate: Sprint | null,
  lane: string,
  _chaining: { enabled: boolean; maxSprintsPerRun: number; stopOnSeverity: string },
  plannedForEpic: Sprint[],
): CommandResult {
  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify(
        {
          enabled: false,
          lane,
          eligible: false,
          chain: chain.map(sprintJson),
          ineligible: ineligible.map((i) => ({ sprint: sprintJson(i.sprint), reason: i.reason })),
          gate: gate ? sprintJson(gate) : null,
          stopped_by: gate ? `gate: ${gate.gate}` : null,
          planned_for_epic: plannedForEpic.map(sprintJson),
        },
        null,
        2,
      )}\n`,
      stderr: '',
    };
  }

  const out = [
    `Chaining is disabled (chaining.enabled: false)`,
    '',
    `Preview (what would be eligible if enabled):`,
  ];

  if (chain.length === 0) {
    out.push('  (no eligible sprints)');
  } else {
    for (let i = 0; i < chain.length; i++) {
      const s = chain[i]!;
      out.push(`  ${i + 1}.  ${s.id}  ${s.status.padEnd(10)} ${s.title}  → eligible`);
    }
  }

  if (ineligible.length > 0) {
    out.push('', '  Ineligible (not shown in chain):');
    for (const { sprint: s, reason } of ineligible) {
      out.push(`      ${s.id}  ${s.status.padEnd(10)} ${s.title}  → ${reason}`);
    }
  }

  if (gate) {
    out.push('', `  Stop before:`);
    out.push(`    ${gate.id}  gate: ${gate.gate} — ${gate.title}`);
  }

  if (plannedForEpic.length > 0) {
    out.push('', '  Planned (not yet queued):');
    for (const s of plannedForEpic) {
      out.push(
        `      ${s.id}  ${s.status.padEnd(10)} ${s.title}  → queue with rk queue add ${s.id} --lane ${s.lane}`,
      );
    }
  }

  out.push('', `Enable: set chaining.enabled: true in repokernel.config.yaml`);

  return { exitCode: EXIT_OK, stdout: `${out.join('\n')}\n`, stderr: '' };
}

function formatEnabledOutput(
  opts: ChainPreviewOptions,
  chain: Sprint[],
  ineligible: Array<{ sprint: Sprint; reason: string }>,
  gate: Sprint | null,
  lane: string,
  chaining: { enabled: boolean; maxSprintsPerRun: number; stopOnSeverity: string },
  isEnabled: boolean,
  plannedForEpic: Sprint[],
): CommandResult {
  const eligible = chain.length > 0;

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: `${JSON.stringify(
        {
          enabled: isEnabled,
          lane,
          eligible,
          chain: chain.map(sprintJson),
          ineligible: ineligible.map((i) => ({ sprint: sprintJson(i.sprint), reason: i.reason })),
          gate: gate ? sprintJson(gate) : null,
          stopped_by: gate ? `gate: ${gate.gate}` : null,
          planned_for_epic: plannedForEpic.map(sprintJson),
        },
        null,
        2,
      )}\n`,
      stderr: '',
    };
  }

  const line = '─'.repeat(56);
  const note = !isEnabled ? '  (preview with --ignore-disabled)' : '';
  const out = [
    `Chain preview — lane: ${lane}  (maxSprintsPerRun: ${chaining.maxSprintsPerRun})${note}`,
    line,
  ];

  if (chain.length === 0) {
    out.push('  (no eligible sprints)');
  } else {
    for (let i = 0; i < chain.length; i++) {
      const s = chain[i]!;
      out.push(`  ${i + 1}.  ${s.id}  ${s.status.padEnd(10)} ${s.title}  → eligible`);
    }
  }

  if (ineligible.length > 0) {
    out.push('', '  Ineligible:');
    for (const { sprint: s, reason } of ineligible) {
      out.push(`      ${s.id}  ${s.status.padEnd(10)} ${s.title}  → ${reason}`);
    }
  }

  if (gate) {
    out.push('', '  Stop before:');
    out.push(`    ${gate.id}  gate: ${gate.gate} — ${gate.title}`);
  }

  if (plannedForEpic.length > 0) {
    out.push('', '  Planned (not yet queued):');
    for (const s of plannedForEpic) {
      out.push(
        `      ${s.id}  ${s.status.padEnd(10)} ${s.title}  → queue with rk queue add ${s.id} --lane ${s.lane}`,
      );
    }
  }

  out.push('', `Chain eligible: ${eligible ? pc.bold('yes') : pc.red('no')}`);

  return { exitCode: EXIT_OK, stdout: `${out.join('\n')}\n`, stderr: '' };
}

function sprintJson(s: Sprint) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    lane: s.lane,
    epic_id: s.epic_id,
    gate: s.gate ?? null,
  };
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
