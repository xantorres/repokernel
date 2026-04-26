import { join, resolve } from 'node:path';
import {
  loadProject,
  type PanelReviewQualityRule,
  RepoKernelError,
  type ReviewPanelInput,
} from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_BLOCKED, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { mutateReviewFrontmatter } from '../lifecycle/mutate.js';
import { refreshRegistry } from '../lifecycle/registry.js';
import { runReviewPanel } from '../lifecycle/reviewPanel.js';
import { isoNow } from '../templates/time.js';
import type { CommandResult } from './validate.js';

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

// ─── rk review-panel run ─────────────────────────────────────────────────────

export interface ReviewPanelRunOptions {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export async function runReviewPanelRunCommand(
  sprintId: string,
  opts: ReviewPanelRunOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) return err(`sprint not found: ${sprintId}`);

    if (!sprint.review_id) {
      return err(`${sprintId} has no review_id`, `run rk review ${sprintId} first`);
    }

    const review = outcome.graph.reviews.get(sprint.review_id);
    if (!review) {
      return err(`review ${sprint.review_id} not found`, 'create the review file first');
    }

    if (review.verdict !== 'pending' && review.verdict !== 'changes_requested') {
      return err(
        `review ${sprint.review_id} has verdict "${review.verdict}" — panel only runs on pending or changes_requested reviews`,
      );
    }

    const epic = outcome.graph.epics.get(sprint.epic_id);
    const panelRule = epic?.quality_rules?.find(
      (r): r is PanelReviewQualityRule => r.type === 'panel_review',
    );
    if (!panelRule) {
      return err(`epic ${sprint.epic_id} has no panel_review quality rule`);
    }

    const changedFiles = review.changed_files ?? [];
    const round = (review.panel_runs?.length ?? 0) + 1;

    const input: ReviewPanelInput = {
      schema_version: 1,
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

    if (opts.dryRun) {
      return {
        exitCode: EXIT_OK,
        stdout: `${[
          `dry-run — would run panel for ${sprintId} (round ${round})`,
          `  Reviewers: ${panelRule.reviewers.map((r) => r.id).join(', ')}`,
          `  Changed files: ${changedFiles.length}`,
          `  yellow_blocks_close: ${panelRule.yellow_blocks_close}`,
        ].join('\n')}\n`,
        stderr: '',
      };
    }

    const panelRunResult = await runReviewPanel(panelRule, input, round);

    const finalVerdict: 'accepted' | 'changes_requested' =
      panelRunResult.aggregate === 'RED' ||
      (panelRunResult.aggregate === 'YELLOW' && panelRule.yellow_blocks_close)
        ? 'changes_requested'
        : 'accepted';

    const existingRuns = review.panel_runs ?? [];
    await mutateReviewFrontmatter(join(cwd, review.file), {
      verdict: finalVerdict,
      updated_at: isoNow(),
      panel_aggregate: panelRunResult.aggregate,
      panel_runs: [...existingRuns, panelRunResult],
    });

    await refreshRegistry(cwd);

    if (opts.json) {
      return {
        exitCode: finalVerdict === 'accepted' ? EXIT_OK : EXIT_FINDINGS,
        stdout: `${JSON.stringify(
          {
            sprint_id: sprintId,
            review_id: review.id,
            round: panelRunResult.round,
            aggregate: panelRunResult.aggregate,
            verdict: finalVerdict,
            reviewers: panelRunResult.reviewers,
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    const aggColor =
      panelRunResult.aggregate === 'GREEN'
        ? pc.green
        : panelRunResult.aggregate === 'YELLOW'
          ? pc.yellow
          : pc.red;

    const lines = [
      `Review panel — ${sprintId} (round ${round})`,
      '',
      `  Aggregate: ${aggColor(panelRunResult.aggregate)}`,
      `  Verdict:   ${finalVerdict === 'accepted' ? pc.green('accepted') : pc.yellow('changes_requested')}`,
      '',
      'Reviewers:',
    ];

    for (const r of panelRunResult.reviewers) {
      const vColor = r.verdict === 'GREEN' ? pc.green : r.verdict === 'YELLOW' ? pc.yellow : pc.red;
      lines.push(`  ${r.reviewer_id.padEnd(20)} ${vColor(r.verdict)}`);
      for (const f of r.findings) {
        lines.push(`    [${f.severity}] ${f.message}`);
      }
    }

    if (finalVerdict === 'accepted') {
      lines.push('', `Next: ${pc.dim(`rk close ${sprintId}`)}`);
    } else {
      lines.push(
        '',
        `Panel blocked close — fix findings and re-run: ${pc.dim(`rk review-panel run ${sprintId}`)}`,
      );
    }

    return {
      exitCode: finalVerdict === 'accepted' ? EXIT_OK : EXIT_FINDINGS,
      stdout: `${lines.join('\n')}\n`,
      stderr: '',
    };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}

// ─── rk review-panel status ──────────────────────────────────────────────────

export interface ReviewPanelStatusOptions {
  readonly cwd: string;
  readonly json: boolean;
}

export async function runReviewPanelStatusCommand(
  sprintId: string,
  opts: ReviewPanelStatusOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) return err(`sprint not found: ${sprintId}`);

    if (!sprint.review_id) {
      return err(`${sprintId} has no review_id`);
    }

    const review = outcome.graph.reviews.get(sprint.review_id);
    if (!review) return err(`review ${sprint.review_id} not found`);

    const runs = review.panel_runs ?? [];

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          {
            sprint_id: sprintId,
            review_id: review.id,
            panel_aggregate: review.panel_aggregate ?? null,
            verdict: review.verdict,
            rounds: runs,
          },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    if (runs.length === 0) {
      return {
        exitCode: EXIT_OK,
        stdout: `No panel runs for ${sprintId}\n`,
        stderr: '',
      };
    }

    const lines = [`Review panel status — ${sprintId}`, ''];
    const latest = runs[runs.length - 1]!;

    for (const run of runs) {
      const isLatest = run.round === latest.round;
      const aggColor =
        run.aggregate === 'GREEN' ? pc.green : run.aggregate === 'YELLOW' ? pc.yellow : pc.red;
      lines.push(
        `  Round ${run.round}${isLatest ? pc.dim(' (latest)') : ''}  ${aggColor(run.aggregate)}  ${run.completed_at}`,
      );
      for (const r of run.reviewers) {
        const vColor =
          r.verdict === 'GREEN' ? pc.green : r.verdict === 'YELLOW' ? pc.yellow : pc.red;
        lines.push(`    ${r.reviewer_id.padEnd(20)} ${vColor(r.verdict)}`);
      }
    }

    lines.push('');
    lines.push(
      `  panel_aggregate: ${review.panel_aggregate ?? 'none'}  verdict: ${review.verdict}`,
    );

    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}

// ─── rk review-panel findings ────────────────────────────────────────────────

export interface ReviewPanelFindingsOptions {
  readonly cwd: string;
  readonly minSeverity?: string;
  readonly json: boolean;
}

const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export async function runReviewPanelFindingsCommand(
  sprintId: string,
  opts: ReviewPanelFindingsOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  try {
    const outcome = await loadProject({ cwd });
    if (!outcome.ok) return configError();

    const sprint = outcome.graph.sprints.get(sprintId);
    if (!sprint) return err(`sprint not found: ${sprintId}`);

    if (!sprint.review_id) return err(`${sprintId} has no review_id`);

    const review = outcome.graph.reviews.get(sprint.review_id);
    if (!review) return err(`review ${sprint.review_id} not found`);

    const runs = review.panel_runs ?? [];
    if (runs.length === 0) {
      return { exitCode: EXIT_OK, stdout: `No panel runs for ${sprintId}\n`, stderr: '' };
    }

    const latest = runs[runs.length - 1]!;
    const minRank = opts.minSeverity !== undefined ? (SEVERITY_RANK[opts.minSeverity] ?? 3) : 3;

    const filtered = latest.reviewers.flatMap((r) =>
      r.findings
        .filter((f) => (SEVERITY_RANK[f.severity] ?? 3) <= minRank)
        .map((f) => ({ ...f, reviewer_id: r.reviewer_id })),
    );

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify(
          { sprint_id: sprintId, round: latest.round, findings: filtered },
          null,
          2,
        )}\n`,
        stderr: '',
      };
    }

    if (filtered.length === 0) {
      return {
        exitCode: EXIT_OK,
        stdout: `No findings in round ${latest.round} for ${sprintId}\n`,
        stderr: '',
      };
    }

    const lines = [`Panel findings — ${sprintId} (round ${latest.round})`, ''];
    const byReviewer = new Map<string, typeof filtered>();
    for (const f of filtered) {
      const existing = byReviewer.get(f.reviewer_id) ?? [];
      existing.push(f);
      byReviewer.set(f.reviewer_id, existing);
    }

    for (const [reviewerId, findings] of byReviewer) {
      lines.push(`  ${reviewerId}`);
      for (const f of findings) {
        const sevColor = f.severity === 'P0' || f.severity === 'P1' ? pc.red : pc.yellow;
        lines.push(`    [${sevColor(f.severity)}] ${f.message}`);
        if (f.code) lines.push(`      code: ${f.code}`);
        if (f.suggestion) lines.push(`      suggestion: ${f.suggestion}`);
      }
    }

    return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
  } catch (e) {
    if (e instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${e.message}\n` };
    }
    throw e;
  }
}
