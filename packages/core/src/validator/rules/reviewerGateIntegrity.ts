import { gateRequired } from '../../gate/required.js';
import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

/**
 * Live integrity of a PRESENT reviewer_gate snapshot on shipped, gate-required
 * sprints. Structural only — it cannot verify the HMAC signature (the
 * machine-local key is not available to the pure validator engine, and CI runs
 * without it). Signature authenticity + freshness are enforced at `rk close`,
 * the only path that ships. This rule catches a snapshot that was downgraded,
 * left on a stale attempt, attributed to the wrong reviewer, or whose base
 * commit drifted. A MISSING snapshot is handled separately at audit scope
 * (`reviewerGateMissingRule`) so upgrading a repo with pre-snapshot shipped
 * history does not flood live validation.
 */
export const reviewerGateIntegrityRule: ValidatorRule = ({ graph, parsed, config }) => {
  const out: Finding[] = [];

  for (const sprint of parsed.sprints) {
    if (sprint.status !== 'shipped') continue;
    if (!sprint.review_id) continue;

    const review = graph.reviews.get(sprint.review_id);
    if (!review) continue; // dangling review_id handled by reviewIntegrityRule

    const snapshot = review.reviewer_gate;
    if (!snapshot) continue; // missing handled by reviewerGateMissingRule (audit)
    if (!gateRequired(sprint, config, review)) continue;

    if (snapshot.reviewer !== review.reviewer) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEWER_GATE_SIGNATURE_INVALID,
        message: `review ${review.id} is stamped reviewer "${review.reviewer}" but its reviewer_gate was produced by "${snapshot.reviewer}"`,
        file: review.file,
        entityType: 'review',
        entityId: review.id,
        data: { review_reviewer: review.reviewer, gate_reviewer: snapshot.reviewer },
      });
    }

    if (snapshot.verdict !== 'accepted') {
      out.push({
        severity: 'P0',
        code: FINDING_CODES.REVIEWER_GATE_NOT_ACCEPTED,
        message: `shipped sprint ${sprint.id} reviewer_gate verdict is ${snapshot.verdict}`,
        file: review.file,
        entityType: 'review',
        entityId: review.id,
        data: { verdict: snapshot.verdict },
      });
    }

    if (snapshot.review_attempt !== review.review_attempt) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEWER_GATE_ATTEMPT_MISMATCH,
        message: `review ${review.id} reviewer_gate is for attempt ${snapshot.review_attempt} but review_attempt is ${review.review_attempt}`,
        file: review.file,
        entityType: 'review',
        entityId: review.id,
        data: { snapshot_attempt: snapshot.review_attempt, review_attempt: review.review_attempt },
      });
    }

    // base_sha is fixed at sprint start; a snapshot whose base differs was
    // signed against a different range. end_sha is NOT compared: close advances
    // sprint.end_sha past the gate's reviewed commit with its own metadata
    // commit, so equality would always fail post-close.
    if (sprint.base_sha && snapshot.base_sha !== sprint.base_sha) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.REVIEWER_GATE_STALE,
        message: `sprint ${sprint.id} base_sha ${sprint.base_sha} does not match reviewer_gate base_sha ${snapshot.base_sha}`,
        file: review.file,
        entityType: 'review',
        entityId: review.id,
        data: { sprint_base_sha: sprint.base_sha, gate_base_sha: snapshot.base_sha },
      });
    }
  }

  return out;
};

/**
 * Audit-scope check for a shipped, gate-required sprint whose review carries NO
 * reviewer_gate snapshot. Audit (not live) by design: a repo upgraded to the
 * snapshot model has historical shipped sprints with no snapshot, and a past
 * close cannot be cheaply or safely backfilled. Forward enforcement happens at
 * close; this surfaces the gap on demand without breaking `rk validate`.
 * Mirrors the `shippedFieldsRule` audit treatment of frozen post-close state.
 */
export const reviewerGateMissingRule: ValidatorRule = ({ graph, parsed, config }) => {
  const out: Finding[] = [];

  for (const sprint of parsed.sprints) {
    if (sprint.status !== 'shipped') continue;
    if (!sprint.review_id) continue;

    const review = graph.reviews.get(sprint.review_id);
    if (!review) continue;
    if (review.reviewer_gate) continue;
    if (!gateRequired(sprint, config, review)) continue;

    out.push({
      severity: 'P1',
      code: FINDING_CODES.REVIEWER_GATE_MISSING,
      message: `shipped sprint ${sprint.id} requires a reviewer gate but ${review.id} has no reviewer_gate snapshot`,
      file: review.file,
      entityType: 'review',
      entityId: review.id,
    });
  }

  return out;
};
