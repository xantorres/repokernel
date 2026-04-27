import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const sprintEpicMembershipRule: ValidatorRule = ({ graph }) => {
  const out: Finding[] = [];
  for (const sprint of graph.sprints.values()) {
    if (!graph.epics.get(sprint.epic_id)) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_WITHOUT_EPIC,
        message: `sprint ${sprint.id} declares epic_id ${sprint.epic_id} but no matching epic exists`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
      });
      continue;
    }

    // Epics that claim this sprint via their ordering hint but are not the declared epic
    const claimants = (graph.epicsBySprint.get(sprint.id) ?? []).filter(
      (id) => id !== sprint.epic_id,
    );
    if (claimants.length > 0) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_IN_MULTIPLE_EPICS,
        message: `sprint ${sprint.id} declares epic_id ${sprint.epic_id} but is also listed by: ${claimants.join(', ')}`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { declared_epic: sprint.epic_id, extra_epics: claimants },
      });
    }
  }
  return out;
};
