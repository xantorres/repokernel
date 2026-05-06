import type { Command } from 'commander';
import { exitWithResult } from '../util/cli.js';

/**
 * Register the `rk registry-merge-driver` command. Git invokes this with `%A
 * %B %O` substituted when a merge touches `.repokernel/registry.json` and the
 * `merge=repokernel-registry` attribute is set. Exit code 0 → resolved; non-zero
 * → leave conflict markers for manual resolution.
 */
export function registerRegistryMergeDriverCommand(program: Command): void {
  program
    .command('registry-merge-driver')
    .description('git merge driver for .repokernel/registry.json (called by git, not directly)')
    .requiredOption('--current <path>', 'path to the current-branch registry (%A)')
    .requiredOption('--other <path>', 'path to the incoming-branch registry (%B)')
    .option('--base <path>', 'path to the merge-base registry (%O)')
    .option('--json', 'emit JSON output', false)
    .action(async (opts: { current: string; other: string; base?: string; json: boolean }) => {
      const { runRegistryMergeDriverCommand } = await import('../commands/registryMergeDriver.js');
      const result = await runRegistryMergeDriverCommand({
        currentPath: opts.current,
        otherPath: opts.other,
        ...(opts.base !== undefined ? { basePath: opts.base } : {}),
        json: opts.json === true,
      });
      await exitWithResult(result);
    });
}
