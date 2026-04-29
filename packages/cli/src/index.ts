import { existsSync, statSync } from 'node:fs';
import {
  EPIC_ID_RE,
  type EpicStatus,
  findProjectRootSync,
  loadConfig,
  type ReviewVerdict,
  SEVERITY_RANK,
  type Severity,
  SeveritySchema,
  type SprintStatus,
} from '@repokernel/core';
import { Command } from 'commander';
import { runBoardCommand } from './commands/board.js';
import { runChainPreviewCommand } from './commands/chain.js';
import { runContextCommand } from './commands/context.js';
import {
  runCreateEpicCommand,
  runCreateQueueCommand,
  runCreateReviewCommand,
  runCreateSprintCommand,
} from './commands/create.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runEpicCloseCommand, runEpicMapCommand, runEpicStatusCommand } from './commands/epic.js';
import { runExplainCommand } from './commands/explain.js';
import {
  isTaskId,
  readTaskAlias,
  runCloseTaskCommand,
  runDiscardTaskCommand,
  runFastpathTask,
  runTaskInspectCommand,
  runTaskListCommand,
  runTaskStatusCommand,
  TASK_ID_RE,
  type TaskAlias,
} from './commands/fastpath/index.js';

type TaskAliasStatus = TaskAlias['status'];

import { runFixCommand } from './commands/fix.js';
import { runGateListCommand, runGateResolveCommand } from './commands/gate.js';
import { runHotfixCommand } from './commands/hotfix.js';
import { runInitCommand } from './commands/init.js';
import { runInspectCommand } from './commands/inspect.js';
import { runLaneAcquireCommand, runLaneReleaseCommand, runLanesCommand } from './commands/lanes.js';
import {
  runCancelCommand,
  runCloseCommand,
  runReopenCommand,
  runReviewCommand,
  runReviewVerdictCommand,
  runStartCommand,
} from './commands/lifecycle.js';
import {
  runLsEpicsCommand,
  runLsLanesCommand,
  runLsReviewsCommand,
  runLsSprintsCommand,
} from './commands/ls.js';
import {
  runNextCommand,
  runNextGenerateCommand,
  runNextSyncCommand,
  runNextValidateCommand,
} from './commands/next.js';
import { runOpenCommand } from './commands/open.js';
import { runQueueAddCommand } from './commands/queue.js';
import { runRegistryCommand } from './commands/registry.js';
import { runReviewAllocateCommand } from './commands/reviewAllocate.js';
import {
  runReviewPanelFindingsCommand,
  runReviewPanelRunCommand,
  runReviewPanelStatusCommand,
} from './commands/reviewPanel.js';
import { runReviewReconcileCommand } from './commands/reviewReconcile.js';
import { runReviewSprintCommand } from './commands/reviewSprint.js';
import {
  runRunAbortCommand,
  runRunCommand,
  runRunInspectCommand,
  runRunLogsCommand,
} from './commands/run.js';
import { runRunsCommand } from './commands/runs.js';
import { runStatusCommand } from './commands/status.js';
import { runValidateCommand } from './commands/validate.js';
import { EXIT_RUNTIME } from './exitCodes.js';
import { RK_VERSION } from './version.js';

interface GlobalOptions {
  readonly cwd?: string;
}

interface GateListOpts {
  readonly epic?: string;
  readonly json?: boolean;
}

interface GateResolveOpts {
  readonly epic?: string;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

interface ValidateOptions {
  readonly json?: boolean;
  readonly failOn?: string;
  readonly only?: string;
  readonly min?: string;
  readonly code?: string[];
  readonly entity?: string;
  readonly open?: boolean;
  readonly since?: string;
}

interface RegistryOptions {
  readonly json?: boolean;
  readonly write?: boolean;
  readonly check?: boolean;
  readonly out?: string;
}

interface StatusOptions {
  readonly json?: boolean;
}

interface NextOptions {
  readonly json?: boolean;
  readonly lane?: string;
  readonly epic?: string;
}

interface NextValidateOptions {
  readonly lane?: string;
  readonly json?: boolean;
}

interface NextGenerateOptions {
  readonly lane?: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

interface NextSyncOptions {
  readonly lane?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

interface InitOptions {
  readonly example?: boolean;
}

interface DoctorOptions {
  readonly json?: boolean;
  readonly fix?: boolean;
}

interface InspectOptions {
  readonly json?: boolean;
}

interface ExplainOptions {
  readonly json?: boolean;
}

interface ContextOptions {
  readonly profile?: string;
  readonly format?: string;
  readonly budget?: string;
  readonly check?: boolean;
  readonly validate?: boolean;
  readonly schema?: string;
  readonly withRouting?: boolean;
}

interface RouteOptions {
  readonly profile?: string;
}

interface FixOptions {
  readonly preview?: boolean;
  readonly apply?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly baseSha?: string;
  readonly sprint?: string;
}

interface CreateSprintOpts {
  readonly epic: string;
  readonly lane?: string;
  readonly status?: string;
  readonly after?: readonly string[];
  readonly allowedPath?: readonly string[];
  readonly deniedPath?: readonly string[];
  readonly adr?: readonly string[];
  readonly targetDate?: string;
  readonly bodyFile?: string;
  readonly skipIds?: readonly string[];
}

interface CreateQueueOpts {
  readonly lane: string;
}

interface CreateReviewOpts {
  readonly sprint: string;
  readonly reviewer?: string;
}

interface LsEpicsOpts {
  readonly status?: string;
  readonly json?: boolean;
}

interface LsSprintsOpts {
  readonly epic?: string;
  readonly status?: string;
  readonly lane?: string;
  readonly withDeps?: boolean;
  readonly json?: boolean;
}

interface LsReviewsOpts {
  readonly sprint?: string;
  readonly verdict?: string;
  readonly json?: boolean;
}

interface LsLanesOpts {
  readonly json?: boolean;
}

interface BoardOpts {
  readonly epic?: string;
  readonly lane?: string;
  readonly showCancelled?: boolean;
  readonly json?: boolean;
}

interface LanesOpts {
  readonly json?: boolean;
}

type ContextProfileLiteral = 'implement' | 'review' | 'wave';

function parseContextProfile(
  flag: string,
  input: string | undefined,
): ContextProfileLiteral | undefined {
  if (input === undefined) return undefined;
  if (input === 'implement' || input === 'review' || input === 'wave') return input;
  throw new Error(`invalid ${flag} value "${input}" (use implement|review|wave)`);
}

function parseContextFormat(flag: string, input: string): 'md' | 'json' {
  if (input === 'md' || input === 'json') return input;
  throw new Error(`invalid ${flag} value "${input}" (use md|json)`);
}

export function severityOrThrow(name: string, input: string | undefined): Severity | undefined {
  if (input === undefined) return undefined;
  const parsed = SeveritySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid ${name} value "${input}" (use P0|P1|P2|P3)`);
  }
  return parsed.data;
}

/**
 * Like severityOrThrow but accepts a comma-separated list (e.g. "P0,P1").
 *
 * Threshold semantics: --fail-on P1 already triggers on any P0 or P1 finding
 * (severities are an ordered scale). A comma list is collapsed to the least
 * severe entry (highest SEVERITY_RANK) so "P0,P1" is equivalent to "P1" and
 * "P0,P1,P2" is equivalent to "P2". Single-value input behaves identically to
 * severityOrThrow.
 */
export function severityFailOnOrThrow(
  name: string,
  input: string | undefined,
): Severity | undefined {
  if (input === undefined) return undefined;
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`invalid ${name} value "${input}" (use P0|P1|P2|P3 or comma list e.g. P0,P1)`);
  }
  const severities: Severity[] = [];
  for (const part of parts) {
    const parsed = SeveritySchema.safeParse(part);
    if (!parsed.success) {
      throw new Error(
        `invalid ${name} value "${input}" (use P0|P1|P2|P3 or comma list e.g. P0,P1)`,
      );
    }
    severities.push(parsed.data);
  }
  // The empty-list case is rejected above, so severities[0] is always defined.
  // Use it as an explicit initial value to avoid the "Reduce of empty array"
  // failure mode if a future refactor loosens the early-throw.
  const initial = severities[0];
  if (initial === undefined) {
    throw new Error(`invalid ${name} value "${input}" (use P0|P1|P2|P3 or comma list e.g. P0,P1)`);
  }
  return severities.reduce(
    (threshold, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[threshold] ? s : threshold),
    initial,
  );
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/**
 * Collector that also splits comma-separated values inside each occurrence.
 *
 * Lets users mix forms freely: `--flag a,b --flag c` becomes ['a','b','c'].
 * Trims whitespace and drops empty entries so `--flag a, , b` is equivalent to
 * `--flag a --flag b`.
 */
function collectCsvOption(value: string, previous: string[]): string[] {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...previous, ...parts];
}

function parsePositiveIntOption(
  name: string,
  value: string | undefined,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!/^[1-9]\d*$/.test(value)) {
    return { ok: false, message: `invalid ${name} value "${value}" (use a positive integer)` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `invalid ${name} value "${value}" (integer is too large)` };
  }
  return { ok: true, value: parsed };
}

function exitOptionError(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_RUNTIME);
}

/**
 * Resolve the starting cwd for an `rk` command. If a `repokernel.config.yaml`
 * exists in `startCwd` or any parent, return that project root so commands work
 * from any subdirectory of an initialized repo. If no config is found, return
 * `startCwd` unchanged (preserves current behavior for `rk init` and similar
 * not-yet-initialized commands).
 */
function resolveProjectCwd(startCwd: string): string {
  const found = findProjectRootSync(startCwd);
  return found?.cwd ?? startCwd;
}

/**
 * Detect when a positional `rk run` argument refers to a file on disk rather
 * than an epic id or a fastpath sentinel. Used to route to fastpath file mode
 * versus the existing epic-id flow.
 */
function isFilePathArg(arg: string): boolean {
  if (EPIC_ID_RE.test(arg)) return false;
  if (!existsSync(arg)) return false;
  try {
    return statSync(arg).isFile();
  } catch {
    return false;
  }
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('repokernel')
    .description('Local-first Git-native control plane for autonomous coding agents.')
    .version(RK_VERSION, '-v, --version', 'output the current version')
    .option('--cwd <path>', 'project root', process.cwd())
    .action(async (opts: GlobalOptions) => {
      const result = await runStatusCommand({
        cwd: resolveProjectCwd(opts.cwd ?? process.cwd()),
        json: false,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('validate')
    .description('validate the project state')
    .option('--json', 'emit JSON output', false)
    .option(
      '--fail-on <severity>',
      'severity threshold (P0|P1|P2|P3 or comma list e.g. P0,P1; the list collapses to the least-severe entry as the threshold, so P0,P1 is equivalent to P1)',
    )
    .option('--only <severity>', 'show only one severity (P0|P1|P2|P3)')
    .option('--min <severity>', 'show findings at or above severity (P0|P1|P2|P3)')
    .option('--code <code>', 'show only a finding code; repeatable', collectOption, [])
    .option('--entity <id>', 'show only findings for an entity id')
    .option('--open', 'open the first displayed finding file', false)
    .option(
      '--since <sha>',
      'display-only filter: only show findings whose file changed since <sha> (does NOT propagate to ship/close/run)',
    )
    .action(async (opts: ValidateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & ValidateOptions>();
      const cwd = resolveProjectCwd(globals.cwd ?? process.cwd());
      const failOn = severityFailOnOrThrow('--fail-on', opts.failOn);
      const only = severityOrThrow('--only', opts.only);
      const min = severityOrThrow('--min', opts.min);
      const result = await runValidateCommand({
        cwd,
        json: opts.json === true,
        open: opts.open === true,
        runtimeVersion: RK_VERSION,
        ...(failOn !== undefined ? { failOn } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        filters: {
          ...(only !== undefined ? { only } : {}),
          ...(min !== undefined ? { min } : {}),
          ...(opts.code !== undefined && opts.code.length > 0 ? { codes: opts.code } : {}),
          ...(opts.entity !== undefined ? { entity: opts.entity } : {}),
        },
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('status')
    .description('summarize project health and next runnable sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: StatusOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & StatusOptions>();
      const cwd = resolveProjectCwd(globals.cwd ?? process.cwd());
      const result = await runStatusCommand({ cwd, json: opts.json === true });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  const nextCmd = program
    .command('next')
    .description('resolve the next runnable sprint (or manage NEXT.md)')
    .option('--json', 'emit JSON output', false)
    .option('--lane <lane>', 'lane name (defaults to policies.defaultLane)')
    .option(
      '--epic <id>',
      'restrict resolution to sprints belonging to this epic; warns if epic.sprints references a missing sprint file',
    )
    .action(async (opts: NextOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & NextOptions>();
      const cwd = resolveProjectCwd(globals.cwd ?? process.cwd());
      const result = await runNextCommand({
        cwd,
        json: opts.json === true,
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  nextCmd
    .command('validate')
    .description('validate NEXT.md slot consistency against the queue')
    .option('--lane <lane>', 'filter drift findings to a specific lane')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: NextValidateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & NextValidateOptions>();
      const result = await runNextValidateCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  nextCmd
    .command('generate')
    .description('write NEXT.md from current queue state')
    .option('--lane <lane>', 'lane name (defaults to policies.defaultLane)')
    .option('--force', 'overwrite existing NEXT.md without confirmation', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: NextGenerateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & NextGenerateOptions>();
      const result = await runNextGenerateCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        force: opts.force === true,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  nextCmd
    .command('sync')
    .description('reorder queue to match NEXT.md slot order')
    .option('--lane <lane>', 'lane name (defaults to NEXT.md lane field)')
    .option('--dry-run', 'show what would change without writing', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: NextSyncOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & NextSyncOptions>();
      const result = await runNextSyncCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        dryRun: opts.dryRun === true,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('doctor')
    .description('diagnose RepoKernel setup problems')
    .option('--json', 'emit JSON output', false)
    .option('--fix', 'auto-create missing generated directories', false)
    .action(async (opts: DoctorOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & DoctorOptions>();
      const result = await runDoctorCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json === true,
        fix: opts.fix === true,
        runtimeVersion: RK_VERSION,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('init')
    .description('initialize RepoKernel project files')
    .option('--example', 'create a working starter project', false)
    .action(async (opts: InitOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & InitOptions>();
      // rk init must NOT walk up — initialize at the caller's actual cwd, not
      // a parent project root if one happens to exist.
      const result = await runInitCommand({
        cwd: globals.cwd ?? process.cwd(),
        example: opts.example === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('inspect <id>')
    .description('show a human-readable entity view')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: InspectOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & InspectOptions>();
      const result = await runInspectCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        id,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('context [target]')
    .description('compile a deterministic context packet for a sprint or epic')
    .option(
      '--profile <profile>',
      'implement | review | wave (defaults: S-NNN→implement, E-NNN→wave)',
    )
    .option('--format <format>', 'md | json', 'md')
    .option('--budget <tokens>', 'override profile budget (positive integer)')
    .option('--check', 'exit non-zero if rendered packet exceeds effective budget', false)
    .option('--validate', 'run full validators (default uses parse findings only)', false)
    .option('--schema <profile>', 'emit JSON Schema for the named profile and exit')
    .option(
      '--with-routing',
      'embed a routing_hint (recommended tier + signals) in the packet',
      false,
    )
    .action(async (target: string | undefined, opts: ContextOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & ContextOptions>();
      const profile = parseContextProfile('--profile', opts.profile);
      const format = parseContextFormat('--format', opts.format ?? 'md');
      const schema = parseContextProfile('--schema', opts.schema);
      let budget: number | undefined;
      if (opts.budget !== undefined) {
        const parsedBudget = parsePositiveIntOption('--budget', opts.budget);
        if (!parsedBudget.ok) exitOptionError(parsedBudget.message);
        budget = parsedBudget.value;
      }
      const result = await runContextCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(target !== undefined ? { target } : {}),
        ...(profile !== undefined ? { profile } : {}),
        format,
        ...(budget !== undefined ? { budget } : {}),
        check: opts.check === true,
        validate: opts.validate === true,
        ...(schema !== undefined ? { schema } : {}),
        withRouting: opts.withRouting === true,
        runtimeVersion: RK_VERSION,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('route <target>')
    .description(
      'recommend a cost-aware agent tier for a sprint (S-NNN) or epic (E-NNN) — JSON only',
    )
    .option(
      '--profile <profile>',
      'implement | review | wave (defaults: S-NNN→implement, E-NNN→wave)',
    )
    .action(async (target: string, opts: RouteOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & RouteOptions>();
      const profile = parseContextProfile('--profile', opts.profile);
      const result = await runContextCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        target,
        ...(profile !== undefined ? { profile } : {}),
        format: 'json',
        check: false,
        validate: false,
        withRouting: true,
        routingOnly: true,
        runtimeVersion: RK_VERSION,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('explain <code>')
    .description('explain a validation code')
    .option('--json', 'emit JSON output', false)
    .action((code: string, opts: ExplainOptions) => {
      const result = runExplainCommand({ code, json: opts.json === true });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('open <id>')
    .description('open an entity source file')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runOpenCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        id,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('fix')
    .description('preview or apply safe mechanical fixes')
    .option('--preview', 'show safe fixes without applying them', false)
    .option('--apply', 'apply all detected safe fixes', false)
    .option('--yes', 'skip the confirmation prompt under --apply (CI use)', false)
    .option('--json', 'emit JSON output', false)
    .option(
      '--base-sha <sha>',
      'operator-asserted SHA to set on a shipped sprint missing base_sha (paired with --sprint)',
    )
    .option('--sprint <id>', 'sprint id this --base-sha applies to')
    .action(async (opts: FixOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & FixOptions>();
      const result = await runFixCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        preview: opts.preview === true,
        apply: opts.apply === true,
        yes: opts.yes === true,
        json: opts.json === true,
        ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
        ...(opts.sprint !== undefined ? { sprint: opts.sprint } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('registry')
    .description('generate, write, or check the project registry')
    .option('--json', 'emit JSON output', false)
    .option('--write', 'write the registry file', false)
    .option('--check', 'check the registry file for drift', false)
    .option(
      '--out <path>',
      'write to this path instead of config path (one-off; only with --write)',
    )
    .action(async (opts: RegistryOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & RegistryOptions>();
      const cwd = resolveProjectCwd(globals.cwd ?? process.cwd());
      const result = await runRegistryCommand({
        cwd,
        write: opts.write === true,
        check: opts.check === true,
        json: opts.json === true,
        ...(opts.out !== undefined ? { out: opts.out } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — lifecycle commands —

  program
    .command('start <id>')
    .description('start a queued or reopened sprint')
    .option('--force', 'allow starting a planned or pending sprint', false)
    .option(
      '--enqueue',
      'if status is planned, queue the sprint into its lane and start it in one step',
      false,
    )
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        id: string,
        opts: { force: boolean; enqueue: boolean; dryRun: boolean; json: boolean },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runStartCommand(id, {
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          force: opts.force,
          enqueue: opts.enqueue,
          dryRun: opts.dryRun,
          json: opts.json,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  program
    .command('review <id>')
    .description('move an active sprint to review status')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runReviewCommand(id, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('review-verdict <review-id> <verdict>')
    .description('set a review verdict (accepted|changes_requested|rejected)')
    .option('--summary <text>', 'short note added as a finding')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        reviewId: string,
        verdict: string,
        opts: { summary?: string; dryRun: boolean; json: boolean },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runReviewVerdictCommand(reviewId, verdict, {
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
          dryRun: opts.dryRun,
          json: opts.json,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  program
    .command('close [id]')
    .description(
      'close a task or sprint (T-NNN → fastpath close; S-NNN → sprint close; no arg → unique task in review)',
    )
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (id: string | undefined, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const cwd = resolveProjectCwd(globals.cwd ?? process.cwd());

        const isTaskTarget = id === undefined || isTaskId(id);
        if (isTaskTarget) {
          const result = await runCloseTaskCommand({
            cwd,
            ...(id !== undefined ? { taskId: id } : {}),
            dryRun: opts.dryRun,
            json: opts.json,
          });
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          process.exit(result.exitCode);
        }

        // Existing flow: id refers to a sprint (S-NNN).
        const result = await runCloseCommand(id as string, {
          cwd,
          dryRun: opts.dryRun,
          json: opts.json,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  program
    .command('discard [id]')
    .description('cancel a fastpath task and release its worktree (no merge)')
    .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const cwd = resolveProjectCwd(globals.cwd ?? process.cwd());
      const result = await runDiscardTaskCommand({
        cwd,
        ...(id !== undefined ? { taskId: id } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('reopen <id>')
    .description('reopen a review or shipped sprint')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runReopenCommand(id, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('cancel <id>')
    .description(
      'cancel a non-terminal sprint (any status except shipped/cancelled); frees the lane without running review',
    )
    .option('--reason <text>', 'short note recorded in cancel_reason')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        id: string,
        opts: { reason?: string; dryRun: boolean; json: boolean },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runCancelCommand(id, {
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          dryRun: opts.dryRun,
          json: opts.json,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  // — queue commands —

  const queueCmd = program.command('queue').description('manage sprint queues');

  queueCmd
    .command('add <id>')
    .description('add a sprint to a lane queue')
    .requiredOption('--lane <name>', 'lane name')
    .option('--force', 'allow queuing a pending sprint', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (id: string, opts: { lane: string; force: boolean; json: boolean }, cmd: Command) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runQueueAddCommand(id, {
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          lane: opts.lane,
          force: opts.force,
          json: opts.json,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  // — epic commands —

  const epicCmd = program.command('epic').description('inspect epic status and sprint map');

  epicCmd
    .command('status <id>')
    .description('show epic progress and sprint status summary')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runEpicStatusCommand(id, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  epicCmd
    .command('ls')
    .description('list all epics with progress')
    .option('--status <status>', 'filter by epic status (planned|active|on_hold|done|cancelled)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsEpicsOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLsEpicsCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.status !== undefined ? { status: opts.status as EpicStatus } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  epicCmd
    .command('map <id>')
    .description('show sprint pipeline for an epic')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runEpicMapCommand(id, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  epicCmd
    .command('close <id>')
    .description('mark an epic as done (all sprints must be shipped or cancelled)')
    .option('--dry-run', 'preview the mutation without writing files', false)
    .option('--force', 'close even if some sprints are not yet shipped', false)
    .option(
      '--run-checks',
      'run check command before closing (uses automation.checksCmd from config)',
      false,
    )
    .option(
      '--checks-cmd <cmd>',
      'check command to run (overrides automation.checksCmd from config)',
    )
    .action(
      async (
        id: string,
        opts: { dryRun: boolean; force: boolean; runChecks: boolean; checksCmd?: string },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runEpicCloseCommand(id, {
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          dryRun: opts.dryRun,
          force: opts.force,
          runChecks: opts.runChecks ?? false,
          ...(opts.checksCmd !== undefined ? { checksCmd: opts.checksCmd } : {}),
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  // — sprint commands —

  const sprintCmd = program.command('sprint').description('inspect sprint lists');

  sprintCmd
    .command('ls')
    .description('list sprints with optional filters')
    .option('--epic <id>', 'filter by epic ID (E-NNN)')
    .option('--status <status>', 'filter by sprint status')
    .option('--lane <lane>', 'filter by lane name')
    .option('--with-deps', 'show depends_on column', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsSprintsOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLsSprintsCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        ...(opts.status !== undefined ? { status: opts.status as SprintStatus } : {}),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        withDeps: opts.withDeps === true,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — task (fastpath alias) commands —

  const taskCmd = program.command('task').description('inspect fastpath task aliases (T-NNN)');

  taskCmd
    .command('list')
    .description('list fastpath task aliases')
    .option('--status <status>', 'filter by task status (active|review|shipped|cancelled)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { status?: string; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runTaskListCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.status !== undefined ? { status: opts.status as TaskAliasStatus } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  taskCmd
    .command('status <id>')
    .description('show the status of a fastpath task alias')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runTaskStatusCommand(id, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  taskCmd
    .command('inspect <id>')
    .description('show full alias plus resolved sprint/review file paths')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runTaskInspectCommand(id, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — chain commands —

  const chainCmd = program.command('chain').description('preview sprint chain execution');

  chainCmd
    .command('preview')
    .description('show what sprints would run in a chain')
    .option('--lane <lane>', 'lane name')
    .option('--epic <id>', 'restrict the chain to sprints belonging to a specific epic')
    .option('--limit <n>', 'max sprints to show', '5')
    .option('--ignore-disabled', 'show preview even if chaining is disabled', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        opts: {
          lane?: string;
          epic?: string;
          limit: string;
          ignoreDisabled: boolean;
          json: boolean;
        },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const limit = parsePositiveIntOption('--limit', opts.limit);
        if (!limit.ok) exitOptionError(limit.message);
        const result = await runChainPreviewCommand({
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
          ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
          limit: limit.value ?? 5,
          ignoreDisabled: opts.ignoreDisabled,
          json: opts.json,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  const createCmd = program
    .command('create')
    .description('create a planning entity (epic, sprint, queue, review)');

  createCmd
    .command('epic <title>')
    .description('scaffold a new epic')
    .action(async (title: string, _opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runCreateEpicCommand(title, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  createCmd
    .command('sprint <title>')
    .description('scaffold a new sprint')
    .requiredOption('--epic <id>', 'parent epic ID (E-NNN)')
    .option('--lane <lane>', 'lane name', 'main')
    .option('--status <status>', 'initial status (planned|pending)', 'planned')
    .option(
      '--after <sprintId>',
      'add a depends_on edge; repeatable, also accepts comma-separated values',
      collectCsvOption,
      [],
    )
    .option(
      '--allowed-path <glob>',
      'declare an allowed path glob; repeatable',
      collectCsvOption,
      [],
    )
    .option('--denied-path <glob>', 'declare a denied path glob; repeatable', collectCsvOption, [])
    .option('--adr <ref>', 'link an ADR (e.g. ADR-049); repeatable', collectCsvOption, [])
    .option('--target-date <yyyy-mm-dd>', 'set target_date frontmatter field')
    .option('--body-file <path>', 'read sprint body markdown from a file (no frontmatter)')
    .option(
      '--skip-ids <sprintId>',
      'sprint IDs to reserve as gaps; repeatable, also accepts comma-separated values',
      collectCsvOption,
      [],
    )
    .action(async (title: string, _opts: CreateSprintOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & CreateSprintOpts>();
      const result = await runCreateSprintCommand(title, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        epic: globals.epic,
        lane: globals.lane ?? 'main',
        status: globals.status ?? 'planned',
        ...(globals.after !== undefined && globals.after.length > 0
          ? { after: globals.after }
          : {}),
        ...(globals.allowedPath !== undefined && globals.allowedPath.length > 0
          ? { allowedPaths: globals.allowedPath }
          : {}),
        ...(globals.deniedPath !== undefined && globals.deniedPath.length > 0
          ? { deniedPaths: globals.deniedPath }
          : {}),
        ...(globals.adr !== undefined && globals.adr.length > 0 ? { adrLinks: globals.adr } : {}),
        ...(globals.targetDate !== undefined ? { targetDate: globals.targetDate } : {}),
        ...(globals.bodyFile !== undefined ? { bodyFile: globals.bodyFile } : {}),
        ...(globals.skipIds !== undefined && globals.skipIds.length > 0
          ? { skipIds: globals.skipIds }
          : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  createCmd
    .command('queue')
    .description('scaffold a queue file for a lane')
    .requiredOption('--lane <name>', 'lane name')
    .action(async (_opts: CreateQueueOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & CreateQueueOpts>();
      const result = await runCreateQueueCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        lane: globals.lane,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  createCmd
    .command('review')
    .description('scaffold a review for a sprint')
    .requiredOption('--sprint <id>', 'sprint ID (S-NNN)')
    .option('--reviewer <name>', 'reviewer name', 'agent')
    .action(async (_opts: CreateReviewOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & CreateReviewOpts>();
      const result = await runCreateReviewCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        sprint: globals.sprint,
        reviewer: globals.reviewer ?? 'agent',
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — board command —

  program
    .command('board')
    .description('show kanban board across sprint statuses')
    .option('--epic <id>', 'filter by epic ID')
    .option('--lane <lane>', 'filter by lane name')
    .option('--show-cancelled', 'include cancelled sprints column', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: BoardOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runBoardCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        showCancelled: opts.showCancelled === true,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — lanes command —

  const laneCmd = program.command('lane').description('manage epic lanes and worktrees');

  laneCmd
    .command('ls')
    .alias('list')
    .description('show lane health overview')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LanesOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLanesCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  laneCmd
    .command('acquire <epic-id>')
    .description('acquire a worktree and lane claim for an epic')
    .option('--force', 'override existing lane claim', false)
    .option(
      '--allow-dirty',
      'allow acquiring a worktree even when the main tree has uncommitted changes',
      false,
    )
    .action(async (epicId: string, opts: { force: boolean; allowDirty: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLaneAcquireCommand(epicId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        force: opts.force,
        allowDirty: opts.allowDirty,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  laneCmd
    .command('release <epic-id>')
    .description('release worktree and lane claim for an epic')
    .option('--force', 'release even if worktree has uncommitted changes', false)
    .action(async (epicId: string, opts: { force: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLaneReleaseCommand(epicId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        force: opts.force,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // keep backward-compat alias
  program
    .command('lanes')
    .description('show lane health overview (alias for rk lane ls)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LanesOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLanesCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — gate commands —

  const gateCmd = program.command('gate').description('manage sprint gates (human checkpoints)');

  gateCmd
    .command('ls')
    .alias('list')
    .description('list all active gates and the sprints they block')
    .option('--epic <id>', 'filter by epic ID')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: GateListOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runGateListCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.epic !== undefined ? { epicId: opts.epic } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  gateCmd
    .command('resolve <gate-name>')
    .description('resolve a gate, unblocking sprints for execution')
    .option('--epic <id>', 'scope resolution to a specific epic')
    .option('--force', 'skip precondition check (upstream sprints not yet shipped)', false)
    .option('--dry-run', 'show what would change without writing', false)
    .action(async (gateName: string, opts: GateResolveOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runGateResolveCommand(gateName, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.epic !== undefined ? { epicId: opts.epic } : {}),
        force: opts.force === true,
        dryRun: opts.dryRun === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — ls commands —

  const lsCmd = program.command('ls').description('list project entities');

  lsCmd
    .command('epics')
    .description('list all epics with progress')
    .option('--status <status>', 'filter by epic status (planned|active|on_hold|done|cancelled)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsEpicsOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLsEpicsCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.status !== undefined ? { status: opts.status as EpicStatus } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  lsCmd
    .command('sprints')
    .description('list sprints with optional filters')
    .option('--epic <id>', 'filter by epic ID (E-NNN)')
    .option('--status <status>', 'filter by sprint status')
    .option('--lane <lane>', 'filter by lane name')
    .option('--with-deps', 'show depends_on column', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsSprintsOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLsSprintsCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        ...(opts.status !== undefined ? { status: opts.status as SprintStatus } : {}),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        withDeps: opts.withDeps === true,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  lsCmd
    .command('reviews')
    .description('list reviews with optional filters')
    .option('--sprint <id>', 'filter by sprint ID (S-NNN)')
    .option(
      '--verdict <verdict>',
      'filter by verdict (pending|accepted|changes_requested|rejected)',
    )
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsReviewsOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLsReviewsCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.sprint !== undefined ? { sprint: opts.sprint } : {}),
        ...(opts.verdict !== undefined ? { verdict: opts.verdict as ReviewVerdict } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  lsCmd
    .command('lanes')
    .description('list lanes with queue and active sprint info')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsLanesOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLsLanesCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — run orchestrator —

  const runCmd = program
    .command('run [target]')
    .description(
      'run a coding task in an isolated worktree (no arg → editor; -m → inline; <file> → file; <E-NNN> → existing epic)',
    )
    .option(
      '--agent <name>',
      'agent runner (defaults to config automation.defaultAgent; built-ins: manual|fake|claude|codex)',
    )
    .option('--mode <mode>', 'execution mode (assisted|autonomous)', 'assisted')
    .option('--lane <name>', 'sprint queue lane to run (default: config defaultLane)')
    .option('--limit <n>', 'max sprints to execute in this run')
    .option('--resume <run-id>', 'resume a paused or failed run')
    .option('--worktree', 'create isolated git worktree (default: true)', true)
    .option('--no-worktree', 'skip worktree creation, use current checkout')
    .option('--dry-run', 'preview chain without executing', false)
    .option(
      '--parallel',
      'assert parallel execution (epic must declare execution_strategy: parallel)',
      false,
    )
    .option('--sequential', 'force sequential execution even if epic declares parallel', false)
    .option('--concurrency <n>', 'max concurrent sprints per wave (clamped to epic.parallel_limit)')
    .option(
      '--allow-overlap',
      'allow overlapping allowed_paths (requires parallel.allowOverlapFlag: true in config)',
      false,
    )
    .option('-m, --message <text>', 'inline task description (skips editor)')
    .option('--stdin', 'read task description from stdin', false)
    .action(
      async (
        target: string | undefined,
        opts: {
          agent?: string;
          mode: string;
          lane?: string;
          limit?: string;
          resume?: string;
          worktree: boolean;
          dryRun: boolean;
          parallel: boolean;
          sequential: boolean;
          concurrency?: string;
          allowOverlap: boolean;
          message?: string;
          stdin: boolean;
        },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const cwd = resolveProjectCwd(globals.cwd ?? process.cwd());

        // `rk run T-NNN` resolves the task alias to its underlying epic and
        // routes through the existing epic-driven flow. This is the recovery
        // path for a task whose previous run halted — the same form printed
        // in error suggestions.
        let resolvedTarget = target;
        if (resolvedTarget !== undefined && TASK_ID_RE.test(resolvedTarget)) {
          const cfg = await loadConfig({ cwd });
          if (!cfg.ok) {
            process.stderr.write('error: repokernel.config.yaml not found; run rk init first\n');
            process.exit(EXIT_RUNTIME);
          }
          const alias = await readTaskAlias(cwd, cfg.config, resolvedTarget as `T-${string}`);
          if (!alias) {
            process.stderr.write(
              `error: no task alias found for ${resolvedTarget} — run \`rk task list\` to see available tasks\n`,
            );
            process.exit(EXIT_RUNTIME);
          }
          if (alias.status === 'shipped') {
            process.stderr.write(
              `error: task ${resolvedTarget} is already shipped — nothing to retry\n`,
            );
            process.exit(EXIT_RUNTIME);
          }
          if (alias.status === 'cancelled') {
            process.stderr.write(
              `error: task ${resolvedTarget} was cancelled — recreate it with \`rk run -m "..."\` instead of retrying\n`,
            );
            process.exit(EXIT_RUNTIME);
          }
          resolvedTarget = alias.epic_id;
        }

        // Decide whether to take the fastpath (single-task, ad-hoc) or the
        // existing epic-driven flow. The existing flow wins whenever the user
        // passes an explicit E-NNN, --resume, --parallel, or --concurrency,
        // because those signals are meaningless for one-task fastpath runs.
        const isExplicitEpic = resolvedTarget !== undefined && EPIC_ID_RE.test(resolvedTarget);
        const isResume = opts.resume !== undefined;
        const usesEpicOnlyFlags =
          opts.parallel === true || opts.concurrency !== undefined || opts.allowOverlap === true;

        const isExistingFlow = isExplicitEpic || isResume || usesEpicOnlyFlags;

        if (!isExistingFlow) {
          const fastpathInputDetected =
            resolvedTarget !== undefined || opts.message !== undefined || opts.stdin === true;

          // No epic AND no fastpath input → editor mode (the friendly default).
          if (
            !fastpathInputDetected ||
            resolvedTarget === undefined ||
            isFilePathArg(resolvedTarget)
          ) {
            // --lane and --limit are epic-driven concepts; a single ad-hoc task
            // synthesizes its own epic+sprint+lane and runs exactly one sprint.
            // Reject loudly so the user notices the flag had no effect.
            if (opts.lane !== undefined) {
              process.stderr.write(
                'error: --lane has no meaning for a single ad-hoc task. Drop the flag, or pass an epic id (rk run E-NNN --lane ...).\n',
              );
              process.exit(EXIT_RUNTIME);
            }
            if (opts.limit !== undefined) {
              process.stderr.write(
                'error: --limit has no meaning for a single ad-hoc task. Drop the flag, or pass an epic id (rk run E-NNN --limit ...).\n',
              );
              process.exit(EXIT_RUNTIME);
            }
            const filePath =
              resolvedTarget !== undefined && isFilePathArg(resolvedTarget)
                ? resolvedTarget
                : undefined;
            const result = await runFastpathTask({
              cwd,
              ...(opts.message !== undefined ? { inlineMessage: opts.message } : {}),
              readFromStdin: opts.stdin === true,
              ...(filePath !== undefined ? { filePath } : {}),
              ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
              mode: (opts.mode === 'autonomous' ? 'autonomous' : 'assisted') as
                | 'assisted'
                | 'autonomous',
              noWorktree: opts.worktree === false,
              dryRun: opts.dryRun === true,
            });
            if (result.stdout) process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            process.exit(result.exitCode);
          }

          if (
            resolvedTarget !== undefined &&
            !EPIC_ID_RE.test(resolvedTarget) &&
            !isFilePathArg(resolvedTarget)
          ) {
            process.stderr.write(
              `error: "${resolvedTarget}" is neither an epic id (E-NNN) nor an existing file path\n` +
                '  → did you mean: rk run -m "..." or rk run path/to/task.md or rk run E-001?\n',
            );
            process.exit(EXIT_RUNTIME);
          }
        }

        // — existing epic-driven flow (unchanged) —
        const limit = parsePositiveIntOption('--limit', opts.limit);
        if (!limit.ok) exitOptionError(limit.message);
        const concurrency = parsePositiveIntOption('--concurrency', opts.concurrency);
        if (!concurrency.ok) exitOptionError(concurrency.message);
        const result = await runRunCommand({
          cwd,
          ...(resolvedTarget !== undefined ? { epicId: resolvedTarget } : {}),
          ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
          ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          mode: (opts.mode === 'autonomous' ? 'autonomous' : 'assisted') as
            | 'assisted'
            | 'autonomous',
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
          worktree: opts.worktree,
          dryRun: opts.dryRun,
          parallel: opts.parallel,
          sequential: opts.sequential,
          ...(concurrency.value !== undefined ? { concurrency: concurrency.value } : {}),
          allowOverlap: opts.allowOverlap,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  runCmd
    .command('inspect <run-id>')
    .description('show run state and actionable next steps')
    .option('--json', 'emit JSON output', false)
    .action(async (runId: string, opts: { json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runRunInspectCommand(runId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  runCmd
    .command('logs <run-id> [sprint-id]')
    .description('show logs for a run (optionally scoped to a sprint)')
    .action(async (runId: string, sprintId: string | undefined, _opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runRunLogsCommand(runId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(sprintId !== undefined ? { sprintId } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  runCmd
    .command('abort <run-id>')
    .description('abort an active or paused run')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runRunAbortCommand(runId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — review-panel commands —

  const reviewPanelCmd = program
    .command('review-panel')
    .description('run and inspect multi-reviewer quality panels');

  reviewPanelCmd
    .command('run <sprint-id>')
    .description('run (or re-run) the review panel for a sprint')
    .option('--dry-run', 'show what would run without executing', false)
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runReviewPanelRunCommand(sprintId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  reviewPanelCmd
    .command('status <sprint-id>')
    .description('show panel run history for a sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runReviewPanelStatusCommand(sprintId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  reviewPanelCmd
    .command('findings <sprint-id>')
    .description('show findings from the latest panel run')
    .option('--min-severity <sev>', 'minimum severity to show (P0|P1|P2|P3)')
    .option('--json', 'emit JSON output', false)
    .action(
      async (sprintId: string, opts: { minSeverity?: string; json: boolean }, cmd: Command) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runReviewPanelFindingsCommand(sprintId, {
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          ...(opts.minSeverity !== undefined ? { minSeverity: opts.minSeverity } : {}),
          json: opts.json,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  program
    .command('review-allocate')
    .description(
      'allocate one or more review IDs atomically (uses the same locked allocator rk run uses)',
    )
    .option(
      '--sprint <id>',
      'sprint ID needing a review allocation; repeatable',
      collectCsvOption,
      [],
    )
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { sprint: string[]; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runReviewAllocateCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        sprintIds: opts.sprint,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('review-reconcile')
    .description('detect (and optionally repair) broken sprint→review pointers')
    .option('--apply', 'allocate fresh review IDs and rewrite affected sprint frontmatter', false)
    .option('--epic <id>', 'restrict reconciliation to one epic')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { apply: boolean; epic?: string; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runReviewReconcileCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        apply: opts.apply === true,
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('hotfix <description>')
    .description('record an out-of-band hotfix as a fastpath task (T-NNN)')
    .option('--ac <criterion>', 'acceptance criterion; repeatable', collectCsvOption, [])
    .option('--deny <glob>', 'denied path glob; repeatable', collectCsvOption, [])
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        description: string,
        opts: { ac: string[]; deny: string[]; json: boolean },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runHotfixCommand({
          cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
          description,
          acceptanceCriteria: opts.ac,
          denyPaths: opts.deny,
          json: opts.json === true,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        process.exit(result.exitCode);
      },
    );

  program
    .command('review-sprint <sprint-id>')
    .description('evaluate quality rules for a sprint and set review verdict')
    .option('--dry-run', 'show what verdict would be set without writing', false)
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runReviewSprintCommand(sprintId, {
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        dryRun: opts.dryRun === true,
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('runs')
    .description('list agent runs')
    .option('--status <status>', 'filter by status (running|paused|completed|failed|aborted)')
    .option('--epic <id>', 'filter by epic ID')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { status?: string; epic?: string; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runRunsCommand({
        cwd: resolveProjectCwd(globals.cwd ?? process.cwd()),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  return program;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(EXIT_RUNTIME);
  }
}

const isEntry = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const url = new URL(`file://${argv1}`).href;
    // import.meta.url comparison (ESM)
    return url === (import.meta as { url?: string }).url;
  } catch {
    return false;
  }
})();

if (isEntry) {
  void main(process.argv.slice(2));
}
