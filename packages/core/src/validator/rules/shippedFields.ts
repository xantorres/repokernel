import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const shippedFieldsRule: ValidatorRule = ({ parsed, config }) => {
  const out: Finding[] = [];
  for (const sprint of parsed.sprints) {
    if (sprint.status !== 'shipped') continue;

    if (!sprint.closed_at) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SHIPPED_SPRINT_MISSING_CLOSED_AT,
        message: `shipped sprint ${sprint.id} is missing closed_at`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
      });
    }

    if (config.policies.requireEndShaForShipped && !sprint.end_sha) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SHIPPED_SPRINT_MISSING_END_SHA,
        message: `shipped sprint ${sprint.id} is missing end_sha`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        suggestion: 'capture end_sha at close so review diff base_sha..end_sha can be re-derived',
      });
    }

    if (!sprint.base_sha) {
      out.push({
        severity: 'P2',
        code: FINDING_CODES.SHIPPED_SPRINT_MISSING_BASE_SHA,
        message: `shipped sprint ${sprint.id} is missing base_sha`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        suggestion:
          'reconstruct base_sha from run state start_sha, the linked review base_sha, or pass --base-sha on rk fix',
      });
    }

    // SHIPPED_SPRINT_MISSING_REVIEW is now emitted by reviewIntegrityRule
    // (live scope) so the threshold bypass identified in finding 12 is
    // caught by `rk validate` and not just `rk validate --audit`. No
    // duplicate finding here — kept as a comment so the move is
    // discoverable.
  }
  return out;
};
