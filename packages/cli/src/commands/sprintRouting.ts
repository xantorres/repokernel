import { join, resolve } from 'node:path';
import {
  ComplexityHintSchema,
  loadProject,
  RepoKernelError,
  RoutingFanoutEntrySchema,
  SprintIdSchema,
  TierNameSchema,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { mutateSprintExtras } from '../integrations/sprintExtras.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import type { CommandResult } from './validate.js';

export interface SprintRoutingSetOptions {
  readonly cwd: string;
  readonly complexity?: string;
  readonly preferTier?: string;
  readonly pinTier?: string;
  readonly fanout?: string;
  readonly json?: boolean;
}

export interface SprintRoutingClearOptions {
  readonly cwd: string;
  readonly json?: boolean;
}

interface RoutingMutationResult {
  readonly sprint_id: string;
  readonly file: string;
  readonly routing: Record<string, unknown> | null;
}

export async function runSprintRoutingSetCommand(
  sprintId: string,
  opts: SprintRoutingSetOptions,
): Promise<CommandResult> {
  const parsedId = SprintIdSchema.safeParse(sprintId);
  if (!parsedId.success) return usage(`invalid sprint id: ${sprintId}\n`);

  const routing: Record<string, unknown> = {};
  if (opts.complexity !== undefined) {
    const parsed = ComplexityHintSchema.safeParse(opts.complexity);
    if (!parsed.success) {
      return usage('--complexity must be one of: trivial, standard, deep\n');
    }
    routing.complexity = parsed.data;
  }
  if (opts.preferTier !== undefined) {
    const parsed = TierNameSchema.safeParse(opts.preferTier);
    if (!parsed.success) return usage('--prefer-tier must be a valid tier name\n');
    routing.prefer_tier = parsed.data;
  }
  if (opts.pinTier !== undefined) {
    const parsed = TierNameSchema.safeParse(opts.pinTier);
    if (!parsed.success) return usage('--pin-tier must be a valid tier name\n');
    routing.pin_tier = parsed.data;
  }
  if (opts.fanout !== undefined) {
    const parsed = parseFanout(opts.fanout);
    if (!parsed.ok) return usage(`${parsed.error}\n`);
    routing.fanout = parsed.value;
  }
  if (Object.keys(routing).length === 0) {
    return usage('pass at least one of --complexity, --prefer-tier, --pin-tier, --fanout\n');
  }

  const located = await locateSprint(opts.cwd, parsedId.data);
  if (!located.ok) return located.result;

  const opRoot = await operationalRootBestEffort(located.cwd);
  await mutateSprintExtras(located.file, opRoot, (extras) => ({
    ...extras,
    routing: { ...(readRouting(extras) ?? {}), ...routing },
  }));

  return formatResult(
    {
      sprint_id: parsedId.data,
      file: located.file,
      routing: { ...(located.currentRouting ?? {}), ...routing },
    },
    opts.json === true,
  );
}

export async function runSprintRoutingClearCommand(
  sprintId: string,
  opts: SprintRoutingClearOptions,
): Promise<CommandResult> {
  const parsedId = SprintIdSchema.safeParse(sprintId);
  if (!parsedId.success) return usage(`invalid sprint id: ${sprintId}\n`);

  const located = await locateSprint(opts.cwd, parsedId.data);
  if (!located.ok) return located.result;

  const opRoot = await operationalRootBestEffort(located.cwd);
  await mutateSprintExtras(located.file, opRoot, (extras) => {
    const next = { ...extras };
    delete next.routing;
    return next;
  });

  return formatResult(
    { sprint_id: parsedId.data, file: located.file, routing: null },
    opts.json === true,
  );
}

type LocateResult =
  | { ok: true; cwd: string; file: string; currentRouting: Record<string, unknown> | null }
  | { ok: false; result: CommandResult };

async function locateSprint(cwdInput: string, sprintId: string): Promise<LocateResult> {
  const cwd = resolve(cwdInput);
  const outcome = await loadProject({ cwd }).catch((cause) => {
    throw cause instanceof RepoKernelError
      ? cause
      : new RepoKernelError(
          'IO_ERROR',
          `failed to load project: ${(cause as Error).message}`,
          cause,
        );
  });
  if (!outcome.ok) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: `project state is invalid; run rk validate first\n`,
      },
    };
  }
  const sprint = outcome.graph.sprints.get(sprintId);
  if (!sprint) {
    return {
      ok: false,
      result: { exitCode: EXIT_FINDINGS, stdout: '', stderr: `sprint not found: ${sprintId}\n` },
    };
  }
  return {
    ok: true,
    cwd,
    file: join(cwd, sprint.file),
    currentRouting: readRouting(sprint.extras),
  };
}

function readRouting(extras: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const routing = extras?.routing;
  return routing && typeof routing === 'object' && !Array.isArray(routing)
    ? (routing as Record<string, unknown>)
    : null;
}

type FanoutParseResult =
  | { ok: true; value: Array<{ id: string; tier: string }> }
  | { ok: false; error: string };

function parseFanout(raw: string): FanoutParseResult {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return { ok: false, error: '--fanout must contain at least one entry' };

  const out: Array<{ id: string; tier: string }> = [];
  for (const entry of entries) {
    const [id, tier, extra] = entry.split(':');
    if (!id || !tier || extra !== undefined) {
      return { ok: false, error: `invalid --fanout entry "${entry}" (expected id:tier)` };
    }
    const parsed = RoutingFanoutEntrySchema.safeParse({ id, tier });
    if (!parsed.success) {
      return { ok: false, error: `invalid --fanout entry "${entry}"` };
    }
    out.push(parsed.data);
  }
  return { ok: true, value: out };
}

function usage(stderr: string): CommandResult {
  return { exitCode: EXIT_USAGE, stdout: '', stderr };
}

function formatResult(result: RoutingMutationResult, json: boolean): CommandResult {
  if (json) {
    return { exitCode: EXIT_OK, stdout: `${emitJson(result)}\n`, stderr: '' };
  }
  if (result.routing === null) {
    return {
      exitCode: EXIT_OK,
      stdout: `${result.sprint_id}: routing metadata cleared\n`,
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: `${result.sprint_id}: routing metadata updated\n`,
    stderr: '',
  };
}
