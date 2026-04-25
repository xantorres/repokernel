import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const pathConstraintsRule: ValidatorRule = ({ parsed }) => {
  const out: Finding[] = [];

  for (const sprint of parsed.sprints) {
    if (sprint.allowed_paths.length === 0 && sprint.denied_paths.length === 0) continue;
    out.push({
      severity: 'P3',
      code: FINDING_CODES.SPRINT_HAS_UNVALIDATED_PATH_CONSTRAINTS,
      message: `sprint ${sprint.id} declares path constraints but path enforcement is not active in this version`,
      file: sprint.file,
      entityType: 'sprint',
      entityId: sprint.id,
      data: { allowed_paths: sprint.allowed_paths, denied_paths: sprint.denied_paths },
    });
  }

  return out;
};
