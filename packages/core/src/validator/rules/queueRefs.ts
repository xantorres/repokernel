import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const queueRefsRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const queue of parsed.queues) {
    for (const slot of queue.slots) {
      const sprint = graph.sprints.get(slot.sprint_id);
      if (!sprint) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.QUEUE_REFERENCES_MISSING_SPRINT,
          message: `queue lane "${queue.lane}" slot ${slot.id} references missing sprint ${slot.sprint_id}`,
          file: queue.file,
          entityType: 'queue',
          entityId: slot.id,
          data: { lane: queue.lane, sprint_id: slot.sprint_id },
        });
        continue;
      }
      if (sprint.lane !== queue.lane) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.QUEUE_SLOT_LANE_MISMATCH,
          message: `queue lane "${queue.lane}" slot ${slot.id} references sprint ${sprint.id} in lane "${sprint.lane}"`,
          file: queue.file,
          entityType: 'queue',
          entityId: slot.id,
          suggestion: `move sprint ${sprint.id} to lane "${queue.lane}" or place it in the "${sprint.lane}" queue`,
          data: { queue_lane: queue.lane, sprint_id: sprint.id, sprint_lane: sprint.lane },
        });
      }
    }
  }
  return out;
};

export const queueDuplicateRule: ValidatorRule = ({ parsed }) => {
  const out: Finding[] = [];
  const globalSlotIds = new Map<string, string[]>();

  for (const queue of parsed.queues) {
    const orderCounts = new Map<number, string[]>();
    const idCounts = new Map<string, string[]>();
    const sprintCounts = new Map<string, string[]>();
    for (const slot of queue.slots) {
      pushTo(orderCounts, slot.order, slot.id);
      pushTo(idCounts, slot.id, queue.lane);
      pushTo(globalSlotIds, slot.id, `${queue.file}:${queue.lane}`);
      pushTo(sprintCounts, slot.sprint_id, slot.id);
    }
    for (const [order, slotIds] of orderCounts) {
      if (slotIds.length > 1) {
        out.push({
          severity: 'P2',
          code: FINDING_CODES.DUPLICATE_QUEUE_ORDER,
          message: `queue lane "${queue.lane}" has ${slotIds.length} slots at order ${order}`,
          file: queue.file,
          entityType: 'queue',
          data: { lane: queue.lane, order, slot_ids: slotIds },
        });
      }
    }
    for (const [id, lanes] of idCounts) {
      if (lanes.length > 1) {
        out.push({
          severity: 'P2',
          code: FINDING_CODES.DUPLICATE_QUEUE_SLOT_ID,
          message: `queue slot id "${id}" appears ${lanes.length} times`,
          file: queue.file,
          entityType: 'queue',
          entityId: id,
          data: { occurrences: lanes },
        });
      }
    }
    for (const [sid, slotIds] of sprintCounts) {
      if (slotIds.length > 1) {
        out.push({
          severity: 'P2',
          code: FINDING_CODES.DUPLICATE_QUEUE_SPRINT,
          message: `sprint "${sid}" appears in queue lane "${queue.lane}" ${slotIds.length} times`,
          file: queue.file,
          entityType: 'queue',
          entityId: sid,
          data: { lane: queue.lane, slot_ids: slotIds },
        });
      }
    }
  }
  for (const [id, occurrences] of globalSlotIds) {
    const files = new Set(occurrences.map((o) => o.split(':')[0]));
    if (files.size > 1) {
      out.push({
        severity: 'P2',
        code: FINDING_CODES.DUPLICATE_QUEUE_SLOT_ID,
        message: `queue slot id "${id}" appears ${occurrences.length} times across queue files`,
        entityType: 'queue',
        entityId: id,
        data: { occurrences },
      });
    }
  }
  return out;
};

function pushTo<K>(m: Map<K, string[]>, key: K, value: string): void {
  const list = m.get(key) ?? [];
  list.push(value);
  m.set(key, list);
}
