import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

export const sprintPolicyRule: ValidatorRule = ({ config, parsed }) => {
  const out: Finding[] = [];
  const allowedStatuses = new Set(config.policies.allowedStatuses);

  for (const sprint of parsed.sprints) {
    if (!allowedStatuses.has(sprint.status)) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_STATUS_NOT_ALLOWED,
        message: `sprint ${sprint.id} has status "${sprint.status}", which is not allowed by project policy`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        suggestion: `use one of: ${config.policies.allowedStatuses.join(', ')}`,
        data: { status: sprint.status, allowed_statuses: [...config.policies.allowedStatuses] },
      });
    }
  }

  if (!config.policies.allowMultipleActivePerLane) {
    const activeByLane = new Map<string, { id: string; file: string }[]>();
    for (const sprint of parsed.sprints) {
      if (sprint.status !== 'active') continue;
      const laneActives = activeByLane.get(sprint.lane) ?? [];
      laneActives.push({ id: sprint.id, file: sprint.file });
      activeByLane.set(sprint.lane, laneActives);
    }

    for (const [lane, actives] of activeByLane) {
      if (actives.length <= 1) continue;
      out.push({
        severity: 'P1',
        code: FINDING_CODES.MULTIPLE_ACTIVE_SPRINTS_IN_LANE,
        message: `lane "${lane}" has ${actives.length} active sprints: ${actives.map((s) => s.id).join(', ')}`,
        entityType: 'lane',
        entityId: lane,
        suggestion:
          'ship, reopen, cancel, or move all but one active sprint before resolving next work',
        data: { lane, sprint_ids: actives.map((s) => s.id), files: actives.map((s) => s.file) },
      });
    }
  }

  return out;
};
