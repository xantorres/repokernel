import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

const TERMINAL_STATUSES = new Set(['shipped', 'cancelled']);

export const laneOrphanRule: ValidatorRule = ({ graph, parsed }) => {
  const out: Finding[] = [];
  const checkedLanes = new Set<string>();

  for (const sprint of parsed.sprints) {
    if (TERMINAL_STATUSES.has(sprint.status)) continue;
    const lane = sprint.lane;
    if (checkedLanes.has(lane)) continue;
    checkedLanes.add(lane);

    const hasQueue = graph.queuesByLane.has(lane);
    const hasLaneFile = graph.laneFiles.some((l) => l.name === lane);
    if (hasQueue || hasLaneFile) continue;

    out.push({
      severity: 'P2',
      code: FINDING_CODES.SPRINT_LANE_HAS_NO_QUEUE,
      message: `lane "${lane}" has no queue file and no lane file`,
      entityType: 'lane',
      entityId: lane,
      suggestion: `create queues/${lane}.md or lanes/${lane}.md`,
      data: { lane },
    });
  }

  return out;
};
