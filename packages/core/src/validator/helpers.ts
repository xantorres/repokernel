import type { Config } from '../config/schema.js';
import type { Graph } from '../graph/types.js';
import { parseSprintIdNumber } from '../schemas/ids.js';
import type { Review } from '../schemas/review.js';
import type { Sprint } from '../schemas/sprint.js';

export function getSprintReviews(sprintId: string, graph: Graph): Review[] {
  return (graph.reviewsBySprint.get(sprintId) ?? [])
    .map((rid) => graph.reviews.get(rid))
    .filter((r): r is Review => r !== undefined);
}

export function hasAcceptedReview(sprintId: string, graph: Graph): boolean {
  return getSprintReviews(sprintId, graph).some((r) => r.verdict === 'accepted');
}

export type ReviewRequirementReason = 'project-opt-out' | 'sprint-flag' | 'threshold' | 'none';

export interface ReviewRequirement {
  readonly required: boolean;
  readonly reason: ReviewRequirementReason;
}

/**
 * Effective review requirement for a sprint, combining frontmatter and
 * policy. Returns a discriminated reason so callers can distinguish the
 * sprint-flag path (legacy) from the threshold path (closes finding 12)
 * — the live validator surface uses this to scope the live-vs-audit
 * promotion to threshold-driven enforcement only.
 *
 * Rules:
 *   - `requireReviewForShipped: false` is the project-wide opt-out;
 *     returns { required: false, reason: 'project-opt-out' }.
 *   - Otherwise, `sprint.review_required` true returns sprint-flag.
 *   - Otherwise, sprint number ≥ `requireReviewForShippedFromSprintId`
 *     returns threshold.
 *   - Otherwise none.
 *
 * Malformed sprint IDs (`parseSprintIdNumber === null`) **fail closed**
 * when a threshold is configured: returning `required: true` with
 * reason: 'threshold' so the gate is not silently bypassed by a typo.
 */
export function effectiveReviewRequirement(
  sprint: Pick<Sprint, 'id' | 'review_required'>,
  config: Pick<Config, 'policies'>,
): ReviewRequirement {
  if (!config.policies.requireReviewForShipped) {
    return { required: false, reason: 'project-opt-out' };
  }
  if (sprint.review_required) return { required: true, reason: 'sprint-flag' };
  const threshold = config.policies.requireReviewForShippedFromSprintId;
  if (threshold === undefined) return { required: false, reason: 'none' };
  const num = parseSprintIdNumber(sprint.id);
  if (num === null) {
    // Malformed id + threshold set: fail closed. ID-format validators run
    // upstream as P0; arriving here is a defensive belt-and-suspenders
    // path.
    return { required: true, reason: 'threshold' };
  }
  if (num >= threshold) return { required: true, reason: 'threshold' };
  return { required: false, reason: 'none' };
}

/**
 * Boolean wrapper around `effectiveReviewRequirement` for legacy callers.
 */
export function effectiveReviewRequired(
  sprint: Pick<Sprint, 'id' | 'review_required'>,
  config: Pick<Config, 'policies'>,
): boolean {
  return effectiveReviewRequirement(sprint, config).required;
}
