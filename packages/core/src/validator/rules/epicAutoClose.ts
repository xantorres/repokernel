import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

const ALREADY_CLOSED = new Set(['done', 'cancelled']);

/**
 * Surface epics whose linked sprints are all shipped but whose own status has
 * not been moved to `done`. The operator can then run `rk epic close <id>` to
 * close the audit loop. P2 — informational, not a correctness gate. Mirrors
 * the pattern that `rk close` already uses to surface newly-unblocked
 * sprints, but at the epic granularity.
 */
export const epicAutoCloseRule: ValidatorRule = ({ graph }) => {
  const out: Finding[] = [];
  for (const epic of graph.epics.values()) {
    if (ALREADY_CLOSED.has(epic.status)) continue;

    const sprintIds = graph.sprintsByEpic.get(epic.id) ?? [];
    if (sprintIds.length === 0) continue;

    const sprints = sprintIds
      .map((id) => graph.sprints.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    if (sprints.length === 0) continue;
    if (sprints.length !== sprintIds.length) continue; // missing sprints — flagged by epicRefsRule

    const allShipped = sprints.every((s) => s.status === 'shipped');
    if (!allShipped) continue;

    out.push({
      severity: 'P2',
      code: FINDING_CODES.EPIC_FULLY_SHIPPED_BUT_NOT_DONE,
      message: `epic ${epic.id} has all ${sprints.length} sprint(s) shipped but status is "${epic.status}"; close the epic to finalize the audit trail`,
      file: epic.file,
      entityType: 'epic',
      entityId: epic.id,
      suggestion: `run rk epic close ${epic.id}`,
      data: { epic_status: epic.status, sprint_count: sprints.length },
    });
  }
  return out;
};
