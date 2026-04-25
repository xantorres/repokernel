import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const epicRefsRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const epic of parsed.epics) {
    for (const sid of epic.sprints) {
      if (!graph.sprints.has(sid)) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.EPIC_REFERENCES_MISSING_SPRINT,
          message: `epic ${epic.id} references missing sprint ${sid}`,
          file: epic.file,
          entityType: 'epic',
          entityId: epic.id,
          data: { sprint_id: sid },
        });
      }
    }
  }
  return out;
};
