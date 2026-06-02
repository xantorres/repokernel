import { gateRequired } from '../../gate/required.js';
import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

/**
 * Post-hoc integrity of the reviewer_gate snapshot on shipped, gate-required
 * sprints. Structural only — it cannot verify the HMAC signature (the
 * machine-local key is not available to the pure validator engine, and CI runs
 * without it). Signature authenticity is enforced at `rk close`, the only path
 * that ships. This rule is the CI-side net that catches a snapshot that was
 * removed, downgraded, left on a stale attempt, or whose committed range drifted
 * from the shipped sprint after the fact.
 */
export const reviewerGateIntegrityRule: ValidatorRule = ({ graph, parsed, config }) => {
  const out: Finding[] = [];

  for (const sprint of parsed.sprints) {
    if (sprint.status !== 'shipped') continue;
    if (!gateRequired(sprint, config)) continue;
    if (!sprint.review_id) continue; // missing-review handled by reviewIntegrityRule

    const review = graph.reviews.get(sprint.review_id);
    if (!review) continue; // dangling review_id handled by reviewIntegrityRule

    const snapshot = review.reviewer_gate;
    if (!snapshot) {
      out.push({
        severity: 'P0',
        code: FINDING_CODES.REVIEWER_GATE_MISSING,
        message: `shipped sprint ${sprint.id} requires a reviewer gate but ${review.id} has no reviewer_gate snapshot`,
        file: review.file,
        entityType: 'review',
        entityId: review.id,
      });
      continue;
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
    // signed against a different range. end_sha is intentionally NOT compared:
    // close advances sprint.end_sha past the gate's reviewed commit with its own
    // metadata commit, so equality would always fail post-close. Content
    // freshness against the gate's end_sha is enforced at close (always-on).
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
