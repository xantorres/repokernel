import type { Command } from 'commander';
import { runPreflightCommand } from '../commands/preflight.js';
import { runTeamStatusCommand } from '../commands/team.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

/**
 * Register the `rk team status [--watch]` and `rk preflight` commands.
 *
 * `rk preflight` is the canonical session-scoped operational gate. Plugin
 * commands consult its cached output (see SKILL.md) instead of each
 * re-running `rk team status`. The cache is per-opRoot under
 * <opRoot>/preflight.json with a default 60s TTL; --refresh forces a
 * re-scan; --max-age tunes the TTL.
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

  program
    .command('preflight')
    .description('canonical session-scoped operational gate (cached, 60s TTL)')
    .option('--json', 'emit JSON output', false)
    .option('--for-dispatch', 'include dispatch readiness checks', false)
    .option('--refresh', 'force a fresh scan, ignoring cache', false)
    .option(
      '--max-age <seconds>',
      'cache freshness budget in seconds; older entries trigger a re-scan',
      '60',
    )
    .action(
      async (
        opts: { json: boolean; forDispatch?: boolean; refresh: boolean; maxAge: string },
        cmd: Command,
      ) => {
        const maxAge = Number.parseInt(opts.maxAge, 10);
        const result = await runPreflightCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          json: opts.json === true,
          forDispatch: opts.forDispatch === true,
          refresh: opts.refresh === true,
          ...(Number.isFinite(maxAge) && maxAge > 0 ? { maxAgeSeconds: maxAge } : {}),
        });
        await exitWithResult(result);
      },
    );
}
