import type { Command } from 'commander';
import {
  runPrBodyCommand,
  runPrCommentCommand,
  runPrLinkCommand,
  runPrStatusCommand,
  runPrSyncCommand,
} from '../commands/pr.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

/**
 * Register the `rk pr {body,link,status,sync,comment}` command cluster.
 *
 * Extracted from index.ts as part of the v2 register split. Behavior unchanged.
 */
export function registerPrCommands(program: Command): void {
  const prCmd = program.command('pr').description('pull request bridge');

  prCmd
    .command('body <sprintId>')
    .description('render or post the PR body for a sprint')
    .option('--write', 'post the body to the linked PR', false)
    .option('--summary <text>', 'agent summary block to append')
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        sprintId: string,
        opts: { write: boolean; summary?: string; json: boolean },
        cmd: Command,
      ) => {
        const result = await runPrBodyCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          sprintId,
          json: opts.json === true,
          write: opts.write === true,
          ...(opts.summary !== undefined ? { agentSummary: opts.summary } : {}),
        });
        await exitWithResult(result);
      },
    );

  prCmd
    .command('link <sprintId> <prUrl>')
    .description('link a PR URL to a sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, prUrl: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runPrLinkCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        prUrl,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  prCmd
    .command('status <sprintId>')
    .description('show PR metadata for a sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runPrStatusCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  prCmd
    .command('sync <sprintId>')
    .description('refresh PR status from GitHub')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runPrSyncCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  prCmd
    .command('comment <sprintId> <message>')
    .description('post a comment on the linked PR')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, message: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runPrCommentCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        message,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });
}
