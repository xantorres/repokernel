import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const dependencyRefsRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const sprint of parsed.sprints) {
    for (const dep of sprint.depends_on) {
      if (!graph.sprints.has(dep)) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.DEPENDENCY_REFERENCES_MISSING_SPRINT,
          message: `sprint ${sprint.id} depends on missing sprint ${dep}`,
          file: sprint.file,
          entityType: 'sprint',
          entityId: sprint.id,
          data: { dependency: dep },
        });
      }
    }
  }
  return out;
};
