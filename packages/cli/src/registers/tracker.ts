import type { Command } from 'commander';
import {
  runTrackerCommentCommand,
  runTrackerLinkCommand,
  runTrackerLinkPrCommand,
  runTrackerStatusCommand,
  runTrackerTransitionCommand,
} from '../commands/tracker.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

/**
 * Register the `rk tracker {status,link,comment,link-pr,transition}` cluster.
 *
 * The CLI receives `<providerRef>` as an opaque string and delegates the full
 * parse to the command layer (`runTrackerLinkCommand` → `parseTrackerRef`),
 * so there is exactly one parser and one set of error messages.
 */
export function registerTrackerCommands(program: Command): void {
  const trackerCmd = program.command('tracker').description('external tracker bridge');

  trackerCmd
    .command('status <sprintId>')
    .description('show tracker metadata for a sprint')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runTrackerStatusCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  trackerCmd
    .command('link <sprintId> <providerRef>')
    .description('link a sprint to an external tracker (providerRef like linear:RK-42)')
    .option('--url <url>', 'optional issue URL')
    .option('--json', 'emit JSON output', false)
    .action(
      async (
        sprintId: string,
        providerRef: string,
        opts: { url?: string; json: boolean },
        cmd: Command,
      ) => {
        const colon = providerRef.indexOf(':');
        if (colon < 0) {
          await exitWithResult({
            exitCode: 2,
            stdout: '',
            stderr: 'providerRef must be `<provider>:<issue-id>` (e.g. linear:RK-42)\n',
          });
          return;
        }
        const result = await runTrackerLinkCommand({
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          sprintId,
          provider: providerRef.slice(0, colon),
          issueId: providerRef.slice(colon + 1),
          json: opts.json === true,
          ...(opts.url !== undefined ? { issueUrl: opts.url } : {}),
        });
        await exitWithResult(result);
      },
    );

  trackerCmd
    .command('comment <sprintId> <message>')
    .description('post a comment on the linked tracker ticket')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, message: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runTrackerCommentCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        body: message,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  trackerCmd
    .command('link-pr <sprintId> <prUrl>')
    .description('link a pull request URL to the tracker ticket')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, prUrl: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runTrackerLinkPrCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        prUrl,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });

  trackerCmd
    .command('transition <sprintId> <state>')
    .description('transition the tracker ticket to a new state')
    .option('--json', 'emit JSON output', false)
    .action(async (sprintId: string, state: string, opts: { json: boolean }, cmd: Command) => {
      const result = await runTrackerTransitionCommand({
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        sprintId,
        state,
        json: opts.json === true,
      });
      await exitWithResult(result);
    });
}
