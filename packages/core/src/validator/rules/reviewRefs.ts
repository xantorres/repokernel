import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const reviewRefsRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const review of parsed.reviews) {
    if (!graph.sprints.has(review.sprint_id)) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEW_REFERENCES_MISSING_SPRINT,
        message: `review ${review.id} references missing sprint ${review.sprint_id}`,
        file: review.file,
        entityType: 'review',
        entityId: review.id,
        data: { sprint_id: review.sprint_id },
      });
    }
  }
  return out;
};
