import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const queueStatusRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  const queuedSprintIds = new Set<string>();
  for (const queue of parsed.queues) {
    for (const slot of queue.slots) {
      queuedSprintIds.add(slot.sprint_id);
      const sprint = graph.sprints.get(slot.sprint_id);
      if (!sprint) continue;
      switch (sprint.status) {
        case 'shipped':
          out.push({
            severity: 'P2',
            code: FINDING_CODES.SHIPPED_SPRINT_IN_QUEUE,
            message: `shipped sprint ${sprint.id} is still in queue lane "${queue.lane}"`,
            file: queue.file,
            entityType: 'queue',
            entityId: sprint.id,
            data: { lane: queue.lane },
          });
          break;
        case 'cancelled':
          out.push({
            severity: 'P2',
            code: FINDING_CODES.CANCELLED_SPRINT_IN_QUEUE,
            message: `cancelled sprint ${sprint.id} is still in queue lane "${queue.lane}"`,
            file: queue.file,
            entityType: 'queue',
            entityId: sprint.id,
            data: { lane: queue.lane },
          });
          break;
        case 'pending':
          out.push({
            severity: 'P1',
            code: FINDING_CODES.PENDING_SPRINT_IN_QUEUE_AS_RUNNABLE,
            message: `pending sprint ${sprint.id} is in queue lane "${queue.lane}" but is not runnable`,
            file: queue.file,
            entityType: 'queue',
            entityId: sprint.id,
            data: { lane: queue.lane },
          });
          break;
        default:
          break;
      }
    }
  }

  for (const sprint of parsed.sprints) {
    if (sprint.status === 'active' && !queuedSprintIds.has(sprint.id)) {
      out.push({
        severity: 'P2',
        code: FINDING_CODES.ACTIVE_SPRINT_NOT_IN_QUEUE,
        message: `active sprint ${sprint.id} is not represented in any queue`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
      });
    }
  }
  return out;
};
