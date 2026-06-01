import type { Command } from 'commander';
import {
  runReReviewCommand,
  runReviewCommand,
  runReviewVerdictCommand,
  runStartCommand,
} from '../commands/lifecycle.js';
import { exitWithResult, startCwdFor } from '../util/cli.js';
import { resolveProjectCwd } from '../util/program.js';

/**
 * Register the contiguous `rk start` / `rk review` / `rk review-verdict`
 * command cluster onto the provided Commander program.
 *
 * Extracted from index.ts as part of the PR10 architecture split. Behavior
 * unchanged — verified against `rk --help` snapshots before/after.
 *
 * `close`, `reopen`, and `cancel` stay inline in index.ts because their
 * registration order is interleaved with `review-aggregate` and `discard`
 * (which belong to other domains). Moving them here would reorder the
 * top-level help table; preserving help output is the gating constraint
 * for this PR.
 */
export function registerLifecycleCommands(program: Command): void {
  program
    .command('start <id>')
    .description(
      'start a queued or reopened sprint (worktree acquisition follows start.worktree: auto|always|never)',
    )
    .option('--force', 'allow starting a planned or pending sprint', false)
    .option(
      '--enqueue',
      'if status is planned, queue the sprint into its lane and start it in one step',
      false,
    )
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .option('--worktree', 'force acquiring an isolated sprint worktree (overrides config)')
    .option('--no-worktree', 'force metadata-only start, no worktree (overrides config)')
    .action(
      async (
        id: string,
        opts: {
          force: boolean;
          enqueue: boolean;
          dryRun: boolean;
          json: boolean;
          worktree?: boolean;
        },
        cmd: Command,
      ) => {
        // Commander collapses --worktree/--no-worktree to one boolean. Only
        // honor it as an explicit override when the user actually passed a flag;
        // otherwise defer to config.start.worktree by leaving it undefined.
        const worktreeExplicit = cmd.getOptionValueSource('worktree') === 'cli';
        const result = await runStartCommand(id, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          force: opts.force,
          enqueue: opts.enqueue,
          dryRun: opts.dryRun,
          json: opts.json,
          ...(worktreeExplicit ? { worktree: opts.worktree } : {}),
        });
        await exitWithResult(result);
      },
    );

  program
    .command('review <id>')
    .description('move an active sprint to review status')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const result = await runReviewCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      await exitWithResult(result);
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
        const result = await runReviewVerdictCommand(reviewId, verdict, {
          cwd: resolveProjectCwd(startCwdFor(cmd)),
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
          dryRun: opts.dryRun,
          json: opts.json,
        });
        await exitWithResult(result);
      },
    );

  program
    .command('re-review <id>')
    .description('reopen a changes_requested/rejected review (resets verdict, bumps attempt)')
    .option('--dry-run', 'pre-flight only, no writes', false)
    .option('--json', 'emit JSON output', false)
    .action(async (id: string, opts: { dryRun: boolean; json: boolean }, cmd: Command) => {
      const result = await runReReviewCommand(id, {
        cwd: resolveProjectCwd(startCwdFor(cmd)),
        dryRun: opts.dryRun,
        json: opts.json,
      });
      await exitWithResult(result);
    });
}
