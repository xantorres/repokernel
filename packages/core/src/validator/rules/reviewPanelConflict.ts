import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const reviewPanelConflictRule: ValidatorRule = ({ parsed }) => {
  const findings: Finding[] = [];

  for (const review of parsed.reviews) {
    const panelAggregate = (review as { panel_aggregate?: unknown }).panel_aggregate;
    if (panelAggregate === undefined) continue;

    // Use the policy snapshot taken when the panel ran. Falling back to the
    // legacy default (yellow_blocks_close: false) is a no-op for older
    // reviews — only YELLOW + changes_requested needs the snapshot to avoid
    // self-invalidation.
    const snapshot = (review as { panel_policy_snapshot?: { yellow_blocks_close?: boolean } })
      .panel_policy_snapshot;
    const yellowBlocksClose = snapshot?.yellow_blocks_close ?? false;

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

    if (panelAggregate === 'GREEN' && review.verdict === 'changes_requested') {
      findings.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEW_PANEL_VERDICT_CONFLICT,
        message: `review ${review.id} has panel_aggregate GREEN but verdict is changes_requested — state is corrupt`,
        entityType: 'review',
        entityId: review.id,
        file: review.file,
        suggestion: 'run rk review-verdict to correct the verdict or re-run the panel',
      });
    }

    if (
      panelAggregate === 'YELLOW' &&
      review.verdict === 'changes_requested' &&
      !yellowBlocksClose
    ) {
      findings.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEW_PANEL_VERDICT_CONFLICT,
        message: `review ${review.id} has panel_aggregate YELLOW but verdict is changes_requested under a policy that does not block close — state is corrupt`,
        entityType: 'review',
        entityId: review.id,
        file: review.file,
        suggestion: 'run rk review-verdict to correct the verdict or re-run the panel',
      });
    }
  }

  return findings;
};
