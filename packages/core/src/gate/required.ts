import {
  type Automation,
  type Config,
  type ReviewerGateConfig,
  resolveReviewerGate,
} from '../config/schema.js';
import type { ReviewVerdict } from '../schemas/review.js';
import type { Sprint } from '../schemas/sprint.js';
import { effectiveReviewRequired } from '../validator/helpers.js';

/**
 * A reviewer-gate snapshot is mandatory for closing `sprint` when the project
 * both requires review for it AND configures a default reviewer gate. Anchored
 * on config + the sprint's `review_required`, never on the mutable
 * `review.reviewer` field, so a snapshot/review cannot dodge the gate by
 * renaming its reviewer. Pure.
 */
export function gateRequired(
  sprint: Pick<Sprint, 'id' | 'review_required'>,
  config: Pick<Config, 'policies' | 'automation'>,
): boolean {
  return effectiveReviewRequired(sprint, config) && resolveReviewerGate(config.automation) !== null;
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
