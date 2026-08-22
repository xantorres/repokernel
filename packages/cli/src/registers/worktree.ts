import type { Command } from 'commander';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

/**
 * Register the `rk worktree` command group.
 *
 * Covers branch residue left behind by the worktree lifecycle. Removing leaked
 * worktree directories stays with `rk fix`, which already owns that path.
 */
export function registerWorktreeCommands(program: Command): void {
  const worktree = program.command('worktree').description('manage worktree lifecycle residue');

  worktree
    .command('sweep')
    .description('delete merged worktree branches that no longer back a worktree')
    .option('--preview', 'list sweepable branches without deleting them', false)
    .option('--apply', 'delete the sweepable branches', false)
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { preview: boolean; apply: boolean; json: boolean }, cmd: Command) => {
      const { runWorktreeSweepCommand } = await import('../commands/worktreeSweep.js');
      const result = await runWorktreeSweepCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        preview: opts.preview === true,
        apply: opts.apply === true,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });
}
