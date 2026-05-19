import type { Graph } from '../graph/index.js';
import type { Finding } from '../schemas/finding.js';

/**
 * Should a finding gate a lifecycle action whose target is `sprintId`?
 *
 * "Target" means the sprint being shipped, closed, reviewed, or gated.
 * Lifecycle transitions are scoped to the target's frame of reference: the
 * target sprint's own findings (and findings on artifacts that legitimately
 * belong to it — its review, the queue slot pointing at it, its epic) gate
 * the action; findings about *other* sprints — including queued downstream
 * dependents waiting for this very transition — do not.
 *
 * Why: without target-scoping, `rk ship S-062` fails because S-063 (queued,
 * depends-on S-062) shows as a blocker, even though S-062 shipping is what
 * unblocks S-063. The original 1.18.x behavior poisoned the close path
 * with its own downstream consequences. Production feedback items #1 and
 * #2 are this exact bug.
 *
 * Global findings (those with no `entityType` / `entityId`) describe
 * parser- or config-level failures that affect every operation, so they
 * always apply.
 */
export function findingAppliesToTarget(finding: Finding, sprintId: string, graph: Graph): boolean {
  if (!finding.entityType || !finding.entityId) return true;

  if (finding.entityType === 'sprint') return finding.entityId === sprintId;

  if (finding.entityType === 'review') {
    const review = graph.reviews.get(finding.entityId);
    return review ? review.sprint_id === sprintId : true;
  }

  if (finding.entityType === 'queue') {
    for (const slots of graph.queuesByLane.values()) {
      const slot = slots.find((s) => s.id === finding.entityId);
      if (slot) return slot.sprint_id === sprintId;
    }
    return true;
  }

  if (finding.entityType === 'epic') {
    const sprint = graph.sprints.get(sprintId);
    return sprint ? sprint.epic_id === finding.entityId : true;
  }

  return true;
}

export type TargetValidationMode = 'close' | 'global';

/**
 * Filter `findings` to the subset that should gate a lifecycle action against
 * `sprintId`. Mode `close` applies `findingAppliesToTarget`; mode `global`
 * returns the full list (the old behavior, retained for `rk validate` and
 * for `rk gates --target-scope global` when the operator wants the whole
 * picture).
 */
export function validateForTarget(
  findings: readonly Finding[],
  sprintId: string,
  graph: Graph,
  mode: TargetValidationMode = 'close',
): readonly Finding[] {
  if (mode === 'global') return findings;
  return findings.filter((f) => findingAppliesToTarget(f, sprintId, graph));
}
