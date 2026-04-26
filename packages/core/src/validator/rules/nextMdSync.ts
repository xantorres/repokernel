import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const nextMdSyncRule: ValidatorRule = ({ parsed, config, graph }) => {
  if (!config.paths.next || !parsed.nextMd) return [];

  const { nextMd } = parsed;
  const findings: Finding[] = [];
  const fileRel = config.paths.next;

  const nonVacantSlots = nextMd.slots.filter((s) => s.sprintId !== null);

  // Check each sprint ID exists in project
  for (const slot of nonVacantSlots) {
    const id = slot.sprintId as string;
    if (!graph.sprints.has(id)) {
      findings.push({
        severity: 'P1',
        code: FINDING_CODES.NEXT_MD_SPRINT_MISSING,
        message: `slot ${slot.slot} in ${fileRel} references sprint ${id} which does not exist`,
        file: fileRel,
        entityId: id,
        data: { slot: slot.slot, sprintId: id },
      });
    }
  }

  // Check lane mismatch: NEXT.md lane vs config default lane
  // We treat the NEXT.md lane as the source of truth for the slots.
  // If the lane doesn't exist in graph, warn P2 (not a hard error — lane may be empty/new)
  const lane = nextMd.lane;
  if (!graph.lanes.has(lane) && graph.queuesByLane.size > 0) {
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.NEXT_MD_LANE_MISMATCH,
      message: `${fileRel} specifies lane "${lane}" which has no queue in this project`,
      file: fileRel,
      data: { lane, knownLanes: [...graph.lanes.keys()] },
    });
    return findings; // can't check drift without a queue
  }

  // Check drift: order of non-vacant slots vs queue order for the lane
  const queueSlots = graph.queuesByLane.get(lane) ?? [];

  // Build position map for queue: sprintId → queue position (0-indexed by order)
  const queuePositions = new Map<string, number>();
  for (let i = 0; i < queueSlots.length; i++) {
    queuePositions.set(queueSlots[i]!.sprint_id, i);
  }

  // Check that each non-vacant sprint is in the queue
  const nextInQueue = nonVacantSlots.filter((s) => {
    const id = s.sprintId as string;
    return graph.sprints.has(id) && queuePositions.has(id);
  });

  const missingFromQueue = nonVacantSlots.filter((s) => {
    const id = s.sprintId as string;
    return graph.sprints.has(id) && !queuePositions.has(id);
  });

  for (const slot of missingFromQueue) {
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.NEXT_MD_DRIFT,
      message: `${fileRel} slot ${slot.slot} has ${slot.sprintId} but it is not in the "${lane}" queue`,
      file: fileRel,
      data: { slot: slot.slot, sprintId: slot.sprintId, lane },
    });
  }

  // Check relative ordering: NEXT.md slots must appear in the same relative order in queue
  const queueOrderOfSlots = nextInQueue.map((s) => queuePositions.get(s.sprintId as string) ?? -1);
  for (let i = 1; i < queueOrderOfSlots.length; i++) {
    if ((queueOrderOfSlots[i] ?? -1) < (queueOrderOfSlots[i - 1] ?? -1)) {
      findings.push({
        severity: 'P2',
        code: FINDING_CODES.NEXT_MD_DRIFT,
        message: `${fileRel} slot order does not match queue order in lane "${lane}" — run "rk next sync" to fix`,
        file: fileRel,
        data: {
          lane,
          nextMdOrder: nextInQueue.map((s) => s.sprintId),
          queueOrder: queueSlots.map((s) => s.sprint_id),
        },
      });
      break; // one drift finding per validation is enough
    }
  }

  // Check that NEXT.md top N match the top N in queue (by queue order)
  const topQueueIds = queueSlots.slice(0, nextMd.declaredSlots).map((s) => s.sprint_id);
  const nextMdIds = nonVacantSlots.map((s) => s.sprintId as string);

  const topMismatch =
    topQueueIds.length > 0 &&
    nextMdIds.length > 0 &&
    !nextMdIds.every((id) => topQueueIds.includes(id));

  if (topMismatch && missingFromQueue.length === 0) {
    findings.push({
      severity: 'P2',
      code: FINDING_CODES.NEXT_MD_DRIFT,
      message: `${fileRel} top ${nextMd.declaredSlots} sprints do not match queue top ${nextMd.declaredSlots} — run "rk next sync" or "rk next generate --force" to fix`,
      file: fileRel,
      data: { lane, nextMdIds, topQueueIds },
    });
  }

  return findings;
};
