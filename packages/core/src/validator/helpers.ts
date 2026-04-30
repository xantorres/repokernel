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

/**
 * Effective review requirement for a sprint, combining frontmatter and
 * policy.
 *
 * A sprint requires an accepted review at ship time when:
 *   - `policies.requireReviewForShipped` is true, AND
 *   - either `sprint.review_required` is true, OR the sprint's numeric ID
 *     is at or above `policies.requireReviewForShippedFromSprintId`.
 *
 * The threshold rule is what closes the bypass path called out as P1 in
 * finding 12: a shipped sprint editing its frontmatter to
 * `review_required: false` could otherwise skip the review gate even
 * though the project's threshold policy was meant to enforce it.
 *
 * `requireReviewForShipped: false` always disables the gate (it is the
 * project-wide opt-out). Returns `false` for sprints that have it off.
 */
export function effectiveReviewRequired(
  sprint: Pick<Sprint, 'id' | 'review_required'>,
  config: Pick<Config, 'policies'>,
): boolean {
  if (!config.policies.requireReviewForShipped) return false;
  if (sprint.review_required) return true;
  const threshold = config.policies.requireReviewForShippedFromSprintId;
  if (threshold === undefined) return false;
  const num = parseSprintIdNumber(sprint.id);
  if (num === null) return false;
  return num >= threshold;
}
