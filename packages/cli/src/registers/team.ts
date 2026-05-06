import type { Command } from 'commander';
import { runTeamStatusCommand } from '../commands/team.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

/**
 * Register the `rk team status [--watch]` command cluster.
 *
 * Extracted from index.ts as part of the v2 register split. Behavior unchanged.
 */
export function registerTeamCommands(program: Command): void {
  const teamCmd = program.command('team').description('team-wide orchestration visibility');
  teamCmd
    .command('status')
    .description('show snapshot of active runs, sprints and registry health')
    .option('--json', 'emit JSON output', false)
    .option('--sprint <id>', 'filter to a single sprint')
    .option('--watch', 'refresh continuously', false)
    .option('--interval <seconds>', 'refresh interval for --watch (default 30)', '30')
    .action(
      async (
        opts: { json: boolean; sprint?: string; watch: boolean; interval: string },
        cmd: Command,
      ) => {
        const interval = Number.parseInt(opts.interval, 10);
        const result = await runTeamStatusCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          json: opts.json === true,
          ...(opts.sprint !== undefined ? { sprint: opts.sprint } : {}),
          watch: opts.watch === true,
          ...(Number.isFinite(interval) ? { intervalSeconds: interval } : {}),
        });
        await exitWithResult(result);
      },
    );
}
