import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const blockedByRefsRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const sprint of parsed.sprints) {
    for (const blocker of sprint.blocked_by) {
      if (!graph.sprints.has(blocker)) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.BLOCKED_BY_REFERENCES_MISSING_SPRINT,
          message: `sprint ${sprint.id} is blocked_by missing sprint ${blocker}`,
          file: sprint.file,
          entityType: 'sprint',
          entityId: sprint.id,
          data: { blocker },
        });
      }
    }
  }
  return out;
};
