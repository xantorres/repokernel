import type { Command } from 'commander';
import {
  runCreateEpicCommand,
  runCreateQueueCommand,
  runCreateReviewCommand,
  runCreateSprintCommand,
} from '../commands/create.js';
import { readAllStdin } from '../commands/fastpath/runTask.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { collectCsvOption, collectOption, resolveProjectCwd } from '../util/program.js';

interface CreateEpicOpts {
  readonly json?: boolean;
  readonly fromTracker?: string;
  readonly allowTrackerFallback?: boolean;
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
  readonly body?: string;
  readonly skipIds?: readonly string[];
  readonly enqueue?: boolean;
  readonly json?: boolean;
}

interface CreateQueueOpts {
  readonly lane: string;
  readonly json?: boolean;
}

interface CreateReviewOpts {
  readonly sprint: string;
  readonly reviewer?: string;
  readonly json?: boolean;
}

/**
 * Register the `rk create <epic|sprint|queue|review>` command tree onto the
 * provided Commander program.
 *
 * Extracted from index.ts as part of the PR10 architecture split. Behavior
 * is identical to the inline registration the file used to carry —
 * verified by the help-snapshot test in test/registerHelpSnapshot.test.ts.
 */
export function registerCreateCommands(program: Command): void {
  const createCmd = program
    .command('create')
    .description('create a planning entity (epic, sprint, queue, review)');

  createCmd
    .command('epic <title>')
    .description('scaffold a new epic')
    .option(
      '--from-tracker <ref>',
      'seed title and body from an external tracker — forms: gh:owner/repo#NNN | jira:KEY-NN | linear:ABC-NN',
    )
    .option(
      '--allow-tracker-fallback',
      'create a plain epic with the fallback title when --from-tracker cannot fetch',
      false,
    )
    .option('--json', 'emit JSON output', false)
    .action(async (title: string, opts: CreateEpicOpts, cmd: Command) => {
      const result = await runCreateEpicCommand(title, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        json: opts.json === true,
        ...(opts.fromTracker !== undefined ? { fromTracker: opts.fromTracker } : {}),
        ...(opts.allowTrackerFallback === true ? { allowTrackerFallback: true } : {}),
      });
      await exitWithResult(result);
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
      'declare an allowed path glob; repeatable, each value is one glob (commas are literal)',
      collectOption,
      [],
    )
    .option(
      '--denied-path <glob>',
      'declare a denied path glob; repeatable, each value is one glob (commas are literal)',
      collectOption,
      [],
    )
    .option('--adr <ref>', 'link an ADR (e.g. ADR-049); repeatable', collectCsvOption, [])
    .option('--target-date <yyyy-mm-dd>', 'set target_date frontmatter field')
    .option('--body-file <path>', 'read sprint body markdown from a file (no frontmatter)')
    .option(
      '--body <markdown>',
      'sprint body markdown (no frontmatter); pass - to read from stdin; mutually exclusive with --body-file',
    )
    .option(
      '--skip-ids <sprintId>',
      'sprint IDs to reserve as gaps; repeatable, also accepts comma-separated values',
      collectCsvOption,
      [],
    )
    .option(
      '--enqueue',
      'append the new sprint to its lane queue and set status=queued in one step',
      false,
    )
    .option('--json', 'emit JSON output', false)
    .action(async (title: string, opts: CreateSprintOpts, cmd: Command) => {
      // `--body -` reads the body from stdin; any other value is the body
      // verbatim. Mutual exclusivity with --body-file is enforced by the
      // command layer.
      const body = opts.body === '-' ? await readAllStdin() : opts.body;
      const result = await runCreateSprintCommand(title, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        epic: opts.epic,
        lane: opts.lane ?? 'main',
        status: opts.status ?? 'planned',
        ...(opts.after !== undefined && opts.after.length > 0 ? { after: opts.after } : {}),
        ...(opts.allowedPath !== undefined && opts.allowedPath.length > 0
          ? { allowedPaths: opts.allowedPath }
          : {}),
        ...(opts.deniedPath !== undefined && opts.deniedPath.length > 0
          ? { deniedPaths: opts.deniedPath }
          : {}),
        ...(opts.adr !== undefined && opts.adr.length > 0 ? { adrLinks: opts.adr } : {}),
        ...(opts.targetDate !== undefined ? { targetDate: opts.targetDate } : {}),
        ...(opts.bodyFile !== undefined ? { bodyFile: opts.bodyFile } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(opts.skipIds !== undefined && opts.skipIds.length > 0 ? { skipIds: opts.skipIds } : {}),
        enqueue: opts.enqueue === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  createCmd
    .command('queue')
    .description('scaffold a queue file for a lane')
    .requiredOption('--lane <name>', 'lane name')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: CreateQueueOpts, cmd: Command) => {
      const result = await runCreateQueueCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        lane: opts.lane,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  createCmd
    .command('review')
    .description('scaffold a review for a sprint')
    .requiredOption('--sprint <id>', 'sprint ID (S-NNN)')
    .option('--reviewer <name>', 'reviewer name (defaults to automation.defaultReviewer)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: CreateReviewOpts, cmd: Command) => {
      const result = await runCreateReviewCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprint: opts.sprint,
        ...(opts.reviewer !== undefined ? { reviewer: opts.reviewer } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });
}
