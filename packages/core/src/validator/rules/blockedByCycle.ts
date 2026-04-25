import { findCycles } from '../../graph/cycles.js';
import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const blockedByCycleRule: ValidatorRule = ({ parsed }) => {
  const adj = new Map<string, readonly string[]>(parsed.sprints.map((s) => [s.id, s.blocked_by]));
  const cycles = findCycles(adj);
  return cycles.map<Finding>((cycle) => ({
    severity: 'P2',
    code: FINDING_CODES.BLOCKED_BY_CYCLE,
    message: `blocked_by cycle: ${cycle.nodes.join(' -> ')}`,
    entityType: 'sprint',
    entityId: cycle.nodes[0] ?? '',
    data: { cycle: cycle.nodes },
  }));
};
