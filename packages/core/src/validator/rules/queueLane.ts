import { basename } from 'node:path';
import type { Finding } from '../../schemas/finding.js';
import type { ValidatorRule } from '../engine.js';
import { FINDING_CODES } from '../codes.js';

export const queueLaneRule: ValidatorRule = ({ parsed }) => {
  const out: Finding[] = [];

  const filesByLane = new Map<string, string[]>();
  for (const queue of parsed.queues) {
    const list = filesByLane.get(queue.lane) ?? [];
    list.push(queue.file);
    filesByLane.set(queue.lane, list);
  }
  for (const [lane, files] of filesByLane) {
    if (files.length > 1) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.MULTIPLE_QUEUE_FILES_FOR_LANE,
        message: `lane "${lane}" is declared by ${files.length} queue files: ${files.join(', ')}`,
        entityType: 'queue',
        data: { lane, files },
      });
    }
  }

  for (const queue of parsed.queues) {
    const stem = basename(queue.file, '.md');
    if (stem !== queue.lane) {
      out.push({
        severity: 'P3',
        code: FINDING_CODES.QUEUE_FILE_LANE_MISMATCH,
        message: `queue file ${queue.file} declares lane "${queue.lane}" but filename is "${stem}"`,
        file: queue.file,
        entityType: 'queue',
        data: { lane: queue.lane, filename_stem: stem },
        suggestion: `rename file to ${queue.lane}.md or update lane field`,
      });
    }
  }

  for (const queue of parsed.queues) {
    if (queue.slots.length === 0) continue;
    const orders = queue.slots.map((s) => s.order).sort((a, b) => a - b);
    const expected = orders.map((_, i) => i);
    const matches = orders.every((o, i) => o === expected[i]);
    if (!matches) {
      out.push({
        severity: 'P3',
        code: FINDING_CODES.QUEUE_SLOT_ORDER_GAP,
        message: `queue lane "${queue.lane}" slot orders are not contiguous starting at 0`,
        file: queue.file,
        entityType: 'queue',
        data: { lane: queue.lane, orders },
        suggestion: 'use consecutive integers 0, 1, 2, ... for queue slot order',
      });
    }
  }

  return out;
};
