import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';
import { getSprintReviews } from '../helpers.js';

const NEGATIVE_VERDICTS = new Set(['rejected', 'changes_requested']);

export const reviewConflictRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];

  for (const sprint of parsed.sprints) {
    const reviews = getSprintReviews(sprint.id, graph);
    if (reviews.length < 2) continue;

    const hasAccepted = reviews.some((r) => r.verdict === 'accepted');
    const hasNegative = reviews.some((r) => NEGATIVE_VERDICTS.has(r.verdict));

    if (!(hasAccepted && hasNegative)) continue;

    const verdicts = reviews.map((r) => `${r.id}=${r.verdict}`).join(', ');
    out.push({
      severity: 'P2',
      code: FINDING_CODES.SPRINT_REVIEW_VERDICT_CONFLICT,
      message: `sprint ${sprint.id} has conflicting review verdicts (${verdicts})`,
      file: sprint.file,
      entityType: 'sprint',
      entityId: sprint.id,
      data: { reviews: reviews.map((r) => ({ id: r.id, verdict: r.verdict })) },
    });
  }

  return out;
};
