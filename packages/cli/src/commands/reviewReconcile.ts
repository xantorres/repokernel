import { join, resolve } from 'node:path';
import { loadProject, RepoKernelError, type Sprint, type SprintId } from '@repokernel/core';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../exitCodes.js';
import { emitJson } from '../format/json.js';
import { operationalRootBestEffort } from '../lifecycle/controlPaths.js';
import { mutateSprintFrontmatter } from '../lifecycle/mutate.js';
import { allocateReviewIds } from '../lifecycle/reviewAlloc.js';
import type { CommandResult } from './validate.js';

export interface ReviewReconcileOptions {
  readonly cwd: string;
  readonly apply: boolean;
  readonly epic?: string;
  readonly json: boolean;
}

type ReviewIssueKind = 'missing_review_file' | 'review_sprint_mismatch' | 'duplicate_review_id';

export interface ReviewIssue {
  readonly kind: ReviewIssueKind;
  readonly sprintId: string;
  readonly sprintFile: string;
  readonly currentReviewId: string | null;
  readonly detail: string;
}

export interface ReviewRepair {
  readonly sprintId: string;
  readonly fromReviewId: string | null;
  readonly toReviewId: string;
}

/**
 * Diagnose (and optionally repair) sprints whose `review_id` field points at a
 * missing or fabricated review artifact, or shares an ID with another sprint.
 *
 * Default mode is read-only: prints findings, exits non-zero if any issues are
 * detected. With `--apply`, allocates fresh review IDs (via the locked
 * allocator that also creates stub files) and rewrites the affected sprint
 * frontmatter so audit trails stop pointing at fabricated artifacts.
 *
 * Designed for one-shot migration of broken state — DV's E-025/E-029/E-030
 * parallel run produced ~9 broken sprints; this runs once with `--apply` and
 * the project becomes valid again.
 */
export async function runReviewReconcileCommand(
  opts: ReviewReconcileOptions,
): Promise<CommandResult> {
  const cwd = resolve(opts.cwd);

  let outcome: Awaited<ReturnType<typeof loadProject>>;
  try {
    outcome = await loadProject({ cwd });
  } catch (cause) {
    if (cause instanceof RepoKernelError) {
      return { exitCode: EXIT_RUNTIME, stdout: '', stderr: `${cause.message}\n` };
    }
    throw cause;
  }
  if (!outcome.ok) {
    return {
      exitCode: EXIT_RUNTIME,
      stdout: '',
      stderr: 'cannot reconcile: project does not load — fix config/parse errors first\n',
    };
  }

  const sprintsAll: readonly Sprint[] = [...outcome.graph.sprints.values()];
  const sprints =
    opts.epic !== undefined ? sprintsAll.filter((s) => s.epic_id === opts.epic) : sprintsAll;

  const issues = detectIssues(sprints, outcome.graph);

  if (issues.length === 0) {
    if (opts.json) {
      return {
        exitCode: EXIT_OK,
        stdout: emitJson({ ok: true, issues: [], repairs: [] }),
        stderr: '',
      };
    }
    return { exitCode: EXIT_OK, stdout: 'review reconcile: clean.\n', stderr: '' };
  }

  if (!opts.apply) {
    if (opts.json) {
      return {
        exitCode: EXIT_FINDINGS,
        stdout: emitJson({ ok: false, issues, repairs: [] }),
        stderr: '',
      };
    }
    return { exitCode: EXIT_FINDINGS, stdout: renderIssues(issues, false), stderr: '' };
  }

  const reviewsDir = join(outcome.cwd, outcome.config.paths.reviews);
  const opRoot = await operationalRootBestEffort(outcome.cwd);

  // Deduplicate sprints with multiple issues attributed to the same broken
  // pointer.
  const affected = uniqueSprints(issues);

  // Filter the duplicate-review-id collisions to keep exactly one sprint
  // bound to the original review file (the first by sorted sprint id, for
  // determinism). Without this, every sprint in a duplicate set gets a fresh
  // R-NNN and the original review file becomes orphaned. The kept sprint
  // does not need any mutation — its frontmatter already points at the
  // correct review file.
  const sprintsToReallocate = filterKeepFirstOnDuplicates(affected);

  const allocations = await allocateReviewIds(
    sprintsToReallocate.map((s) => s.sprintId as SprintId),
    reviewsDir,
    opRoot,
  );

  const repairs: ReviewRepair[] = [];
  for (const sprint of sprintsToReallocate) {
    const newId = allocations.get(sprint.sprintId as SprintId);
    if (!newId) continue;
    await mutateSprintFrontmatter(join(outcome.cwd, sprint.sprintFile), {
      review_id: newId,
    });
    repairs.push({
      sprintId: sprint.sprintId,
      fromReviewId: sprint.currentReviewId,
      toReviewId: newId,
    });
  }

  if (opts.json) {
    return {
      exitCode: EXIT_OK,
      stdout: emitJson({ ok: true, issues, repairs }),
      stderr: '',
    };
  }
  const out = `${renderIssues(issues, true)}\n${renderRepairs(repairs)}`;
  return { exitCode: EXIT_OK, stdout: out, stderr: '' };
}

function detectIssues(
  sprints: readonly Sprint[],
  graph: { reviews: ReadonlyMap<string, { id: string; sprint_id: string }> },
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const reviewIdToSprints = new Map<string, string[]>();

  for (const sprint of sprints) {
    if (sprint.review_id === null || sprint.review_id === undefined) continue;
    const reviewId = String(sprint.review_id);
    const list = reviewIdToSprints.get(reviewId) ?? [];
    list.push(sprint.id);
    reviewIdToSprints.set(reviewId, list);

    const review = graph.reviews.get(reviewId);
    if (!review) {
      issues.push({
        kind: 'missing_review_file',
        sprintId: sprint.id,
        sprintFile: sprint.file,
        currentReviewId: reviewId,
        detail: `sprint references ${reviewId} but no review file exists`,
      });
      continue;
    }
    if (review.sprint_id !== sprint.id) {
      issues.push({
        kind: 'review_sprint_mismatch',
        sprintId: sprint.id,
        sprintFile: sprint.file,
        currentReviewId: reviewId,
        detail: `sprint references ${reviewId} but review.sprint_id is ${review.sprint_id}`,
      });
    }
  }

  for (const [reviewId, sprintIds] of reviewIdToSprints) {
    if (sprintIds.length <= 1) continue;
    for (const sprintId of sprintIds) {
      const sprint = sprints.find((s) => s.id === sprintId);
      if (!sprint) continue;
      issues.push({
        kind: 'duplicate_review_id',
        sprintId,
        sprintFile: sprint.file,
        currentReviewId: reviewId,
        detail: `${reviewId} is also referenced by ${sprintIds
          .filter((id) => id !== sprintId)
          .join(', ')}`,
      });
    }
  }

  return issues;
}

function uniqueSprints(issues: readonly ReviewIssue[]): ReviewIssue[] {
  const byId = new Map<string, ReviewIssue>();
  for (const issue of issues) {
    if (!byId.has(issue.sprintId)) byId.set(issue.sprintId, issue);
  }
  return [...byId.values()];
}

/**
 * In a duplicate_review_id collision, only one sprint can keep the original
 * review file pointer; the rest must allocate fresh review IDs. This picks
 * the first sprint by sorted sprint_id deterministically and excludes it
 * from the reallocation list. Sprints with non-collision issues
 * (missing_review_file, review_sprint_mismatch) are unaffected.
 *
 * Without this filter, every sprint in a collision set gets a fresh R-NNN
 * and the original review file is left orphaned with no sprint pointing at
 * it — exactly the cleanup gap surfaced in code review.
 */
function filterKeepFirstOnDuplicates(affected: readonly ReviewIssue[]): ReviewIssue[] {
  const collidingSets = new Map<string, ReviewIssue[]>();
  for (const issue of affected) {
    if (issue.kind !== 'duplicate_review_id' || issue.currentReviewId === null) continue;
    const list = collidingSets.get(issue.currentReviewId) ?? [];
    list.push(issue);
    collidingSets.set(issue.currentReviewId, list);
  }
  const keepSprintIds = new Set<string>();
  for (const list of collidingSets.values()) {
    const sortedById = [...list].sort((a, b) => a.sprintId.localeCompare(b.sprintId));
    const keeper = sortedById[0];
    if (keeper) keepSprintIds.add(keeper.sprintId);
  }
  return affected.filter((issue) => !keepSprintIds.has(issue.sprintId));
}

function renderIssues(issues: readonly ReviewIssue[], applied: boolean): string {
  const header = applied
    ? `Reconciled ${issues.length} issue(s):`
    : `review reconcile: ${issues.length} issue(s) detected (run with --apply to repair):`;
  const lines = [header, ''];
  for (const issue of issues) {
    lines.push(`  [${issue.kind}] ${issue.sprintId}  ${issue.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderRepairs(repairs: readonly ReviewRepair[]): string {
  if (repairs.length === 0) return 'no repairs applied.\n';
  const lines = [`Repairs applied (${repairs.length}):`, ''];
  for (const r of repairs) {
    lines.push(`  ${r.sprintId}: ${r.fromReviewId ?? '(none)'} -> ${r.toReviewId}`);
  }
  return `${lines.join('\n')}\n`;
}
