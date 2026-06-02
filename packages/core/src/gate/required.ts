import {
  type Automation,
  type Config,
  type ReviewerGateConfig,
  resolveReviewerGate,
} from '../config/schema.js';
import type { Review, ReviewVerdict } from '../schemas/review.js';
import type { Sprint } from '../schemas/sprint.js';
import { effectiveReviewRequired } from '../validator/helpers.js';

/** The review fields that influence whether a gate is required. */
export type GateRequirementReview = Pick<Review, 'reviewer' | 'reviewer_gate'>;

/**
 * A reviewer-gate snapshot is mandatory for closing `sprint` when the project
 * requires review for it AND a gate applies. A gate applies when the project
 * configures a default gate, OR the linked review is stamped with a configured
 * (possibly non-default) reviewer, OR a snapshot already exists on the review.
 *
 * The last two clauses close the dodge where a project's default reviewer has
 * no gate but the review was stamped with a gated reviewer (or already carries a
 * gate result): such a review must still be enforced, not silently ignored.
 * Anchored on config + `review_required` + the linked review — never letting a
 * mutable field flip the requirement OFF. Pure.
 */
export function gateRequired(
  sprint: Pick<Sprint, 'id' | 'review_required'>,
  config: Pick<Config, 'policies' | 'automation'>,
  review?: GateRequirementReview,
): boolean {
  // A recorded snapshot is a commitment: enforce it regardless of the current
  // policy. Otherwise a post-gate config edit (opt out of review, or raise the
  // threshold above this sprint) would void a signed gate verdict — a bypass.
  if (review?.reviewer_gate != null) return true;
  if (!effectiveReviewRequired(sprint, config)) return false;
  if (resolveReviewerGate(config.automation) !== null) return true;
  if (review && reviewerGateConfigFor(config.automation, review.reviewer) !== undefined)
    return true;
  return false;
}

/**
 * The gate configured for a specific stamped reviewer, if any. When
 * `gateRequired` is true but this returns undefined, the review named a
 * reviewer with no configured gate — callers fail closed. Pure.
 */
export function reviewerGateConfigFor(
  automation: Automation,
  reviewerName: string,
): ReviewerGateConfig | undefined {
  return automation.reviewers?.[reviewerName];
}

const VERDICT_RANK: Record<ReviewVerdict, number> = {
  rejected: 3,
  changes_requested: 2,
  accepted: 1,
  pending: 0,
};

/**
 * Most-restrictive-wins composition of two review verdicts, matching the
 * registry merge precedence (`rejected > changes_requested > accepted >
 * pending`). Symmetric. Used to surface a single combined verdict for a sprint
 * whose gate lane and built-in/panel lane may disagree. Pure.
 */
export function composeVerdict(a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict {
  if (a === b) return a;
  if (a === 'rejected' || b === 'rejected') return 'rejected';
  if (a === 'changes_requested' || b === 'changes_requested') return 'changes_requested';
  if (a === 'accepted' || b === 'accepted') return 'accepted';
  return 'pending';
}

export { VERDICT_RANK };
