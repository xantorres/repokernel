import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const sprintEpicMembershipRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const sprint of parsed.sprints) {
    const declaredEpic = graph.epics.get(sprint.epic_id);
    if (!declaredEpic) {
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

    const listedBy = parsed.epics
      .filter((epic) => epic.sprints.includes(sprint.id))
      .map((epic) => epic.id);
    if (!declaredEpic.sprints.includes(sprint.id)) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_WITHOUT_EPIC,
        message: `sprint ${sprint.id} declares epic_id ${sprint.epic_id} but epic ${sprint.epic_id} does not list it`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { epic_id: sprint.epic_id },
      });
    }

    const unexpectedOwners = listedBy.filter((id) => id !== sprint.epic_id);
    if (unexpectedOwners.length > 0) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_IN_MULTIPLE_EPICS,
        message: `sprint ${sprint.id} declares epic_id ${sprint.epic_id} but is also listed by: ${unexpectedOwners.join(', ')}`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { declared_epic: sprint.epic_id, extra_epics: unexpectedOwners },
      });
    }
  }
  return out;
};
