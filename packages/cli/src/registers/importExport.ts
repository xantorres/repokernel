import type { Command } from 'commander';
import { runExportCommand } from '../commands/exportPlan.js';
import { runImportCommand } from '../commands/importPlan.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

interface ImportOpts {
  readonly dryRun?: boolean;
  readonly skipExisting?: boolean;
  readonly json?: boolean;
}

/**
 * Register `rk import <file>` and `rk export`. Plain CLI verbs — deliberately no
 * plugin slash command, so the plugin verb-count phrase does not need bumping.
 */
export function registerImportExportCommands(program: Command): void {
  program
    .command('import <file>')
    .description('create epics + sprints in bulk from a declarative plan YAML')
    .option('--dry-run', 'show what would be created without writing any files', false)
    .option('--skip-existing', 'skip epics whose title already exists (idempotent re-runs)', false)
    .option('--json', 'emit JSON output', false)
    .action(async (file: string, opts: ImportOpts, cmd: Command) => {
      const result = await runImportCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        file,
        dryRun: opts.dryRun === true,
        skipExisting: opts.skipExisting === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  program
    .command('export')
    .description('emit the project as an import plan YAML (round-trips with rk import)')
    .action(async (_opts: unknown, cmd: Command) => {
      const result = await runExportCommand({ cwd: resolveProjectCwd(startCwdFor(cmd)) });
      await exitWithResult(result);
    });
}
