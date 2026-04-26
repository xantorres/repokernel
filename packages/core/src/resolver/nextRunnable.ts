import type { Config } from '../config/schema.js';
import type { Graph } from '../graph/types.js';
import { type Finding, meetsThreshold } from '../schemas/finding.js';
import { FINDING_CODES } from '../validator/codes.js';

export type NextResult = 'runnable' | 'blocked' | 'none';

export interface NextResolution {
  readonly lane: string;
  readonly result: NextResult;
  readonly sprintId: string | null;
  readonly blockers: readonly Finding[];
}

export interface ResolveOptions {
  readonly lane?: string;
}

export function resolveNextRunnableSprint(
  graph: Graph,
  config: Config,
  findings: readonly Finding[],
  opts: ResolveOptions = {},
): NextResolution {
  const lane = opts.lane ?? config.policies.defaultLane;
  const threshold = config.policies.severityFailThreshold;

  const blockingFindings = findings.filter(
    (f) => meetsThreshold(f.severity, threshold) && findingAppliesToLane(f, lane, graph),
  );
  if (blockingFindings.length > 0) {
    return { lane, result: 'blocked', sprintId: null, blockers: blockingFindings };
  }

  const sprintsInLane = [...graph.sprints.values()].filter((s) => s.lane === lane);
  const actives = sprintsInLane.filter((s) => s.status === 'active');
  if (actives.length === 1) {
    return { lane, result: 'runnable', sprintId: actives[0]!.id, blockers: [] };
  }
  if (actives.length > 1 && !config.policies.allowMultipleActivePerLane) {
    return {
      lane,
      result: 'blocked',
      sprintId: null,
      blockers: [
        {
          severity: 'P1',
          code: FINDING_CODES.MULTIPLE_ACTIVE_SPRINTS_IN_LANE,
          message: `lane "${lane}" has ${actives.length} active sprints: ${actives.map((s) => s.id).join(', ')}`,
          entityType: 'lane',
          entityId: lane,
          data: { lane, sprint_ids: actives.map((s) => s.id) },
        },
      ],
    };
  }
  if (actives.length > 1 && config.policies.allowMultipleActivePerLane) {
    const slots = graph.queuesByLane.get(lane) ?? [];
    const orderById = new Map(slots.map((s) => [s.sprint_id, s.order]));
    const ranked = [...actives].sort((a, b) => {
      const ao = orderById.get(a.id);
      const bo = orderById.get(b.id);
      if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
      if (ao !== undefined && bo === undefined) return -1;
      if (ao === undefined && bo !== undefined) return 1;
      return a.id.localeCompare(b.id);
    });
    return { lane, result: 'runnable', sprintId: ranked[0]!.id, blockers: [] };
  }

  const slots = graph.queuesByLane.get(lane);
  if (!slots || slots.length === 0) {
    return { lane, result: 'none', sprintId: null, blockers: [] };
  }

  const reasonBlockers: Finding[] = [];
  for (const slot of slots) {
    const sprint = graph.sprints.get(slot.sprint_id);
    if (!sprint) {
      reasonBlockers.push({
        severity: 'P1',
        code: FINDING_CODES.QUEUE_REFERENCES_MISSING_SPRINT,
        message: `queue lane "${lane}" slot ${slot.id} references missing sprint ${slot.sprint_id}`,
        entityType: 'queue',
        entityId: slot.id,
      });
      continue;
    }
    if (sprint.lane !== lane) {
      reasonBlockers.push({
        severity: 'P1',
        code: FINDING_CODES.QUEUE_SLOT_LANE_MISMATCH,
        message: `queue lane "${lane}" slot ${slot.id} references sprint ${sprint.id} in lane "${sprint.lane}"`,
        entityType: 'queue',
        entityId: slot.id,
        data: { queue_lane: lane, sprint_id: sprint.id, sprint_lane: sprint.lane },
      });
      continue;
    }
    if (sprint.status !== 'queued') {
      continue;
    }
    if (sprint.gate) {
      return {
        lane,
        result: 'blocked',
        sprintId: null,
        blockers: [
          {
            severity: 'P1',
            code: FINDING_CODES.SPRINT_GATE_BLOCKED,
            message: `queued sprint ${sprint.id} is blocked by gate: ${sprint.gate}`,
            file: sprint.file,
            entityType: 'sprint',
            entityId: sprint.id,
            data: { gate: sprint.gate },
          },
        ],
      };
    }
    const unmet = sprint.depends_on.filter((dep) => {
      const d = graph.sprints.get(dep);
      return !d || d.status !== 'shipped';
    });
    if (unmet.length === 0) {
      return { lane, result: 'runnable', sprintId: sprint.id, blockers: [] };
    }
    reasonBlockers.push({
      severity: 'P1',
      code: FINDING_CODES.QUEUED_DEPENDENCY_NOT_SHIPPED,
      message: `queued sprint ${sprint.id} blocked by unshipped deps: ${unmet.join(', ')}`,
      entityType: 'sprint',
      entityId: sprint.id,
      data: { dependencies: unmet },
    });
  }

  if (reasonBlockers.length > 0) {
    return { lane, result: 'blocked', sprintId: null, blockers: reasonBlockers };
  }
  return { lane, result: 'none', sprintId: null, blockers: [] };
}

function findingAppliesToLane(finding: Finding, lane: string, graph: Graph): boolean {
  if (finding.entityType === 'sprint' && finding.entityId) {
    const sprint = graph.sprints.get(finding.entityId);
    return sprint ? sprint.lane === lane : true;
  }

  if (finding.entityType === 'review' && finding.entityId) {
    const review = graph.reviews.get(finding.entityId);
    if (!review) return true;
    const sprint = graph.sprints.get(review.sprint_id);
    return sprint ? sprint.lane === lane : true;
  }

  if (finding.entityType === 'lane' && finding.entityId) {
    return finding.entityId === lane;
  }

  if (finding.entityType === 'queue') {
    const queueLane =
      typeof finding.data?.queue_lane === 'string'
        ? finding.data.queue_lane
        : typeof finding.data?.lane === 'string'
          ? finding.data.lane
          : findQueueSlotLane(finding, graph);
    return queueLane === undefined ? true : queueLane === lane;
  }

  if (finding.entityType === 'epic' && finding.entityId) {
    const epic = graph.epics.get(finding.entityId);
    if (!epic) return true;
    let hasKnownSprintLane = false;
    for (const sid of epic.sprints) {
      const sprint = graph.sprints.get(sid);
      if (!sprint) continue;
      hasKnownSprintLane = true;
      if (sprint.lane === lane) return true;
    }
    return !hasKnownSprintLane;
  }

  return true;
}

function findQueueSlotLane(finding: Finding, graph: Graph): string | undefined {
  if (!finding.entityId) return undefined;
  for (const [lane, slots] of graph.queuesByLane) {
    if (slots.some((slot) => slot.id === finding.entityId || slot.sprint_id === finding.entityId)) {
      return lane;
    }
  }
  return undefined;
}
