import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const queuedDependencyShippedRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const queue of parsed.queues) {
    for (const slot of queue.slots) {
      const sprint = graph.sprints.get(slot.sprint_id);
      if (!sprint) continue;
      if (sprint.status !== 'queued') continue;
      for (const dep of sprint.depends_on) {
        const depSprint = graph.sprints.get(dep);
        if (!depSprint || depSprint.status !== 'shipped') {
          out.push({
            severity: 'P1',
            code: FINDING_CODES.QUEUED_DEPENDENCY_NOT_SHIPPED,
            message: `queued sprint ${sprint.id} depends on ${dep} which is not shipped`,
            file: sprint.file,
            entityType: 'sprint',
            entityId: sprint.id,
            data: { dependency: dep, dependency_status: depSprint?.status ?? null },
          });
        }
      }
    }
  }
  return out;
};
