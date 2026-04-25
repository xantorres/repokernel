import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const sprintEpicMembershipRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const sprint of parsed.sprints) {
    const epicIds = graph.epicsBySprint.get(sprint.id) ?? [];
    const presentEpics = epicIds.filter((id) => graph.epics.has(id));
    if (presentEpics.length === 0) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_WITHOUT_EPIC,
        message: `sprint ${sprint.id} declares epic_id ${sprint.epic_id} but no matching epic exists`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
      });
    } else if (presentEpics.length > 1) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_IN_MULTIPLE_EPICS,
        message: `sprint ${sprint.id} is referenced by ${presentEpics.length} epics: ${presentEpics.join(', ')}`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { epics: presentEpics },
      });
    }
  }
  return out;
};
