import type { Finding } from '../../schemas/finding.js';
import type { ValidatorRule } from '../engine.js';
import { FINDING_CODES } from '../codes.js';

export const activeFieldsRule: ValidatorRule = ({ parsed, config }) => {
  const out: Finding[] = [];
  for (const sprint of parsed.sprints) {
    if (sprint.status !== 'active') continue;
    if (!sprint.started_at) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.ACTIVE_SPRINT_MISSING_STARTED_AT,
        message: `active sprint ${sprint.id} is missing started_at`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        suggestion: 'set started_at to the ISO 8601 timestamp when work began',
      });
    }
    if (config.policies.requireBaseShaForActive && !sprint.base_sha) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.ACTIVE_SPRINT_MISSING_BASE_SHA,
        message: `active sprint ${sprint.id} is missing base_sha`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        suggestion: 'capture base_sha at start so review diff can be computed against it',
      });
    }
  }
  return out;
};
