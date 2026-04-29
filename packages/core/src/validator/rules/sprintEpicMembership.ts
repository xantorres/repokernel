import { TERMINAL_EPIC_STATUSES } from '../../schemas/epic.js';
import type { Finding } from '../../schemas/finding.js';
import { FINDING_CODES } from '../codes.js';
import type { ValidatorRule } from '../engine.js';

// Sprint statuses where flagging a closed-epic assignment is actionable.
// Limited to pre-execution states: the user catches the misassignment
// before work starts. Active/review/reopened sprints already have a worktree
// or in-flight changes — re-routing them mid-flight is its own footgun, and
// `--force` epic-close legitimately leaves them dangling. Shipped/cancelled
// are terminal and do not need flagging.
const FLAGGABLE_SPRINT_STATUSES = new Set(['planned', 'pending', 'queued']);

// Epic statuses that mean the epic is closed for new sprint work.
// Sourced from `TERMINAL_EPIC_STATUSES` in schemas/epic.ts so a future
// terminal status (e.g. `archived`) is reflected here automatically.
const CLOSED_EPIC_STATUSES = new Set<string>(TERMINAL_EPIC_STATUSES);

export const sprintEpicMembershipRule: ValidatorRule = ({ graph }) => {
  const out: Finding[] = [];
  for (const sprint of graph.sprints.values()) {
    const epic = graph.epics.get(sprint.epic_id);
    if (!epic) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_WITHOUT_EPIC,
        message: `sprint ${sprint.id} declares epic_id ${sprint.epic_id} but no matching epic exists`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
      });
      continue;
    }

    // Sprint assigned to an epic that is already closed (done/cancelled).
    // Only flag pre-execution sprints — see FLAGGABLE_SPRINT_STATUSES note.
    if (CLOSED_EPIC_STATUSES.has(epic.status) && FLAGGABLE_SPRINT_STATUSES.has(sprint.status)) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_EPIC_CLOSED,
        message: `sprint ${sprint.id} is assigned to epic ${epic.id} which has status ${epic.status} (closed); reassign to an active epic or cancel the sprint`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        suggestion: `update epic_id to an active epic, or run rk cancel ${sprint.id}`,
        data: { epic_id: epic.id, epic_status: epic.status, sprint_status: sprint.status },
      });
    }

    // Epics that claim this sprint via their ordering hint but are not the declared epic
    const claimants = (graph.epicsBySprint.get(sprint.id) ?? []).filter(
      (id) => id !== sprint.epic_id,
    );
    if (claimants.length > 0) {
      out.push({
        severity: 'P1',
        code: FINDING_CODES.SPRINT_IN_MULTIPLE_EPICS,
        message: `sprint ${sprint.id} declares epic_id ${sprint.epic_id} but is also listed by: ${claimants.join(', ')}`,
        file: sprint.file,
        entityType: 'sprint',
        entityId: sprint.id,
        data: { declared_epic: sprint.epic_id, extra_epics: claimants },
      });
    }
  }
  return out;
};
