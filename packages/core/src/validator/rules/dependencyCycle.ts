import { findCycles } from '../../graph/cycles.js';
import type { Finding } from '../../schemas/finding.js';
import type { ValidatorRule } from '../engine.js';
import { FINDING_CODES } from '../codes.js';

export const dependencyCycleRule: ValidatorRule = ({ graph }) => {
  const cycles = findCycles(graph.dependsOn);
  return cycles.map<Finding>((cycle) => ({
    severity: 'P1',
    code: FINDING_CODES.DEPENDENCY_CYCLE,
    message: `dependency cycle: ${cycle.nodes.join(' -> ')}`,
    entityType: 'sprint',
    entityId: cycle.nodes[0]!,
    data: { cycle: cycle.nodes },
  }));
};
