import type { Finding } from '../../schemas/finding.js';
import { parseSprintIdNumber } from '../../schemas/ids.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

// Sprint statuses where flagging missing review is meaningful. Already-shipped
// sprints get caught by the existing SHIPPED_SPRINT_MISSING_REVIEW family;
// cancelled sprints are out of scope. Flagging anything pre-shipped lets the
// agent fix the frontmatter (or the policy threshold) before close.
const TERMINAL_SPRINT_STATUSES = new Set(['shipped', 'cancelled']);

/**
 * Flag sprints whose numeric ID is at or above
 * `policies.requireReviewForShippedFromSprintId` but whose `review_required`
 * frontmatter is false. Off by default — only fires when the threshold is
 * configured. Lets a project enforce ADR 26 ("review from S-NNN onward")
 * without rewriting every sprint's frontmatter.
 */
export const sprintReviewByPolicyRule: ValidatorRule = ({ graph, config }) => {
  const threshold = config.policies.requireReviewForShippedFromSprintId;
  if (threshold === undefined) return [];

  const out: Finding[] = [];
  for (const sprint of graph.sprints.values()) {
    if (TERMINAL_SPRINT_STATUSES.has(sprint.status)) continue;
    if (sprint.review_required) continue;
    const num = parseSprintIdNumber(sprint.id);
    if (num === null || num < threshold) continue;
    out.push({
      severity: 'P1',
      code: FINDING_CODES.SPRINT_REVIEW_REQUIRED_BY_POLICY,
      message: `sprint ${sprint.id} has review_required: false but policies.requireReviewForShippedFromSprintId is ${threshold}`,
      file: sprint.file,
      entityType: 'sprint',
      entityId: sprint.id,
      suggestion: `set review_required: true (policy threshold S-${String(threshold).padStart(3, '0')})`,
      data: { threshold, sprint_number: num },
    });
  }
  return out;
};
