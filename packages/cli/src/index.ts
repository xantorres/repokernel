import {
  type EpicStatus,
  type ReviewVerdict,
  type Severity,
  SeveritySchema,
  type SprintStatus,
} from '@repokernel/core';
import { Command } from 'commander';
import { runBoardCommand } from './commands/board.js';
import { runChainPreviewCommand } from './commands/chain.js';
import {
  runCreateEpicCommand,
  runCreateQueueCommand,
  runCreateReviewCommand,
  runCreateSprintCommand,
} from './commands/create.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runEpicMapCommand, runEpicStatusCommand } from './commands/epic.js';
import { runExplainCommand } from './commands/explain.js';
import { runFixCommand } from './commands/fix.js';
import { runInitCommand } from './commands/init.js';
import { runInspectCommand } from './commands/inspect.js';
import { runLaneAcquireCommand, runLaneReleaseCommand, runLanesCommand } from './commands/lanes.js';
import {
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
import { runNextCommand } from './commands/next.js';
import { runOpenCommand } from './commands/open.js';
import { runQueueAddCommand } from './commands/queue.js';
import { runRegistryCommand } from './commands/registry.js';
import { runRunCommand } from './commands/run.js';
import { runRunsCommand } from './commands/runs.js';
import { runStatusCommand } from './commands/status.js';
import { runValidateCommand } from './commands/validate.js';
import { EXIT_RUNTIME } from './exitCodes.js';

interface GlobalOptions {
  readonly cwd?: string;
}

interface ValidateOptions {
  readonly json?: boolean;
  readonly failOn?: string;
  readonly only?: string;
  readonly min?: string;
  readonly code?: string[];
  readonly entity?: string;
  readonly open?: boolean;
}

interface RegistryOptions {
  readonly json?: boolean;
  readonly write?: boolean;
  readonly check?: boolean;
}

interface StatusOptions {
  readonly json?: boolean;
}

interface NextOptions {
  readonly json?: boolean;
  readonly lane?: string;
}

interface InitOptions {
  readonly example?: boolean;
}

interface DoctorOptions {
  readonly json?: boolean;
}

interface InspectOptions {
  readonly json?: boolean;
}

interface ExplainOptions {
  readonly json?: boolean;
}

interface FixOptions {
  readonly preview?: boolean;
  readonly json?: boolean;
}

interface CreateSprintOpts {
  readonly epic: string;
  readonly lane?: string;
  readonly status?: string;
  readonly after?: string;
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

function severityOrThrow(name: string, input: string | undefined): Severity | undefined {
  if (input === undefined) return undefined;
  const parsed = SeveritySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid ${name} value "${input}" (use P0|P1|P2|P3)`);
  }
  return parsed.data;
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
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

export function createProgram(): Command {
  const program = new Command();
  program
    .name('repokernel')
    .description('Local-first, Git-native correctness engine for AI coding workflows.')
    .option('--cwd <path>', 'project root', process.cwd())
    .action(async (opts: GlobalOptions) => {
      const result = await runStatusCommand({ cwd: opts.cwd ?? process.cwd(), json: false });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('validate')
    .description('validate the project state')
    .option('--json', 'emit JSON output', false)
    .option('--fail-on <severity>', 'severity threshold (P0|P1|P2|P3)')
    .option('--only <severity>', 'show only one severity (P0|P1|P2|P3)')
    .option('--min <severity>', 'show findings at or above severity (P0|P1|P2|P3)')
    .option('--code <code>', 'show only a finding code; repeatable', collectOption, [])
    .option('--entity <id>', 'show only findings for an entity id')
    .option('--open', 'open the first displayed finding file', false)
    .action(async (opts: ValidateOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & ValidateOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const failOn = severityOrThrow('--fail-on', opts.failOn);
      const only = severityOrThrow('--only', opts.only);
      const min = severityOrThrow('--min', opts.min);
      const result = await runValidateCommand({
        cwd,
        json: opts.json === true,
        open: opts.open === true,
        ...(failOn !== undefined ? { failOn } : {}),
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
      const cwd = globals.cwd ?? process.cwd();
      const result = await runStatusCommand({ cwd, json: opts.json === true });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('next')
    .description('resolve the next runnable sprint')
    .option('--json', 'emit JSON output', false)
    .option('--lane <lane>', 'lane name (defaults to policies.defaultLane)')
    .action(async (opts: NextOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & NextOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const result = await runNextCommand({
        cwd,
        json: opts.json === true,
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('doctor')
    .description('diagnose RepoKernel setup problems')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: DoctorOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & DoctorOptions>();
      const result = await runDoctorCommand({
        cwd: globals.cwd ?? process.cwd(),
        json: opts.json === true,
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
        cwd: globals.cwd ?? process.cwd(),
        id,
        json: opts.json === true,
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
      const result = await runOpenCommand({ cwd: globals.cwd ?? process.cwd(), id });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  program
    .command('fix')
    .description('preview safe mechanical fixes')
    .option('--preview', 'show safe fixes without applying them', false)
    .option('--json', 'emit JSON output (requires --preview)', false)
    .action(async (opts: FixOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & FixOptions>();
      const result = await runFixCommand({
        cwd: globals.cwd ?? process.cwd(),
        preview: opts.preview === true,
        json: opts.json === true,
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
    .action(async (opts: RegistryOptions, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & RegistryOptions>();
      const cwd = globals.cwd ?? process.cwd();
      const result = await runRegistryCommand({
        cwd,
        write: opts.write === true,
        check: opts.check === true,
        json: opts.json === true,
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
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        id: string,
        opts: { force: boolean; dryRun: boolean; json: boolean },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const result = await runStartCommand(id, {
          cwd: globals.cwd ?? process.cwd(),
          force: opts.force,
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
        cwd: globals.cwd ?? process.cwd(),
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
          cwd: globals.cwd ?? process.cwd(),
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
    .command('close <id>')
    .description('ship a sprint in review (model A: implementation already committed)')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runCloseCommand(id, {
        cwd: globals.cwd ?? process.cwd(),
        dryRun: opts.dryRun,
        json: opts.json,
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
        cwd: globals.cwd ?? process.cwd(),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

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
          cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
        json: opts.json,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

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
        cwd: globals.cwd ?? process.cwd(),
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

  // — chain commands —

  const chainCmd = program.command('chain').description('preview sprint chain execution');

  chainCmd
    .command('preview')
    .description('show what sprints would run in a chain')
    .option('--lane <lane>', 'lane name')
    .option('--limit <n>', 'max sprints to show', '5')
    .option('--ignore-disabled', 'show preview even if chaining is disabled', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        opts: { lane?: string; limit: string; ignoreDisabled: boolean; json: boolean },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const limit = parsePositiveIntOption('--limit', opts.limit);
        if (!limit.ok) exitOptionError(limit.message);
        const result = await runChainPreviewCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
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
      const result = await runCreateEpicCommand(title, { cwd: globals.cwd ?? process.cwd() });
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
    .option('--after <sprintId>', 'add depends_on this sprint ID')
    .action(async (title: string, _opts: CreateSprintOpts, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions & CreateSprintOpts>();
      const result = await runCreateSprintCommand(title, {
        cwd: globals.cwd ?? process.cwd(),
        epic: globals.epic,
        lane: globals.lane ?? 'main',
        status: globals.status ?? 'planned',
        ...(globals.after !== undefined ? { after: globals.after } : {}),
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
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
    .action(async (epicId: string, opts: { force: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runLaneAcquireCommand(epicId, {
        cwd: globals.cwd ?? process.cwd(),
        force: opts.force,
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
        json: opts.json === true,
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
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
        cwd: globals.cwd ?? process.cwd(),
        json: opts.json === true,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    });

  // — run orchestrator —

  program
    .command('run [epic-id]')
    .description('run an epic sprint-by-sprint with an agent')
    .option('--agent <name>', 'agent runner (manual|claude)', 'manual')
    .option('--mode <mode>', 'execution mode (assisted|autonomous)', 'assisted')
    .option('--lane <name>', 'sprint queue lane to run (default: config defaultLane)')
    .option('--limit <n>', 'max sprints to execute in this run')
    .option('--resume <run-id>', 'resume a paused or failed run')
    .option('--worktree', 'create isolated git worktree (default: true)', true)
    .option('--no-worktree', 'skip worktree creation, use current checkout')
    .option('--dry-run', 'preview chain without executing', false)
    .option('--experimental', 'enable experimental agent runners (e.g. claude)', false)
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
    .action(
      async (
        epicId: string | undefined,
        opts: {
          agent: string;
          mode: string;
          lane?: string;
          limit?: string;
          resume?: string;
          worktree: boolean;
          dryRun: boolean;
          experimental: boolean;
          parallel: boolean;
          sequential: boolean;
          concurrency?: string;
          allowOverlap: boolean;
        },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<GlobalOptions>();
        const limit = parsePositiveIntOption('--limit', opts.limit);
        if (!limit.ok) exitOptionError(limit.message);
        const concurrency = parsePositiveIntOption('--concurrency', opts.concurrency);
        if (!concurrency.ok) exitOptionError(concurrency.message);
        const result = await runRunCommand({
          cwd: globals.cwd ?? process.cwd(),
          ...(epicId !== undefined ? { epicId } : {}),
          ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
          ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
          agent: opts.agent,
          mode: (opts.mode === 'autonomous' ? 'autonomous' : 'assisted') as
            | 'assisted'
            | 'autonomous',
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
          worktree: opts.worktree,
          dryRun: opts.dryRun,
          experimental: opts.experimental,
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

  program
    .command('runs')
    .description('list agent runs')
    .option('--status <status>', 'filter by status (running|paused|completed|failed|aborted)')
    .option('--epic <id>', 'filter by epic ID')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { status?: string; epic?: string; json: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<GlobalOptions>();
      const result = await runRunsCommand({
        cwd: globals.cwd ?? process.cwd(),
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
