import { existsSync, realpathSync, statSync } from 'node:fs';
import {
  EPIC_ID_RE,
  type EpicStatus,
  EpicStatusSchema,
  loadConfig,
  REJECTION_SCOPES,
  type RejectionScope,
  type ReviewVerdict,
  ReviewVerdictSchema,
  type RunMode,
  RunModeSchema,
  type RunStatus,
  RunStatusSchema,
  SEVERITY_RANK,
  type Severity,
  SeveritySchema,
  SPRINT_ID_RE,
  type SprintStatus,
  SprintStatusSchema,
} from '@repokernel/core';
import { Command } from 'commander';
import { runBoardCommand } from './commands/board.js';
import { runChainPreviewCommand } from './commands/chain.js';
import { runContextCommand } from './commands/context.js';
import { runDoctorCommand } from './commands/doctor.js';
import {
  runEpicAddSprintCommand,
  runEpicCloseCommand,
  runEpicMapCommand,
  runEpicShipCommand,
  runEpicStatusCommand,
} from './commands/epic.js';
import { runExplainCommand } from './commands/explain.js';
import {
  isTaskId,
  readTaskAlias,
  reflectSprintStatusInAlias,
  runCloseTaskCommand,
  runDiscardTaskCommand,
  runFastpathTask,
  runTaskInspectCommand,
  runTaskListCommand,
  runTaskStatusCommand,
  TASK_ID_RE,
  type TaskAlias,
} from './commands/fastpath/index.js';
import { runRecoverCommand } from './commands/recover.js';
import { runRejectCommand } from './commands/reject.js';

type TaskAliasStatus = TaskAlias['status'];

import { runBriefCommand } from './commands/brief.js';
import { runFixCommand } from './commands/fix.js';
import { runGateListCommand, runGateResolveCommand } from './commands/gate.js';
import { runGatesCommand } from './commands/gates.js';
import { runHotfixCommand } from './commands/hotfix.js';
import { runInitCommand } from './commands/init.js';
import { runInspectCommand } from './commands/inspect.js';
import {
  resolveDefaultSourceDir,
  resolveDefaultTarget,
  runInstallSkillCommand,
} from './commands/installSkill.js';
import { type IdeTarget, runInstallSkillIdeCommand } from './commands/installSkillIde.js';
import { runLaneAcquireCommand, runLaneReleaseCommand, runLanesCommand } from './commands/lanes.js';
import { runCancelCommand, runCloseCommand, runReopenCommand } from './commands/lifecycle.js';
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
import { runPathPolicyCommand } from './commands/pathPolicy.js';
import { runPlanCommand } from './commands/plan.js';
import { runQueueAddCommand, runQueueRemoveCommand } from './commands/queue.js';
import { runRegistryCommand } from './commands/registry.js';
import { runReportCommand } from './commands/report.js';
import { runReviewAggregateCommand } from './commands/reviewAggregateCmd.js';
import { runReviewAllocateCommand } from './commands/reviewAllocate.js';
import { runReviewCreateCommand } from './commands/reviewCreate.js';
import { runReviewDiscardCommand } from './commands/reviewDiscard.js';
import { runReviewEvidenceCommand } from './commands/reviewEvidence.js';
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
import { runScaffoldCommandCommand } from './commands/scaffold.js';
import { runShipCommand } from './commands/ship.js';
import { runSprintNormalizeCommand } from './commands/sprintNormalize.js';
import {
  runSprintRoutingClearCommand,
  runSprintRoutingSetCommand,
} from './commands/sprintRouting.js';
import { runStatusCommand } from './commands/status.js';
import { runValidateCommand } from './commands/validate.js';
import { runWarningsBaselineCommand } from './commands/warnings.js';
import { runWaveCommand } from './commands/wave.js';
import { runWaveClaimCommand, runWaveParallelCommand } from './commands/waveParallel.js';
import {
  errorToCommandResult,
  exitWithResult,
  RuntimeError,
  startCwdFor,
  UsageError,
} from './util/cli.js';
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
  readonly audit?: boolean;
}

interface RegistryOptions {
  readonly json?: boolean;
  readonly write?: boolean;
  readonly check?: boolean;
  readonly explain?: boolean;
  readonly out?: string;
}

interface ShipOptions {
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly skipChecks?: boolean;
}

interface GatesOptions {
  readonly json?: boolean;
  readonly targetScope?: 'close' | 'global';
  readonly profile?: string;
}

interface PlanOptions {
  readonly createSprint?: boolean;
  readonly enqueue?: boolean;
  readonly singleSprint?: boolean;
  readonly split?: boolean;
  readonly noSprint?: boolean;
  readonly allowedPath?: readonly string[];
  readonly yes?: boolean;
  readonly json?: boolean;
}

interface WaveOptions {
  readonly apply?: boolean;
  readonly createSprint?: boolean;
  readonly enqueue?: boolean;
  readonly json?: boolean;
  readonly parallelPlan?: boolean;
  readonly maxPerLane?: string;
  readonly maxTotal?: string;
}

interface WarningsBaselineOptions {
  readonly write?: boolean;
  readonly owner?: string;
  readonly expires?: string;
  readonly json?: boolean;
}

interface ReviewEvidenceOptions {
  readonly label: string;
  readonly command: string;
  readonly exitCode?: string;
  readonly summary?: string;
  readonly timeout?: string;
  readonly json?: boolean;
}

interface ReportOptions {
  readonly json?: boolean;
  readonly all?: boolean;
}

interface StatusOptions {
  readonly json?: boolean;
  readonly brief?: boolean;
  readonly allLanes?: boolean;
  readonly worktrees?: boolean;
}

interface NextOptions {
  readonly json?: boolean;
  readonly lane?: string;
  readonly epic?: string;
  readonly suggest?: boolean;
  readonly includePlanned?: boolean;
  readonly claim?: boolean;
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
  readonly nonInteractive?: boolean;
  readonly agent?: string;
  readonly lane?: string;
  readonly checksCmd?: string;
  readonly commit?: boolean;
  readonly dir?: string;
}

interface InstallSkillOptions {
  readonly target?: string;
  readonly source?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly printPath?: boolean;
  readonly ide?: string;
  readonly project?: boolean;
}

interface DoctorOptions {
  readonly json?: boolean;
  readonly fix?: boolean;
  readonly agentEnv?: boolean;
}

interface InspectOptions {
  readonly json?: boolean;
}

interface SprintNormalizeOptions {
  readonly all?: boolean;
  readonly write?: boolean;
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
  readonly json?: boolean;
}

interface FixOptions {
  readonly preview?: boolean;
  readonly apply?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly baseSha?: string;
  readonly sprint?: string;
  readonly dryRun?: boolean;
}

// Create*Opts moved to packages/cli/src/registers/create.ts alongside
// `registerCreateCommands` (PR10 architecture split).

interface LsEpicsOpts {
  readonly status?: string;
  readonly unshipped?: boolean;
  readonly json?: boolean;
}

interface LsSprintsOpts {
  readonly epic?: string;
  readonly status?: string;
  readonly lane?: string;
  readonly withDeps?: boolean;
  readonly json?: boolean;
  readonly last?: string;
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
  throw new UsageError(`invalid ${flag} value "${input}" (use implement|review|wave)`);
}

function parseContextFormat(flag: string, input: string): 'md' | 'json' {
  if (input === 'md' || input === 'json') return input;
  throw new UsageError(`invalid ${flag} value "${input}" (use md|json)`);
}

export function severityOrThrow(name: string, input: string | undefined): Severity | undefined {
  if (input === undefined) return undefined;
  const parsed = SeveritySchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageError(`invalid ${name} value "${input}" (use P0|P1|P2|P3)`);
  }
  return parsed.data;
}

function epicStatusOrThrow(name: string, input: string | undefined): EpicStatus | undefined {
  if (input === undefined) return undefined;
  const parsed = EpicStatusSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageError(
      `invalid ${name} value "${input}" (use planned|active|on_hold|done|cancelled)`,
    );
  }
  return parsed.data;
}

function sprintStatusOrThrow(name: string, input: string | undefined): SprintStatus | undefined {
  if (input === undefined) return undefined;
  const parsed = SprintStatusSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageError(
      `invalid ${name} value "${input}" (use planned|pending|queued|active|review|shipped|reopened|cancelled)`,
    );
  }
  return parsed.data;
}

function reviewVerdictOrThrow(name: string, input: string | undefined): ReviewVerdict | undefined {
  if (input === undefined) return undefined;
  const parsed = ReviewVerdictSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageError(
      `invalid ${name} value "${input}" (use pending|accepted|changes_requested|rejected)`,
    );
  }
  return parsed.data;
}

/**
 * Parse `--mode` for `rk run`. Default falls through when input is undefined;
 * an unknown value (e.g. typo `autonomus`) exits with `EXIT_USAGE` rather
 * than silently falling back to `assisted`. Accepts only the schema-blessed
 * values so future additions to `RUN_MODES` are picked up automatically.
 */
export function parseRunMode(name: string, input: string | undefined): RunMode | undefined {
  if (input === undefined) return undefined;
  const parsed = RunModeSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageError(`invalid ${name} value "${input}" (use assisted|autonomous)`);
  }
  return parsed.data;
}

/**
 * Parse `--status` for `rk runs`. Returns undefined when omitted; rejects
 * unknown values rather than filtering on a value that can never match
 * (silently empty result set is the bug — finding 14).
 */
export function parseRunStatus(name: string, input: string | undefined): RunStatus | undefined {
  if (input === undefined) return undefined;
  const parsed = RunStatusSchema.safeParse(input);
  if (!parsed.success) {
    throw new UsageError(
      `invalid ${name} value "${input}" (use running|paused|completed|aborted|failed)`,
    );
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
    throw new UsageError(
      `invalid ${name} value "${input}" (use P0|P1|P2|P3 or comma list e.g. P0,P1)`,
    );
  }
  const severities: Severity[] = [];
  for (const part of parts) {
    const parsed = SeveritySchema.safeParse(part);
    if (!parsed.success) {
      throw new UsageError(
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
    throw new UsageError(
      `invalid ${name} value "${input}" (use P0|P1|P2|P3 or comma list e.g. P0,P1)`,
    );
  }
  return severities.reduce(
    (threshold, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[threshold] ? s : threshold),
    initial,
  );
}

import { registerCreateCommands } from './registers/create.js';
import { registerLifecycleCommands } from './registers/lifecycle.js';
import { registerPrCommands } from './registers/pr.js';
import { registerRegistryMergeDriverCommand } from './registers/registryMergeDriver.js';
import { registerTeamCommands } from './registers/team.js';
import { registerTrackerCommands } from './registers/tracker.js';
import { registerTrustCommands } from './registers/trust.js';
// Helpers extracted to ./util/program.ts so register modules can share
// them without importing from index.ts (which would create a cycle).
import { collectCsvOption, collectOption, resolveProjectCwd } from './util/program.js';

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

function parseIntegerOption(
  name: string,
  value: string | undefined,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (!/^-?\d+$/.test(value)) {
    return { ok: false, message: `invalid ${name} value "${value}" (use an integer)` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, message: `invalid ${name} value "${value}" (integer is too large)` };
  }
  return { ok: true, value: parsed };
}

function exitOptionError(message: string): never {
  // Throw rather than write+exit synchronously — `main()`'s top-level catch
  // routes the message through `exitWithResult` so stderr is flushed before
  // `process.exit`, even when invoked from a piped subprocess.
  throw new UsageError(message);
}

function parseGateProfile(
  value: string,
): { ok: true; value: 'focused' | 'sprint' | 'epic' | 'release' } | { ok: false; message: string } {
  if (value === 'focused' || value === 'sprint' || value === 'epic' || value === 'release') {
    return { ok: true, value };
  }
  return {
    ok: false,
    message: `--profile must be focused, sprint, epic, or release (got: ${value})`,
  };
}

// resolveProjectCwd lives in ./util/program.ts (imported above).

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
    .action(async (_opts: GlobalOptions, cmd: Command) => {
      const result = await runStatusCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: false,
      });
      await exitWithResult(result);
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
    .option(
      '--audit',
      'include historical-hygiene rules on shipped/frozen state (audit-scope rules); off by default to keep validate noise-free',
      false,
    )
    .action(async (opts: ValidateOptions, cmd: Command) => {
      const cwd = resolveProjectCwd(startCwdFor(cmd));
      const failOn = severityFailOnOrThrow('--fail-on', opts.failOn);
      const only = severityOrThrow('--only', opts.only);
      const min = severityOrThrow('--min', opts.min);
      const result = await runValidateCommand({
        cwd,
        json: opts.json === true,
        open: opts.open === true,
        runtimeVersion: RK_VERSION,
        audit: opts.audit === true,
        ...(failOn !== undefined ? { failOn } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        filters: {
          ...(only !== undefined ? { only } : {}),
          ...(min !== undefined ? { min } : {}),
          ...(opts.code !== undefined && opts.code.length > 0 ? { codes: opts.code } : {}),
          ...(opts.entity !== undefined ? { entity: opts.entity } : {}),
        },
      });
      await exitWithResult(result);
    });

  program
    .command('status')
    .description('summarize project health and next runnable sprint')
    .option('--json', 'emit JSON output', false)
    .option(
      '--brief',
      'one-line summary (skips full validators, sub-200ms; for SessionStart hooks)',
      false,
    )
    .option('--all-lanes', 'include per-lane active/queued/review/planned state', false)
    .option('--worktrees', 'include operational worktree and live-claim state', false)
    .action(async (opts: StatusOptions, cmd: Command) => {
      const cwd = resolveProjectCwd(startCwdFor(cmd));
      const result = await runStatusCommand({
        cwd,
        json: opts.json === true,
        brief: opts.brief === true,
        allLanes: opts.allLanes === true,
        worktrees: opts.worktrees === true,
      });
      await exitWithResult(result);
    });

  const nextCmd = program
    .command('next')
    .description(
      'resolve the next runnable sprint (or manage NEXT.md). For a cross-epic view of work in flight, use `rk ls epics --unshipped`.',
    )
    .option('--json', 'emit JSON output', false)
    .option('--lane <lane>', 'lane name (defaults to policies.defaultLane)')
    .option(
      '--epic <id>',
      'restrict resolution to sprints belonging to this epic; warns if epic.sprints references a missing sprint file',
    )
    .option(
      '--suggest',
      'also list planned sprints whose dependencies are all shipped but are not yet queued',
      false,
    )
    .option(
      '--include-planned',
      'when no queued sprint is runnable, return the next dependency-unblocked planned sprint',
      false,
    )
    .option('--claim', 'claim the resolved sprint in the operational state store', false)
    .action(async (opts: NextOptions, cmd: Command) => {
      const cwd = resolveProjectCwd(startCwdFor(cmd));
      const result = await runNextCommand({
        cwd,
        json: opts.json === true,
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        suggest: opts.suggest === true,
        includePlanned: opts.includePlanned === true,
        claim: opts.claim === true,
      });
      await exitWithResult(result);
    });

  nextCmd
    .command('validate')
    .description('validate NEXT.md slot consistency against the queue')
    .option('--lane <lane>', 'filter drift findings to a specific lane')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: NextValidateOptions, cmd: Command) => {
      const result = await runNextValidateCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  nextCmd
    .command('generate')
    .description('write NEXT.md from current queue state')
    .option('--lane <lane>', 'lane name (defaults to policies.defaultLane)')
    .option('--force', 'overwrite existing NEXT.md without confirmation', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: NextGenerateOptions, cmd: Command) => {
      const result = await runNextGenerateCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        force: opts.force === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  nextCmd
    .command('sync')
    .description('reorder queue to match NEXT.md slot order')
    .option('--lane <lane>', 'lane name (defaults to NEXT.md lane field)')
    .option('--dry-run', 'show what would change without writing', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: NextSyncOptions, cmd: Command) => {
      const result = await runNextSyncCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        dryRun: opts.dryRun === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  program
    .command('doctor')
    .description('diagnose RepoKernel setup problems')
    .option('--json', 'emit JSON output', false)
    .option('--fix', 'auto-create missing generated directories', false)
    .option('--agent-env', 'run agent environment preflight checks', false)
    .action(async (opts: DoctorOptions, cmd: Command) => {
      const result = await runDoctorCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
        fix: opts.fix === true,
        runtimeVersion: RK_VERSION,
        agentEnv: opts.agentEnv === true,
      });
      await exitWithResult(result);
    });

  program
    .command('recover')
    .description(
      'audit (and optionally repair) operational state — worktrees.json, run files, lane claims, pending journals',
    )
    .option('--preview', 'report findings without changing anything (default)', false)
    .option('--dry-run', 'alias for --preview', false)
    .option('--apply', 'quarantine corrupt files, rebuild from git, replay pending journals')
    .option(
      '--journal-only',
      'skip worktrees / runs / lane-claim phases; only scan the journal',
      false,
    )
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        opts: {
          preview: boolean;
          apply?: boolean;
          json: boolean;
          journalOnly?: boolean;
          dryRun?: boolean;
        },
        cmd: Command,
      ): Promise<void> => {
        const preview = opts.preview === true || opts.dryRun === true || opts.apply !== true;
        const result = await runRecoverCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          preview,
          apply: opts.apply === true,
          json: opts.json === true,
          journalOnly: opts.journalOnly === true,
        });
        await exitWithResult(result);
      },
    );

  program
    .command('init')
    .description('initialize RepoKernel project files')
    .option('--example', 'create a working starter project', false)
    .option('--non-interactive', 'skip interactive prompts; use defaults/flags', false)
    .option('--agent <name>', 'agent adapter to record in config (manual/fake/claude/codex/ollama)')
    .option('--lane <name>', 'default lane name (default: main)')
    .option('--checks-cmd <cmd>', 'value for automation.checksCmd')
    .option('--commit', 'commit initialized RepoKernel metadata after writing it', false)
    .option(
      '--dir <path>',
      'base directory for everything RepoKernel writes (default: .repokernel)',
    )
    .action(async (opts: InitOptions, cmd: Command) => {
      // rk init must NOT walk up — initialize at the caller's actual cwd, not
      // a parent project root if one happens to exist. Use startCwdFor (which
      // only walks Commander's parent chain for --cwd) without wrapping it in
      // resolveProjectCwd (which would search for an existing config).
      const result = await runInitCommand({
        cwd: startCwdFor(cmd),
        example: opts.example === true,
        nonInteractive: opts.nonInteractive === true,
        ...(opts.agent !== undefined && { agent: opts.agent }),
        ...(opts.lane !== undefined && { lane: opts.lane }),
        ...(opts.checksCmd !== undefined && { checksCmd: opts.checksCmd }),
        commit: opts.commit === true,
        ...(opts.dir !== undefined && { dir: opts.dir }),
      });
      await exitWithResult(result);
    });

  program
    .command('install-skill')
    .description('install the RepoKernel agent-operated workflow plugin')
    .option('--target <path>', 'install target (default: ~/.claude)')
    .option('--source <path>', 'plugin source override (default: bundled with this CLI)')
    .option('--dry-run', 'preview changes without writing', false)
    .option('--force', 'overwrite an existing divergent install', false)
    .option('--print-path', 'print the resolved plugin cache destination and exit', false)
    .option('--ide <name>', 'install into a specific IDE (cursor|windsurf|copilot|gemini|opencode)')
    .option('--project', 'install project-local instead of user-global (IDE adapters only)', false)
    .action(async (opts: InstallSkillOptions) => {
      let sourceDir: string;
      try {
        sourceDir = opts.source !== undefined ? opts.source : resolveDefaultSourceDir();
      } catch (cause) {
        await exitWithResult(errorToCommandResult(cause));
        return;
      }

      if (opts.ide !== undefined) {
        const result = await runInstallSkillIdeCommand({
          ide: opts.ide as IdeTarget,
          project: opts.project === true,
          cwd: process.cwd(),
          skillSourceDir: sourceDir,
          dryRun: opts.dryRun === true,
          force: opts.force === true,
        });
        await exitWithResult(result);
        return;
      }

      const result = await runInstallSkillCommand({
        sourceDir,
        target: opts.target !== undefined ? opts.target : resolveDefaultTarget(),
        dryRun: opts.dryRun === true,
        force: opts.force === true,
        printPath: opts.printPath === true,
      });
      await exitWithResult(result);
    });

  program
    .command('inspect <id>')
    .description('show a human-readable entity view')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: InspectOptions, cmd: Command) => {
      const result = await runInspectCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        id,
        json: opts.json === true,
      });
      await exitWithResult(result);
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
        cwd: resolveProjectCwd(startCwdFor(cmd)),
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
      await exitWithResult(result);
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
    .option('--json', 'emit JSON output (accepted for compatibility; route is always JSON)', false)
    .action(async (target: string, opts: RouteOptions, cmd: Command) => {
      const profile = parseContextProfile('--profile', opts.profile);
      const result = await runContextCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        target,
        ...(profile !== undefined ? { profile } : {}),
        format: 'json',
        check: false,
        validate: false,
        withRouting: true,
        routingOnly: true,
        runtimeVersion: RK_VERSION,
      });
      await exitWithResult(result);
    });

  program
    .command('explain <code>')
    .description('explain a validation code')
    .option('--json', 'emit JSON output', false)
    .action(async (code: string, opts: ExplainOptions) => {
      const result = runExplainCommand({ code, json: opts.json === true });
      await exitWithResult(result);
    });

  program
    .command('open <id>')
    .description('open an entity source file')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const result = await runOpenCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        id,
      });
      await exitWithResult(result);
    });

  program
    .command('brief <id>')
    .description(
      'render a markdown action-brief for a sprint or epic (auto-detects gate; pause/review-fail/blocked/ready-to-close/status)',
    )
    .option(
      '--gate <type>',
      'force a specific gate template (review-fail|ready-to-close|pause|blocked|status)',
    )
    .option('--json', 'emit JSON envelope including the markdown', false)
    .action(async (id: string, opts: { gate?: string; json: boolean }, cmd: Command) => {
      const result = await runBriefCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
        json: opts.json,
      });
      await exitWithResult(result);
    });

  program
    .command('fix')
    .description('preview or apply safe mechanical fixes')
    .option('--preview', 'show safe fixes without applying them', false)
    .option('--apply', 'apply all detected safe fixes', false)
    .option('--yes', 'skip the confirmation prompt under --apply (CI use)', false)
    .option(
      '--dry-run',
      'simulate --apply: list what would change, no writes (requires --apply)',
      false,
    )
    .option('--json', 'emit JSON output', false)
    .option(
      '--base-sha <sha>',
      'operator-asserted SHA to set on a shipped sprint missing base_sha (paired with --sprint)',
    )
    .option('--sprint <id>', 'sprint id this --base-sha applies to')
    .action(async (opts: FixOptions, cmd: Command) => {
      const result = await runFixCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        preview: opts.preview === true,
        apply: opts.apply === true,
        yes: opts.yes === true,
        json: opts.json === true,
        dryRun: opts.dryRun === true,
        ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
        ...(opts.sprint !== undefined ? { sprint: opts.sprint } : {}),
      });
      await exitWithResult(result);
    });

  program
    .command('registry')
    .description('generate, write, or check the project registry')
    .option('--json', 'emit JSON output', false)
    .option('--write', 'write the registry file', false)
    .option('--check', 'check the registry file for drift', false)
    .option('--explain', 'with --check, print the first drift reason and write suggestion', false)
    .option(
      '--out <path>',
      'write to this path instead of config path (one-off; only with --write)',
    )
    .action(async (opts: RegistryOptions, cmd: Command) => {
      const cwd = resolveProjectCwd(startCwdFor(cmd));
      const result = await runRegistryCommand({
        cwd,
        write: opts.write === true,
        check: opts.check === true,
        explain: opts.explain === true,
        json: opts.json === true,
        ...(opts.out !== undefined ? { out: opts.out } : {}),
      });
      await exitWithResult(result);
    });

  program
    .command('ship <id>')
    .description('ship a sprint through review, close, validate, and registry check')
    .option('--dry-run', 'preview the ship flow without writing files', false)
    .option('--json', 'emit JSON output', false)
    .option('--skip-checks', 'bypass automation.checksCmd during close', false)
    .action(async (id: string, opts: ShipOptions, cmd: Command) => {
      const result = await runShipCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        dryRun: opts.dryRun === true,
        json: opts.json === true,
        skipChecks: opts.skipChecks === true,
      });
      await exitWithResult(result);
    });

  program
    .command('gates <id>')
    .description('run configured checks, path checks, validate, and registry check for a sprint')
    .option('--json', 'emit JSON output', false)
    .option('--profile <profile>', 'focused|sprint|epic|release gate profile', 'sprint')
    .option(
      '--target-scope <scope>',
      "validation scope: 'close' (default — only findings on this sprint, its review, its queue slot, its epic) or 'global' (every finding in the project, same as `rk validate`)",
      'close',
    )
    .action(async (id: string, opts: GatesOptions, cmd: Command) => {
      const scope = opts.targetScope ?? 'close';
      if (scope !== 'close' && scope !== 'global') {
        await exitWithResult({
          exitCode: 2,
          stdout: '',
          stderr: `--target-scope must be 'close' or 'global' (got: ${scope})\n`,
        });
        return;
      }
      const profile = parseGateProfile(opts.profile ?? 'sprint');
      if (!profile.ok) {
        await exitWithResult({ exitCode: 2, stdout: '', stderr: `${profile.message}\n` });
        return;
      }
      const result = await runGatesCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
        profile: profile.value,
        targetScope: scope,
      });
      await exitWithResult(result);
    });

  program
    .command('plan <epic-id>')
    .description('preview or create sprint plan work for an epic')
    .option('--create-sprint', 'create one sprint when the epic is straightforward', false)
    .option('--enqueue', 'enqueue the created or applied sprint work', false)
    .option('--single-sprint', 'force single-sprint planning', false)
    .option('--split', 'force split preview mode', false)
    .option('--no-sprint', 'preview without creating or proposing sprints', false)
    .option(
      '--allowed-path <glob>',
      'allowed path for created sprint; repeatable',
      collectCsvOption,
      [],
    )
    .option('--yes', 'confirm mutating split/wave helpers when supported', false)
    .option('--json', 'emit JSON output', false)
    .action(async (epicId: string, opts: PlanOptions, cmd: Command) => {
      const result = await runPlanCommand(epicId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        createSprint: opts.createSprint === true,
        enqueue: opts.enqueue === true,
        singleSprint: opts.singleSprint === true,
        split: opts.split === true,
        noSprint: opts.noSprint === true,
        allowedPaths: opts.allowedPath ?? [],
        yes: opts.yes === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  const waveCmd = program
    .command('wave [selector]')
    .description(
      'preview or apply dependency-ordered epic waves (for example E-035..E-040); see `rk wave plan` for concurrency-safe parallel scheduling',
    )
    .option('--apply', 'apply eligible mutations; default is preview only', false)
    .option('--create-sprint', 'reserved for future wave planning; currently rejected', false)
    .option('--enqueue', 'enqueue eligible planned sprints during --apply', false)
    .option('--json', 'emit JSON output', false)
    .option(
      '--parallel-plan',
      'deprecated alias of `rk wave plan` — kept for compatibility. Prefer the `rk wave plan` subcommand, which is the canonical spelling.',
      false,
    )
    .action(async (selector: string | undefined, opts: WaveOptions, cmd: Command) => {
      if (opts.parallelPlan === true) {
        const result = await runWaveParallelCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          json: opts.json === true,
          ...(selector !== undefined ? { selector } : {}),
        });
        await exitWithResult(result);
        return;
      }
      if (selector === undefined) {
        await exitWithResult({
          exitCode: 2,
          stdout: '',
          stderr: 'rk wave requires a selector unless --parallel-plan is set\n',
        });
        return;
      }
      const result = await runWaveCommand(selector, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        apply: opts.apply === true,
        createSprint: opts.createSprint === true,
        enqueue: opts.enqueue === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  waveCmd
    .command('plan [selector]')
    .description('emit a capped parallel wave plan for agent scheduling')
    .option('--max-per-lane <n>', 'maximum claims per lane', '4')
    .option('--max-total <n>', 'maximum claims total', '8')
    .option('--json', 'emit JSON output', false)
    .action(async (selector: string | undefined, opts: WaveOptions, cmd: Command) => {
      const maxPerLane = parsePositiveIntOption('--max-per-lane', opts.maxPerLane ?? '4');
      if (!maxPerLane.ok) exitOptionError(maxPerLane.message);
      const maxTotal = parsePositiveIntOption('--max-total', opts.maxTotal ?? '8');
      if (!maxTotal.ok) exitOptionError(maxTotal.message);
      const result = await runWaveParallelCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
        ...(selector !== undefined ? { selector } : {}),
        maxPerLane: maxPerLane.value ?? 4,
        maxTotal: maxTotal.value ?? 8,
      });
      await exitWithResult(result);
    });

  waveCmd
    .command('claim [selector]')
    .description('claim the first capped parallel wave in the operational state store')
    .option('--max-per-lane <n>', 'maximum claims per lane', '4')
    .option('--max-total <n>', 'maximum claims total', '8')
    .option('--json', 'emit JSON output', false)
    .action(async (selector: string | undefined, opts: WaveOptions, cmd: Command) => {
      const maxPerLane = parsePositiveIntOption('--max-per-lane', opts.maxPerLane ?? '4');
      if (!maxPerLane.ok) exitOptionError(maxPerLane.message);
      const maxTotal = parsePositiveIntOption('--max-total', opts.maxTotal ?? '8');
      if (!maxTotal.ok) exitOptionError(maxTotal.message);
      const result = await runWaveClaimCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
        ...(selector !== undefined ? { selector } : {}),
        maxPerLane: maxPerLane.value ?? 4,
        maxTotal: maxTotal.value ?? 8,
      });
      await exitWithResult(result);
    });

  const warningsCmd = program.command('warnings').description('manage warning baselines');
  warningsCmd
    .command('baseline')
    .description('preview or write a warning baseline with owner and expiry metadata')
    .option('--write', 'write .repokernel/warnings-baseline.json', false)
    .option('--owner <name>', 'baseline owner')
    .option('--expires <yyyy-mm-dd>', 'baseline expiry date')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: WarningsBaselineOptions, cmd: Command) => {
      const result = await runWarningsBaselineCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        write: opts.write === true,
        ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        ...(opts.expires !== undefined ? { expires: opts.expires } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  const syncCmd = program
    .command('sync')
    .description('reconcile RepoKernel state after branch merges');
  syncCmd
    .command('merge-state')
    .description('rebuild merge-derived registry state after integrating worktree branches')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { json: boolean }, cmd: Command) => {
      const cwd = resolveProjectCwd(startCwdFor(cmd));
      const registry = await runRegistryCommand({
        cwd,
        write: true,
        check: false,
        json: opts.json === true,
      });
      if (opts.json === true && registry.exitCode === 0) {
        await exitWithResult({
          exitCode: 0,
          stdout: JSON.stringify(
            { ok: true, data: { reconciled: ['registry'], registry: JSON.parse(registry.stdout) } },
            null,
            2,
          ),
          stderr: '',
        });
      }
      await exitWithResult(registry);
    });

  registerRegistryMergeDriverCommand(program);
  registerTrustCommands(program);

  program
    .command('reject')
    .description('record a persisted out-of-scope decision (rejection ADR)')
    .requiredOption('--pattern <regex>', 'JS regex matched against ticket title + body')
    .requiredOption('--reason <text>', 'rationale (>=20 chars) recorded with the rejection')
    .requiredOption('--scope <scope>', `decision scope (one of: ${REJECTION_SCOPES.join(', ')})`)
    .option('--ref <tracker-ref>', 'optional tracker ref, e.g. gh:owner/repo#42')
    .option('--close', 'with --ref, close the linked tracker issue (gh only)', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        opts: {
          pattern: string;
          reason: string;
          scope: string;
          ref?: string;
          close?: boolean;
          json?: boolean;
        },
        cmd: Command,
      ) => {
        const scope = opts.scope as RejectionScope;
        if (!(REJECTION_SCOPES as readonly string[]).includes(scope)) {
          throw new UsageError(
            `--scope must be one of: ${REJECTION_SCOPES.join(', ')} (got: ${opts.scope})`,
          );
        }
        const result = await runRejectCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          pattern: opts.pattern,
          reason: opts.reason,
          scope,
          ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
          close: opts.close === true,
          json: opts.json === true,
        });
        await exitWithResult(result);
      },
    );

  // — lifecycle commands —

  registerLifecycleCommands(program);

  program
    .command('review-aggregate [sprint-id]')
    .description(
      'compute the GREEN/YELLOW/RED panel aggregate from a sprint review or an inline list',
    )
    .option(
      '--verdicts <list>',
      'comma-separated reviewer verdicts (e.g. GREEN,YELLOW,RED) — inline mode, no sprint needed',
    )
    .option(
      '--findings <json>',
      'JSON array of ReviewFinding objects [{severity,message}] — maps severity to panel verdict and aggregates',
    )
    .option(
      '--fail-on <threshold>',
      'exit non-zero when aggregate is at least this severe (GREEN|YELLOW|RED)',
    )
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        sprintId: string | undefined,
        opts: { verdicts?: string; findings?: string; failOn?: string; json: boolean },
        cmd: Command,
      ) => {
        const failOn = opts.failOn?.toUpperCase();
        if (failOn !== undefined && !['GREEN', 'YELLOW', 'RED'].includes(failOn)) {
          await exitWithResult({
            exitCode: 64,
            stdout: '',
            stderr: `invalid --fail-on "${opts.failOn}" (use GREEN|YELLOW|RED)\n`,
          });
          return;
        }
        const result = await runReviewAggregateCommand(sprintId, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          ...(opts.verdicts !== undefined
            ? { verdicts: opts.verdicts.split(',').map((s) => s.trim()) }
            : {}),
          ...(opts.findings !== undefined ? { findings: opts.findings } : {}),
          ...(failOn !== undefined ? { failOn: failOn as 'GREEN' | 'YELLOW' | 'RED' } : {}),
          json: opts.json,
        });
        await exitWithResult(result);
      },
    );

  program
    .command('close [id]')
    .description(
      'close a task or sprint (T-NNN → fastpath close; S-NNN → sprint close; no arg → unique task in review)',
    )
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .option('--skip-checks', 'bypass automation.checksCmd gate (for pre-existing failures)', false)
    .action(
      async (
        id: string | undefined,
        opts: { dryRun: boolean; json: boolean; skipChecks: boolean },
        cmd: Command,
      ) => {
        const cwd = resolveProjectCwd(startCwdFor(cmd));

        const isTaskTarget = id === undefined || isTaskId(id);
        if (isTaskTarget) {
          const result = await runCloseTaskCommand({
            cwd,
            ...(id !== undefined ? { taskId: id } : {}),
            dryRun: opts.dryRun,
            json: opts.json,
          });
          await exitWithResult(result);
        }

        if (id !== undefined && EPIC_ID_RE.test(id)) {
          const result = await runEpicCloseCommand(id, {
            cwd,
            dryRun: opts.dryRun,
            force: false,
            json: opts.json,
          });
          await exitWithResult(result);
        }

        // Existing flow: id refers to a sprint (S-NNN).
        const result = await runCloseCommand(id as string, {
          cwd,
          dryRun: opts.dryRun,
          json: opts.json,
          skipChecks: opts.skipChecks,
        });
        await exitWithResult(result);
      },
    );

  program
    .command('discard [id]')
    .description('cancel a fastpath task and release its worktree (no merge)')
    .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
      const cwd = resolveProjectCwd(startCwdFor(cmd));
      const result = await runDiscardTaskCommand({
        cwd,
        ...(id !== undefined ? { taskId: id } : {}),
      });
      await exitWithResult(result);
    });

  program
    .command('reopen <id>')
    .description('reopen a review/shipped/active sprint, or restore a cancelled sprint to planned')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const result = await runReopenCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      await exitWithResult(result);
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
        const result = await runCancelCommand(id, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          dryRun: opts.dryRun,
          json: opts.json,
        });
        await exitWithResult(result);
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
        const result = await runQueueAddCommand(id, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          lane: opts.lane,
          force: opts.force,
          json: opts.json,
        });
        await exitWithResult(result);
      },
    );

  queueCmd
    .command('remove <id>')
    .description('remove a sprint from a lane queue (sprint reverts to planned)')
    .requiredOption('--lane <name>', 'lane name')
    .option('--json', 'emit JSON output', false)
    .option(
      '--cascade-dependents',
      'also remove every queued sprint that transitively depends on this one (single transaction, rolls back if the resulting registry is invalid)',
      false,
    )
    .action(
      async (
        id: string,
        opts: { lane: string; json: boolean; cascadeDependents?: boolean },
        cmd: Command,
      ) => {
        const result = await runQueueRemoveCommand(id, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          lane: opts.lane,
          json: opts.json,
          cascadeDependents: opts.cascadeDependents === true,
        });
        await exitWithResult(result);
      },
    );

  // — epic commands —

  const epicCmd = program.command('epic').description('inspect epic status and sprint map');

  epicCmd
    .command('status <id>')
    .description('show epic progress and sprint status summary')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runEpicStatusCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json,
      });
      await exitWithResult(result);
    });

  epicCmd
    .command('ls')
    .description('list all epics with progress')
    .option('--status <status>', 'filter by epic status (planned|active|on_hold|done|cancelled)')
    .option(
      '--unshipped',
      'list only epics with status not in {done, cancelled}; mutually exclusive with --status',
      false,
    )
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsEpicsOpts, cmd: Command) => {
      const status = epicStatusOrThrow('--status', opts.status);
      const result = await runLsEpicsCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(status !== undefined ? { status } : {}),
        unshipped: opts.unshipped === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  epicCmd
    .command('map <id>')
    .description('show sprint pipeline for an epic')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runEpicMapCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json,
      });
      await exitWithResult(result);
    });

  epicCmd
    .command('close <id>')
    .description('mark an epic as done (all sprints must be shipped or cancelled)')
    .option('--dry-run', 'preview the mutation without writing files', false)
    .option('--force', 'close even if some sprints are not yet shipped', false)
    .option('--json', 'emit JSON output', false)
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
        opts: {
          dryRun: boolean;
          force: boolean;
          json: boolean;
          runChecks: boolean;
          checksCmd?: string;
        },
        cmd: Command,
      ) => {
        const result = await runEpicCloseCommand(id, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          dryRun: opts.dryRun,
          force: opts.force,
          json: opts.json === true,
          runChecks: opts.runChecks ?? false,
          ...(opts.checksCmd !== undefined ? { checksCmd: opts.checksCmd } : {}),
        });
        await exitWithResult(result);
      },
    );

  epicCmd
    .command('ship <id>')
    .description('close an eligible epic, then validate and registry-check the project')
    .option('--dry-run', 'preview the mutation without writing files', false)
    .option(
      '--run-checks',
      'run check command before closing (uses automation.checksCmd from config)',
      false,
    )
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        id: string,
        opts: { dryRun: boolean; runChecks: boolean; json: boolean },
        cmd: Command,
      ) => {
        const result = await runEpicShipCommand(id, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          dryRun: opts.dryRun,
          runChecks: opts.runChecks === true,
          json: opts.json === true,
        });
        await exitWithResult(result);
      },
    );

  epicCmd
    .command('add-sprint <epicId> <sprintId>')
    .description('append a sprint to the sprints[] ordering hint in epic frontmatter')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        epicId: string,
        sprintId: string,
        opts: { dryRun: boolean; json: boolean },
        cmd: Command,
      ) => {
        const result = await runEpicAddSprintCommand(epicId, sprintId, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          dryRun: opts.dryRun,
          json: opts.json,
        });
        await exitWithResult(result);
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
      const status = sprintStatusOrThrow('--status', opts.status);
      const result = await runLsSprintsCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        withDeps: opts.withDeps === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  sprintCmd
    .command('normalize [sprint-id]')
    .description('normalize generated_paths, inferred test paths, and review stubs')
    .option('--all', 'normalize every sprint', false)
    .option('--write', 'write changes instead of previewing', false)
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string | undefined, opts: SprintNormalizeOptions, cmd: Command) => {
      const result = await runSprintNormalizeCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(sprintId !== undefined ? { target: sprintId } : {}),
        all: opts.all === true,
        write: opts.write === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  const sprintRoutingCmd = sprintCmd
    .command('routing')
    .description('manage CLI-owned sprint routing metadata');

  sprintRoutingCmd
    .command('set <sprint-id>')
    .description('set extras.routing on a sprint')
    .option('--complexity <hint>', 'complexity hint (trivial|standard|deep)')
    .option('--prefer-tier <tier>', 'soft tier preference')
    .option('--pin-tier <tier>', 'hard tier pin')
    .option('--fanout <entries>', 'comma-separated id:tier entries')
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        sprintId: string,
        opts: {
          complexity?: string;
          preferTier?: string;
          pinTier?: string;
          fanout?: string;
          json: boolean;
        },
        cmd: Command,
      ) => {
        const result = await runSprintRoutingSetCommand(sprintId, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          ...(opts.complexity !== undefined ? { complexity: opts.complexity } : {}),
          ...(opts.preferTier !== undefined ? { preferTier: opts.preferTier } : {}),
          ...(opts.pinTier !== undefined ? { pinTier: opts.pinTier } : {}),
          ...(opts.fanout !== undefined ? { fanout: opts.fanout } : {}),
          json: opts.json === true,
        });
        await exitWithResult(result);
      },
    );

  sprintRoutingCmd
    .command('clear <sprint-id>')
    .description('clear extras.routing on a sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runSprintRoutingClearCommand(sprintId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  // — task (fastpath alias) commands —

  const taskCmd = program.command('task').description('inspect fastpath task aliases (T-NNN)');

  taskCmd
    .command('list')
    .description('list fastpath task aliases')
    .option('--status <status>', 'filter by task status (active|review|shipped|cancelled)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { status?: string; json: boolean }, cmd: Command) => {
      const result = await runTaskListCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.status !== undefined ? { status: opts.status as TaskAliasStatus } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  taskCmd
    .command('status <id>')
    .description('show the status of a fastpath task alias')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runTaskStatusCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  taskCmd
    .command('inspect <id>')
    .description('show full alias plus resolved sprint/review file paths')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runTaskInspectCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  // — scaffold commands —

  const scaffoldCmd = program
    .command('scaffold')
    .description('scaffold project-side wiring (commands, protocols)');

  scaffoldCmd
    .command('command <name>')
    .description(
      'scaffold a .claude/commands/<name>.md entry-point (kebab-case name); pair with --with-protocol to also create the .agents/protocol/<name>.md skeleton',
    )
    .option('--description <text>', 'frontmatter description string')
    .option('--arg-hint <text>', 'frontmatter arg-hint string (e.g. "<SPRINT_ID>")')
    .option(
      '--tier <name>',
      'abstract tier hint recorded as a comment in the command (e.g. fast|orchestrate|synthesis)',
      'orchestrate',
    )
    .option('--with-protocol', 'also create .agents/protocol/<name>.md skeleton', false)
    .option('--commands-dir <path>', 'override commands output dir', '.claude/commands')
    .option('--protocol-dir <path>', 'override protocol output dir', '.agents/protocol')
    .option('--force', 'overwrite existing files', false)
    .option('--json', 'emit JSON envelope', false)
    .action(
      async (
        name: string,
        opts: {
          description?: string;
          argHint?: string;
          tier?: string;
          withProtocol?: boolean;
          commandsDir?: string;
          protocolDir?: string;
          force?: boolean;
          json?: boolean;
        },
        cmd: Command,
      ) => {
        const result = await runScaffoldCommandCommand(name, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.argHint !== undefined ? { argHint: opts.argHint } : {}),
          ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
          ...(opts.withProtocol !== undefined ? { withProtocol: opts.withProtocol } : {}),
          ...(opts.commandsDir !== undefined ? { commandsDir: opts.commandsDir } : {}),
          ...(opts.protocolDir !== undefined ? { protocolDir: opts.protocolDir } : {}),
          ...(opts.force !== undefined ? { force: opts.force } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
        });
        await exitWithResult(result);
      },
    );

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
        const limit = parsePositiveIntOption('--limit', opts.limit);
        if (!limit.ok) exitOptionError(limit.message);
        const result = await runChainPreviewCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
          ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
          limit: limit.value ?? 5,
          ignoreDisabled: opts.ignoreDisabled,
          json: opts.json,
        });
        await exitWithResult(result);
      },
    );

  registerCreateCommands(program);

  // — board command —

  program
    .command('board')
    .description('show kanban board across sprint statuses')
    .option('--epic <id>', 'filter by epic ID')
    .option('--lane <lane>', 'filter by lane name')
    .option('--show-cancelled', 'include cancelled sprints column', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: BoardOpts, cmd: Command) => {
      const result = await runBoardCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        showCancelled: opts.showCancelled === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  program
    .command('path-policy <file>')
    .description('classify a file path against configured RepoKernel state paths (used by hooks)')
    .action(async (file: string, _opts: unknown, cmd: Command) => {
      const result = await runPathPolicyCommand({
        cwd: startCwdFor(cmd),
        file,
      });
      await exitWithResult(result);
    });

  program
    .command('report')
    .description('print a project report to stdout')
    .option('--json', 'emit JSON output', false)
    .option('--all', 'include shipped sprints and epic table', false)
    .action(async (opts: ReportOptions, cmd: Command) => {
      const result = await runReportCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
        all: opts.all === true,
      });
      await exitWithResult(result);
    });

  // — lanes command —

  const laneCmd = program.command('lane').description('manage epic lanes and worktrees');

  laneCmd
    .command('ls')
    .alias('list')
    .description('show lane health overview')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LanesOpts, cmd: Command) => {
      const result = await runLanesCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
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
      const result = await runLaneAcquireCommand(epicId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        force: opts.force,
        allowDirty: opts.allowDirty,
      });
      await exitWithResult(result);
    });

  laneCmd
    .command('release <epic-id>')
    .description('release worktree and lane claim for an epic')
    .option('--force', 'release even if worktree has uncommitted changes', false)
    .action(async (epicId: string, opts: { force: boolean }, cmd: Command) => {
      const result = await runLaneReleaseCommand(epicId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        force: opts.force,
      });
      await exitWithResult(result);
    });

  // keep backward-compat alias
  program
    .command('lanes')
    .description('show lane health overview (alias for rk lane ls)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LanesOpts, cmd: Command) => {
      const result = await runLanesCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
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
      const result = await runGateListCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.epic !== undefined ? { epicId: opts.epic } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  gateCmd
    .command('resolve <gate-name>')
    .description('resolve a gate, unblocking sprints for execution')
    .option('--epic <id>', 'scope resolution to a specific epic')
    .option('--force', 'skip precondition check (upstream sprints not yet shipped)', false)
    .option('--dry-run', 'show what would change without writing', false)
    .action(async (gateName: string, opts: GateResolveOpts, cmd: Command) => {
      const result = await runGateResolveCommand(gateName, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.epic !== undefined ? { epicId: opts.epic } : {}),
        force: opts.force === true,
        dryRun: opts.dryRun === true,
      });
      await exitWithResult(result);
    });

  // — ls commands —

  const lsCmd = program.command('ls').description('list project entities');

  lsCmd
    .command('epics')
    .description('list all epics with progress')
    .option('--status <status>', 'filter by epic status (planned|active|on_hold|done|cancelled)')
    .option(
      '--unshipped',
      'list only epics with status not in {done, cancelled}; mutually exclusive with --status',
      false,
    )
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsEpicsOpts, cmd: Command) => {
      const status = epicStatusOrThrow('--status', opts.status);
      const result = await runLsEpicsCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(status !== undefined ? { status } : {}),
        unshipped: opts.unshipped === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  lsCmd
    .command('sprints')
    .description('list sprints with optional filters')
    .option('--epic <id>', 'filter by epic ID (E-NNN)')
    .option('--status <status>', 'filter by sprint status')
    .option('--lane <lane>', 'filter by lane name')
    .option('--with-deps', 'show depends_on column', false)
    .option(
      '--last <n>',
      'return the N most recent sprints (sorted by closed_at desc, then started_at)',
    )
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsSprintsOpts, cmd: Command) => {
      const status = sprintStatusOrThrow('--status', opts.status);
      let last: number | undefined;
      if (opts.last !== undefined) {
        const parsed = Number.parseInt(opts.last, 10);
        const isPositiveInt =
          Number.isFinite(parsed) && parsed.toString() === opts.last && parsed >= 1;
        if (!isPositiveInt) {
          await exitWithResult({
            exitCode: 2,
            stdout: '',
            stderr: `error: --last expected a positive integer, got "${opts.last}"\n`,
          });
        }
        last = parsed;
      }
      const result = await runLsSprintsCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
        ...(last !== undefined ? { last } : {}),
        withDeps: opts.withDeps === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
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
      const verdict = reviewVerdictOrThrow('--verdict', opts.verdict);
      const result = await runLsReviewsCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(opts.sprint !== undefined ? { sprint: opts.sprint } : {}),
        ...(verdict !== undefined ? { verdict } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  lsCmd
    .command('lanes')
    .description('list lanes with queue and active sprint info')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: LsLanesOpts, cmd: Command) => {
      const result = await runLsLanesCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
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
    .option(
      '--from-tracker <source:ref>',
      'seed a fastpath task from JIRA, Linear, or GitHub Issues',
    )
    .option(
      '--allow-tracker-fallback',
      'when --from-tracker fetch fails, create a plain task from fallback input',
      false,
    )
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
          fromTracker?: string;
          allowTrackerFallback: boolean;
        },
        cmd: Command,
      ) => {
        const cwd = resolveProjectCwd(startCwdFor(cmd));

        // Validate --mode once up-front. An unknown value (e.g. `autonomus`)
        // exits EXIT_USAGE rather than silently coercing to `assisted`. The
        // Commander default keeps the original UX: omitted flag = assisted.
        const mode: RunMode = parseRunMode('--mode', opts.mode) ?? 'assisted';

        // `rk run T-NNN` resolves the task alias to its underlying epic and
        // routes through the existing epic-driven flow. This is the recovery
        // path for a task whose previous run halted — the same form printed
        // in error suggestions.
        let resolvedTarget = target;
        let resolvedTaskAlias: TaskAlias | null = null;
        if (resolvedTarget !== undefined && TASK_ID_RE.test(resolvedTarget)) {
          const cfg = await loadConfig({ cwd });
          if (!cfg.ok) {
            throw new RuntimeError('error: repokernel.config.yaml not found; run rk init first');
          }
          const alias = await readTaskAlias(cwd, cfg.config, resolvedTarget as `T-${string}`);
          if (!alias) {
            throw new RuntimeError(
              `error: no task alias found for ${resolvedTarget} — run \`rk task list\` to see available tasks`,
            );
          }
          if (alias.status === 'shipped') {
            throw new RuntimeError(
              `error: task ${resolvedTarget} is already shipped — nothing to retry`,
            );
          }
          if (alias.status === 'cancelled') {
            throw new RuntimeError(
              `error: task ${resolvedTarget} was cancelled — recreate it with \`rk run -m "..."\` instead of retrying`,
            );
          }
          resolvedTaskAlias = alias;
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

        if (isExistingFlow && opts.fromTracker !== undefined) {
          throw new UsageError('--from-tracker is only supported for fastpath tasks.');
        }

        // Tracker fetch + ID allocation + alias write + agent dispatch is
        // four side effects under one verb. Pairing tracker import with an
        // implicitly-resolved default agent surprises users who expected
        // "just import the ticket". Require explicit --agent when
        // --from-tracker is set; pass --agent manual for import-without-run.
        if (opts.fromTracker !== undefined && opts.agent === undefined) {
          throw new UsageError(
            '--from-tracker requires explicit --agent <name> (use --agent manual to import without dispatch).',
          );
        }

        if (!isExistingFlow) {
          const fastpathInputDetected =
            resolvedTarget !== undefined ||
            opts.message !== undefined ||
            opts.stdin === true ||
            opts.fromTracker !== undefined;

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
              throw new UsageError(
                'error: --lane has no meaning for a single ad-hoc task. Drop the flag, or pass an epic id (rk run E-NNN --lane ...).',
              );
            }
            if (opts.limit !== undefined) {
              throw new UsageError(
                'error: --limit has no meaning for a single ad-hoc task. Drop the flag, or pass an epic id (rk run E-NNN --limit ...).',
              );
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
              mode,
              noWorktree: opts.worktree === false,
              dryRun: opts.dryRun === true,
              ...(opts.fromTracker !== undefined ? { fromTracker: opts.fromTracker } : {}),
              allowTrackerFallback: opts.allowTrackerFallback === true,
            });
            await exitWithResult(result);
          }

          if (
            resolvedTarget !== undefined &&
            !EPIC_ID_RE.test(resolvedTarget) &&
            !isFilePathArg(resolvedTarget)
          ) {
            if (SPRINT_ID_RE.test(resolvedTarget)) {
              throw new UsageError(
                `error: "${resolvedTarget}" is a sprint ID — rk run only accepts epic IDs (E-NNN)\n` +
                  `  → to run a single sprint: rk start ${resolvedTarget}`,
              );
            }
            throw new UsageError(
              `error: "${resolvedTarget}" is neither an epic id (E-NNN) nor an existing file path\n` +
                '  → did you mean: rk run -m "..." or rk run path/to/task.md or rk run E-001?',
            );
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
          mode,
          ...(limit.value !== undefined ? { limit: limit.value } : {}),
          worktree: opts.worktree,
          dryRun: opts.dryRun,
          parallel: opts.parallel,
          sequential: opts.sequential,
          ...(concurrency.value !== undefined ? { concurrency: concurrency.value } : {}),
          allowOverlap: opts.allowOverlap,
        });
        if (resolvedTaskAlias && opts.dryRun !== true) {
          const cfg = await loadConfig({ cwd });
          if (cfg.ok) {
            await reflectSprintStatusInAlias(
              cwd,
              cfg.config,
              resolvedTaskAlias.epic_id,
              resolvedTaskAlias.sprint_id,
            ).catch(() => null);
          }
        }
        await exitWithResult(result);
      },
    );

  runCmd
    .command('inspect <run-id>')
    .description('show run state and actionable next steps')
    .option('--json', 'emit JSON output', false)
    .action(async (runId: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runRunInspectCommand(runId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  runCmd
    .command('logs <run-id> [sprint-id]')
    .description('show logs for a run (optionally scoped to a sprint)')
    .action(async (runId: string, sprintId: string | undefined, _opts: unknown, cmd: Command) => {
      const result = await runRunLogsCommand(runId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(sprintId !== undefined ? { sprintId } : {}),
      });
      await exitWithResult(result);
    });

  runCmd
    .command('abort <run-id>')
    .description('abort an active or paused run')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const result = await runRunAbortCommand(runId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
      });
      await exitWithResult(result);
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
      const result = await runReviewPanelRunCommand(sprintId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      await exitWithResult(result);
    });

  reviewPanelCmd
    .command('status <sprint-id>')
    .description('show panel run history for a sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runReviewPanelStatusCommand(sprintId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json,
      });
      await exitWithResult(result);
    });

  reviewPanelCmd
    .command('findings <sprint-id>')
    .description('show findings from the latest panel run')
    .option('--min-severity <sev>', 'minimum severity to show (P0|P1|P2|P3)')
    .option('--json', 'emit JSON output', false)
    .action(
      async (sprintId: string, opts: { minSeverity?: string; json: boolean }, cmd: Command) => {
        const result = await runReviewPanelFindingsCommand(sprintId, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          ...(opts.minSeverity !== undefined ? { minSeverity: opts.minSeverity } : {}),
          json: opts.json,
        });
        await exitWithResult(result);
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
      const result = await runReviewAllocateCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintIds: opts.sprint,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  program
    .command('review-discard <review-id>')
    .description(
      'delete a verdict:pending review stub (reclaims the slot; rejects if already reviewed)',
    )
    .option('--json', 'emit JSON output', false)
    .action(async (reviewId: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runReviewDiscardCommand(reviewId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  program
    .command('review-create')
    .description(
      'allocate a review ID and create a hand-authoring scaffold stub (richer template than review-allocate)',
    )
    .requiredOption('--sprint <id>', 'sprint ID to create the review for')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { sprint: string; json: boolean }, cmd: Command) => {
      const result = await runReviewCreateCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId: opts.sprint,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  program
    .command('review-evidence <id>')
    .description('append command evidence to a review (accepts S-NNN or R-NNN)')
    .requiredOption('--label <label>', 'evidence label, e.g. focused-tests or full-gates')
    .requiredOption('--command <cmd>', 'command to execute and record')
    .option(
      '--exit-code <code>',
      'import already-run evidence without executing (does not satisfy gates)',
    )
    .option('--summary <text>', 'short evidence summary')
    .option('--timeout <seconds>', 'command timeout in seconds (default 300)', '300')
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: ReviewEvidenceOptions, cmd: Command) => {
      const exitCode =
        opts.exitCode === undefined ? undefined : parseIntegerOption('--exit-code', opts.exitCode);
      if (exitCode !== undefined && !exitCode.ok) exitOptionError(exitCode.message);
      const timeout = parseIntegerOption('--timeout', opts.timeout ?? '300');
      if (!timeout.ok) exitOptionError(timeout.message);
      const result = await runReviewEvidenceCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        label: opts.label,
        command: opts.command,
        ...(exitCode !== undefined ? { exitCode: exitCode.value ?? 0 } : {}),
        timeoutSeconds: timeout.value ?? 300,
        ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  program
    .command('review-reconcile')
    .description('detect (and optionally repair) broken sprint→review pointers')
    .option('--apply', 'allocate fresh review IDs and rewrite affected sprint frontmatter', false)
    .option('--epic <id>', 'restrict reconciliation to one epic')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { apply: boolean; epic?: string; json: boolean }, cmd: Command) => {
      const result = await runReviewReconcileCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        apply: opts.apply === true,
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
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
        const result = await runHotfixCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          description,
          acceptanceCriteria: opts.ac,
          denyPaths: opts.deny,
          json: opts.json === true,
        });
        await exitWithResult(result);
      },
    );

  program
    .command('review-sprint <sprint-id>')
    .description('evaluate quality rules for a sprint and set review verdict')
    .option('--dry-run', 'show what verdict would be set without writing', false)
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const result = await runReviewSprintCommand(sprintId, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        dryRun: opts.dryRun === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  registerTeamCommands(program);
  registerTrackerCommands(program);
  registerPrCommands(program);

  program
    .command('runs')
    .description('list agent runs')
    .option('--status <status>', 'filter by status (running|paused|completed|failed|aborted)')
    .option('--epic <id>', 'filter by epic ID')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { status?: string; epic?: string; json: boolean }, cmd: Command) => {
      const status = parseRunStatus('--status', opts.status);
      const result = await runRunsCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        ...(status !== undefined ? { status } : {}),
        ...(opts.epic !== undefined ? { epic: opts.epic } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  return program;
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    // Route uncaught throws (notably RepoKernelError from mutate*Frontmatter)
    // through the same flush primitive as happy-path exits — otherwise the
    // silent-stdout bug Fix 1 just solved reappears under any error path.
    await exitWithResult(errorToCommandResult(e));
  }
}

const isEntry = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    // Resolve symlinks so npm-installed binaries (symlinks into
    // node_modules/.../dist/index.js) compare equal to import.meta.url.
    const resolved = realpathSync(argv1);
    const url = new URL(`file://${resolved}`).href;
    return url === (import.meta as { url?: string }).url;
  } catch {
    return false;
  }
})();

if (isEntry) {
  void main(process.argv.slice(2));
}
