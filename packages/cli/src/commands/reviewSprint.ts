import { join, resolve } from 'node:path';
import { evaluateRules, loadProject, type QualityRule, RepoKernelError } from '@repokernel/core';
import pc from 'picocolors';
import { EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { changedFilesSince } from '../lifecycle/git.js';
import { mutateReviewFrontmatter } from '../lifecycle/mutate.js';
import { refreshRegistry } from '../lifecycle/registry.js';
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
    exitCode: EXIT_RUNTIME,
    stdout: '',
    stderr: suggestion ? `${message}\n  Hint: ${suggestion}\n` : `${message}\n`,
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
      return err('could not load project', 'run rk validate');
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

    const evalResult = evaluateRules({ rules, changedFiles });

    if (opts.dryRun) {
      const label = VERDICT_LABEL[evalResult.verdict] ?? evalResult.verdict;
      const lines = [
        `dry-run — would set verdict: ${label}`,
        `  Sprint:  ${sprintId}`,
        `  Review:  ${sprint.review_id}`,
        `  Rules:   ${rules.length}`,
        `  Files:   ${changedFiles.length}`,
        `  Findings: ${evalResult.findings.length}`,
      ];
      for (const f of evalResult.findings) {
        lines.push(`    [${f.severity}] ${f.message}`);
      }
      return { exitCode: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }

    // Write verdict + findings to review file
    await mutateReviewFrontmatter(join(cwd, review.file), {
      verdict: evalResult.verdict,
      updated_at: isoNow(),
      findings: evalResult.findings,
    });

    await refreshRegistry(cwd);

    const label = VERDICT_LABEL[evalResult.verdict] ?? evalResult.verdict;
    const colorFn = VERDICT_COLOR[evalResult.verdict] ?? ((s: string) => s);

    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: `${JSON.stringify({ verdict: evalResult.verdict, findings: evalResult.findings, review_id: sprint.review_id, sprint_id: sprintId }, null, 2)}\n`,
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

    if (evalResult.verdict === 'accepted') {
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
