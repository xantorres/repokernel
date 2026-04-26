import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

const TERMINAL_STATUSES = new Set(['shipped', 'cancelled']);

/**
 * Authoritative lanes are defined ONLY by:
 *   1. Lane files in <paths.lanes> (graph.laneFiles)
 *   2. Lane names referenced by queue files (graph.queuesByLane keys)
 *
 * A sprint claiming `lane: foo` does not, by itself, make `foo` authoritative.
 * If a sprint references a lane that has neither a lane file nor a queue, it
 * is silently invisible to runners and resolvers — so we surface it as P1.
 */
export const unknownLaneRule: ValidatorRule = ({ graph, parsed }) => {
  const findings: Finding[] = [];
  const authoritative = new Set<string>();
  for (const laneFile of graph.laneFiles) authoritative.add(laneFile.name);
  for (const lane of graph.queuesByLane.keys()) authoritative.add(lane);

  const reported = new Set<string>();
  for (const sprint of parsed.sprints) {
    if (TERMINAL_STATUSES.has(sprint.status)) continue;
    if (authoritative.has(sprint.lane)) continue;
    const key = `${sprint.id}::${sprint.lane}`;
    if (reported.has(key)) continue;
    reported.add(key);
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.UNKNOWN_LANE,
      message: `sprint ${sprint.id} references unknown lane "${sprint.lane}" (no lane file and no queue references it)`,
      file: sprint.file,
      entityType: 'sprint',
      entityId: sprint.id,
      suggestion: `create a lane file at lanes/${sprint.lane}.md or a queue at queues/${sprint.lane}.md`,
      data: {
        lane: sprint.lane,
        authoritative_lanes: [...authoritative].sort(),
      },
    });
  }

  return findings;
};
