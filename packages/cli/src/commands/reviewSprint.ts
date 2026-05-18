import { join, resolve } from 'node:path';
import {
  evaluateRules,
  loadProject,
  type PanelReviewQualityRule,
  type QualityRule,
  RepoKernelError,
  type ReviewPanelInput,
  type ReviewVerdict,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { changedFilesSince } from '../lifecycle/git.js';
import { mutateReviewFrontmatter } from '../lifecycle/mutate.js';
import { type PanelRunResult, runReviewPanel } from '../lifecycle/reviewPanel.js';
import { withLifecycleTransaction } from '../lifecycle/transaction.js';
import { isoNow } from '../templates/time.js';
import type { CommandResult } from './validate.js';

export interface ReviewSprintCommandOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

const VERDICT_LABEL: Record<string, string> = {
  accepted: 'GREEN',
  changes_requested: 'YELLOW',
  rejected: 'RED',
};

const VERDICT_COLOR: Record<string, (s: string) => string> = {
  accepted: pc.green,
  changes_requested: pc.yellow,
  rejected: pc.red,
};

function err(message: string, suggestion?: string): CommandResult {
  return {
    exitCode: EXIT_BLOCKED,
    stdout: '',
    stderr: suggestion ? `${message}\n  Hint: ${suggestion}\n` : `${message}\n`,
  };
}

function configError(): CommandResult {
  return {
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: 'repokernel.config.yaml not found or invalid; run rk init first\n',
  };
}

export async function runReviewSprintCommand(
  sprintId: string,
  opts: ReviewSprintCommandOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) {
      return configError();
    }

    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) return err(`sprint not found: ${sprintId}`);

    if (!sprint.review_id) {
      return err(`${sprintId} has no review_id`, `run rk review ${sprintId} first`);
    }

    const review = outcome.graph.reviews.get(sprint.review_id);
    if (!review) {
      return err(`review ${sprint.review_id} not found`, 'create the review file first');
    }

    const epic = outcome.graph.epics.get(sprint.epic_id);
    const rules: readonly QualityRule[] = epic?.quality_rules ?? [];

    // Resolve changed files: prefer review.changed_files, fall back to git diff
    let changedFiles: string[] = review.changed_files ? [...review.changed_files] : [];
    if (changedFiles.length === 0 && sprint.base_sha) {
      try {
        changedFiles = await changedFilesSince(cwd, sprint.base_sha);
      } catch {
        // non-fatal — proceed with empty list
      }
    }

    const panelRule = rules.find((r): r is PanelReviewQualityRule => r.type === 'panel_review');
    const nonPanelRules: readonly QualityRule[] = rules.filter((r) => r.type !== 'panel_review');
    const evalResult = evaluateRules({ rules: nonPanelRules, changedFiles });

    let finalVerdict: ReviewVerdict = evalResult.verdict;
    let panelRunResult: PanelRunResult | undefined;

    if (panelRule && !opts.dryRun) {
      const round = (review.panel_runs?.length ?? 0) + 1;
      const input: ReviewPanelInput = {
        sprint_id: sprint.id,
        epic_id: sprint.epic_id,
        review_id: review.id,
        lane: sprint.lane,
        worktree_path: cwd,
        changed_files: changedFiles,
        sprint_packet: JSON.stringify({
          sprint_id: sprint.id,
          title: sprint.title,
          epic_id: sprint.epic_id,
          lane: sprint.lane,
          body: sprint.body,
          allowed_paths: sprint.allowed_paths,
        }),
      };
      panelRunResult = await runReviewPanel(panelRule, input, round);

      const panelVerdict: ReviewVerdict =
        panelRunResult.aggregate === 'RED' ||
        (panelRunResult.aggregate === 'YELLOW' && panelRule.yellow_blocks_close)
          ? 'changes_requested'
          : 'accepted';

      // Most restrictive verdict wins
      if (finalVerdict === 'rejected') {
        // keep rejected
      } else if (finalVerdict === 'changes_requested' || panelVerdict === 'changes_requested') {
        finalVerdict = 'changes_requested';
      } else {
        finalVerdict = panelVerdict;
      }
    }

    if (opts.dryRun) {
      const label = VERDICT_LABEL[finalVerdict] ?? finalVerdict;
      const lines = [
        `dry-run — would set verdict: ${label}`,
        `  Sprint:  ${sprintId}`,
        `  Review:  ${sprint.review_id}`,
        `  Rules:   ${rules.length}`,
        `  Files:   ${changedFiles.length}`,
        `  Findings: ${evalResult.findings.length}`,
        ...(panelRule
          ? [`  Panel:   ${panelRule.reviewers.length} reviewer(s) (skipped in dry-run)`]
          : []),
      ];
      for (const f of evalResult.findings) {
        lines.push(`    [${f.severity}] ${f.message}`);
      }
      return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }

    // Write verdict + findings to review file
    const patch: Record<string, unknown> = {
      verdict: finalVerdict,
      updated_at: isoNow(),
      findings: evalResult.findings,
    };
    if (panelRunResult !== undefined) {
      const existingRuns = review.panel_runs ?? [];
      patch.panel_runs = [...existingRuns, panelRunResult];
      patch.panel_aggregate = panelRunResult.aggregate;
    }
    await withLifecycleTransaction(
      { cwd, command: 'review-sprint', args: { sprintId } },
      async (tx) => {
        await mutateReviewFrontmatter(join(cwd, review.file), patch);
        await tx.refreshRegistry();
      },
    );

    const label = VERDICT_LABEL[finalVerdict] ?? finalVerdict;
    const colorFn = VERDICT_COLOR[finalVerdict] ?? ((s: string) => s);

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify({ verdict: finalVerdict, findings: evalResult.findings, review_id: sprint.review_id, sprint_id: sprintId, panel_aggregate: panelRunResult?.aggregate ?? null }, null, 2)}\n`,
        stderr: '',
      };
    }

    const lines = [
      `Review sprint ${sprintId}`,
      '',
      `  ${pc.bold('Sprint')}   ${sprintId}`,
      `  ${pc.bold('Review')}   ${sprint.review_id}`,
      `  ${pc.bold('Verdict')}  ${colorFn(label)}`,
      `  ${pc.bold('Files')}    ${changedFiles.length} changed`,
      `  ${pc.bold('Rules')}    ${rules.length} evaluated`,
    ];

    if (evalResult.findings.length > 0) {
      lines.push('', 'Findings:');
      for (const f of evalResult.findings) {
        const sev =
          f.severity === 'CRITICAL' || f.severity === 'HIGH'
            ? pc.red(f.severity)
            : pc.yellow(f.severity);
        lines.push(`  [${sev}] ${f.message}`);
      }
    }

    if (panelRunResult !== undefined) {
      const aggColor =
        panelRunResult.aggregate === 'GREEN'
          ? pc.green
          : panelRunResult.aggregate === 'YELLOW'
            ? pc.yellow
            : pc.red;
      lines.push(
        '',
        `  ${pc.bold('Panel')}    ${aggColor(panelRunResult.aggregate)} (round ${panelRunResult.round})`,
      );
    }

    if (finalVerdict === 'accepted') {
      lines.push('', `Next: ${pc.dim(`rk close ${sprintId}`)}`);
    } else {
      lines.push('', `Next: ${pc.dim(`rk review-verdict ${sprint.review_id} <verdict>`)}`);
    }

    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}
