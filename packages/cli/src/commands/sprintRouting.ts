import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ComplexityHintSchema,
  listMarkdownFiles,
  loadConfig,
  parseMarkdown,
  RepoKernelError,
  RoutingFanoutEntrySchema,
  SprintIdSchema,
  TierNameSchema,
  toErrorMessage,
} from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_USAGE } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { mutateSprintRouting, type Routing } from '../integrations/routingMetadata.js';
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
  readonly routing: Routing | null;
  readonly prior_routing: Routing | null;
}

export async function runSprintRoutingSetCommand(
  sprintId: string,
  opts: SprintRoutingSetOptions,
): Promise<CommandResult> {
  const parsedId = SprintIdSchema.safeParse(sprintId);
  if (!parsedId.success) return usage(`invalid sprint id: ${sprintId}\n`);

  const routing: Routing = {};
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

  const located = await locateSprintFile(opts.cwd, parsedId.data);
  if (!located.ok) return located.result;

  const opRoot = await operationalRootBestEffort(located.cwd);
  const result = await mutateSprintRouting(located.file, opRoot, (current) => ({
    ...(current ?? {}),
    ...routing,
  }));

  return formatResult(
    {
      sprint_id: parsedId.data,
      file: located.file,
      routing: result.next,
      prior_routing: result.prior,
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

  const located = await locateSprintFile(opts.cwd, parsedId.data);
  if (!located.ok) return located.result;

  const opRoot = await operationalRootBestEffort(located.cwd);
  const result = await mutateSprintRouting(located.file, opRoot, () => null);

  return formatResult(
    {
      sprint_id: parsedId.data,
      file: located.file,
      routing: null,
      prior_routing: result.prior,
    },
    opts.json === true,
  );
}

type LocateResult = { ok: true; cwd: string; file: string } | { ok: false; result: CommandResult };

/**
 * Lighter-weight sprint locator than `loadProject`. Routing edits are
 * structurally independent of the rest of the project graph, so a project
 * with unrelated findings (e.g. a missing review file in another sprint)
 * should not block a `rk sprint routing set` invocation against a healthy
 * sprint. We walk only the sprints directory and match on frontmatter id.
 */
async function locateSprintFile(cwdInput: string, sprintId: string): Promise<LocateResult> {
  const cwd = resolve(cwdInput);
  const cfg = await loadConfig({ cwd }).catch((cause) => {
    throw cause instanceof RepoKernelError
      ? cause
      : new RepoKernelError('IO_ERROR', `failed to load config: ${toErrorMessage(cause)}`, cause);
  });
  if (!cfg.ok) {
    return {
      ok: false,
      result: {
        exitCode: EXIT_FINDINGS,
        stdout: '',
        stderr: 'repokernel.config.yaml is missing or invalid; run rk init or rk validate.\n',
      },
    };
  }
  const sprintsDir = join(cwd, cfg.config.paths.sprints);
  const files = await listMarkdownFiles(cwd, sprintsDir);

  for (const relFile of files) {
    const absFile = join(cwd, relFile);
    const text = await readFile(absFile, 'utf8').catch(() => null);
    if (text === null) continue;
    const parsed = parseMarkdown(text);
    if (!parsed.ok) continue;
    if (parsed.parsed.data.id === sprintId) {
      return { ok: true, cwd, file: absFile };
    }
  }

  return {
    ok: false,
    result: { exitCode: EXIT_FINDINGS, stdout: '', stderr: `sprint not found: ${sprintId}\n` },
  };
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
    const prior = result.prior_routing
      ? ` (cleared ${Object.keys(result.prior_routing).join(', ')})`
      : '';
    return {
      exitCode: EXIT_OK,
      stdout: `${result.sprint_id}: routing metadata cleared${prior}\n`,
      stderr: '',
    };
  }
  return {
    exitCode: EXIT_OK,
    stdout: `${result.sprint_id}: routing metadata updated\n`,
    stderr: '',
  };
}
