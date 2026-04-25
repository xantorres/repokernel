import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const queueRefsRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  for (const queue of parsed.queues) {
    for (const slot of queue.slots) {
      if (!graph.sprints.has(slot.sprint_id)) {
        out.push({
          severity: 'P1',
          code: FINDING_CODES.QUEUE_REFERENCES_MISSING_SPRINT,
          message: `queue lane "${queue.lane}" slot ${slot.id} references missing sprint ${slot.sprint_id}`,
          file: queue.file,
          entityType: 'queue',
          entityId: slot.id,
          data: { lane: queue.lane, sprint_id: slot.sprint_id },
        });
      }
    }
  }
  return out;
};

export const queueDuplicateRule: ValidatorRule = ({ parsed }) => {
  const out: Finding[] = [];
  for (const queue of parsed.queues) {
    const orderCounts = new Map<number, string[]>();
    const idCounts = new Map<string, string[]>();
    const sprintCounts = new Map<string, string[]>();
    for (const slot of queue.slots) {
      pushTo(orderCounts, slot.order, slot.id);
      pushTo(idCounts, slot.id, queue.lane);
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
  return out;
};

function pushTo<K>(m: Map<K, string[]>, key: K, value: string): void {
  const list = m.get(key) ?? [];
  list.push(value);
  m.set(key, list);
}
