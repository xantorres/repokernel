import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const epicRefsRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const epic of parsed.epics) {
    const orderingSet = new Set(epic.sprints);

    // Validate each entry in the epic.sprints[] ordering hint
    for (const sid of epic.sprints) {
      const sprint = graph.sprints.get(sid);
      if (!sprint) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.EPIC_REFERENCES_MISSING_SPRINT,
          message: `epic ${epic.id} references missing sprint ${sid}`,
          file: epic.file,
          entityType: 'epic',
          entityId: epic.id,
          data: { sprint_id: sid },
        });
      } else if (sprint.epic_id !== epic.id) {
        out.push({
          severity: 'P2',
          code: FINDING_CODES.EPIC_SPRINT_BACK_POINTER_CONFLICT,
          message: `epic ${epic.id} ordering hint lists sprint ${sid} but that sprint declares epic_id ${sprint.epic_id}`,
          file: epic.file,
          entityType: 'epic',
          entityId: epic.id,
          data: { sprint_id: sid, declared_epic: sprint.epic_id },
        });
      }
    }

    // Warn on members (via back-pointer) absent from the ordering hint
    for (const sid of graph.sprintsByEpic.get(epic.id) ?? []) {
      if (!orderingSet.has(sid)) {
        const sprint = graph.sprints.get(sid);
        out.push({
          severity: 'P2',
          code: FINDING_CODES.EPIC_SPRINT_NOT_IN_ORDERING,
          message: `sprint ${sid} declares epic_id ${epic.id} but is not listed in epic ${epic.id} sprints[] ordering hint (will be appended at end)`,
          file: sprint?.file ?? epic.file,
          entityType: 'sprint',
          entityId: sid,
          data: { epic_id: epic.id },
        });
      }
    }
  }
  return out;
};
