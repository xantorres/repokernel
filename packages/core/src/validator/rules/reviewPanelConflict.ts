import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const reviewPanelConflictRule: ValidatorRule = ({ parsed }) => {
  const findings: Finding[] = [];

  for (const review of parsed.reviews) {
    const panelAggregate = (review as { panel_aggregate?: unknown }).panel_aggregate;
    if (panelAggregate === undefined) continue;

    if (panelAggregate === 'RED' && review.verdict === 'accepted') {
      findings.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEW_PANEL_VERDICT_CONFLICT,
        message: `review ${review.id} has panel_aggregate RED but verdict is accepted — state is corrupt`,
        entityType: 'review',
        entityId: review.id,
        file: review.file,
        suggestion: 'run rk review-panel run to re-evaluate or set verdict manually',
      });
    }

    if (
      (panelAggregate === 'GREEN' || panelAggregate === 'YELLOW') &&
      review.verdict === 'changes_requested'
    ) {
      findings.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEW_PANEL_VERDICT_CONFLICT,
        message: `review ${review.id} has panel_aggregate ${String(panelAggregate)} but verdict is changes_requested — state is corrupt`,
        entityType: 'review',
        entityId: review.id,
        file: review.file,
        suggestion: 'run rk review-verdict to correct the verdict or re-run the panel',
      });
    }
  }

  return findings;
};
