import { TERMINAL_EPIC_STATUSES } from '../../schemas/epic.js';
import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

const ALREADY_CLOSED = new Set<string>(TERMINAL_EPIC_STATUSES);

/**
 * Surface epics whose linked sprints are all shipped but whose own status has
 * not been moved to `done`. The operator can then run `rk epic close <id>` to
 * close the audit loop. P2 — informational, not a correctness gate. Mirrors
 * the pattern that `rk close` already uses to surface newly-unblocked
 * sprints, but at the epic granularity.
 *
 * When some sprint refs are unresolvable (epicRefsRule will flag those
 * separately), the rule still emits the finding if every *loaded* sprint is
 * shipped — agents need visibility into "this epic is one missing-ref away
 * from being closeable" so they can fix the ref and close in one step,
 * rather than chasing two findings sequentially.
 */
export const epicAutoCloseRule: ValidatorRule = ({ graph }) => {
  const out: Finding[] = [];
  for (const epic of graph.epics.values()) {
    if (ALREADY_CLOSED.has(epic.status)) continue;

    // sprintsByEpic only contains resolvable sprint files. Missing refs
    // listed in epic.sprints (frontmatter) are tracked via the difference
    // between the frontmatter list and the resolved set.
    const resolvedSprintIds = graph.sprintsByEpic.get(epic.id) ?? [];
    if (resolvedSprintIds.length === 0) continue;

    const sprints = resolvedSprintIds
      .map((id) => graph.sprints.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    if (sprints.length === 0) continue;

    const allShipped = sprints.every((s) => s.status === 'shipped');
    if (!allShipped) continue;

    // Frontmatter ref count vs resolved count tells us about missing refs
    // (epicRefsRule will flag these separately as P1).
    const declaredCount = epic.sprints.length;
    const missingRefs = Math.max(0, declaredCount - sprints.length);
    const hasMissingRefs = missingRefs > 0;

    const baseMessage = `epic ${epic.id} has all ${sprints.length} loaded sprint(s) shipped but status is "${epic.status}"`;
    const suffix = hasMissingRefs
      ? ` (${missingRefs} sprint ref(s) unresolved — fix those first, then close); close the epic to finalize the audit trail`
      : `; close the epic to finalize the audit trail`;

    out.push({
      severity: 'P2',
      code: FINDING_CODES.EPIC_FULLY_SHIPPED_BUT_NOT_DONE,
      message: baseMessage + suffix,
      file: epic.file,
      entityType: 'epic',
      entityId: epic.id,
      suggestion: hasMissingRefs
        ? `resolve missing sprint refs in ${epic.id}, then run rk epic ship ${epic.id}`
        : `run rk epic ship ${epic.id}`,
      data: {
        epic_status: epic.status,
        sprint_count: sprints.length,
        missing_refs: missingRefs,
      },
    });
  }
  return out;
};
