import { FINDING_CODES, type Finding, type FindingCode, type Severity } from '@repokernel/core';

export interface FindingExplanation {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly why: string;
  readonly expected: string;
  readonly fix: string;
  readonly command?: string;
}

const CATALOG = {
  CONFIG_INVALID: {
    severity: 'P0',
    why: 'RepoKernel cannot trust project state until the config parses and matches the supported schema.',
    expected: 'repokernel.config.yaml must be valid YAML using schemaVersion 1.',
    fix: 'Fix the YAML or schema issue shown in the finding data.',
    command: 'repokernel validate',
  },
  PARSER_FAILURE: {
    severity: 'P0',
    why: 'Malformed project files can hide or corrupt sprint state.',
    expected: 'Markdown files must have valid frontmatter for their entity type.',
    fix: 'Open the file, fix the reported frontmatter field, then validate again.',
    command: 'repokernel validate --open',
  },
  DUPLICATE_SPRINT_ID: {
    severity: 'P0',
    why: 'Two files claiming the same sprint ID make queue and review decisions ambiguous.',
    expected: 'Each sprint ID appears in exactly one sprint file.',
    fix: 'Rename or remove the duplicate sprint file.',
  },
  DUPLICATE_EPIC_ID: {
    severity: 'P0',
    why: 'Two files claiming the same epic ID make sprint membership ambiguous.',
    expected: 'Each epic ID appears in exactly one epic file.',
    fix: 'Rename or remove the duplicate epic file.',
  },
  DUPLICATE_REVIEW_ID: {
    severity: 'P0',
    why: 'Two review files with the same ID make shipped-state evidence ambiguous.',
    expected: 'Each review ID appears in exactly one review file.',
    fix: 'Rename or remove the duplicate review file.',
  },
  QUEUE_REFERENCES_MISSING_SPRINT: {
    severity: 'P1',
    why: 'The queue points at work RepoKernel cannot inspect.',
    expected: 'Every queue slot references an existing sprint file.',
    fix: 'Create the missing sprint or remove the slot from the queue.',
  },
  QUEUE_SLOT_LANE_MISMATCH: {
    severity: 'P1',
    why: 'A lane queue must not launch work that belongs to another lane.',
    expected: 'The queue lane and sprint lane must match.',
    fix: 'Move the sprint to the queue lane or place it in the correct lane queue.',
  },
  EPIC_REFERENCES_MISSING_SPRINT: {
    severity: 'P1',
    why: 'Epic membership is part of the canonical project graph.',
    expected: 'Every sprint listed by an epic exists.',
    fix: 'Create the missing sprint or remove it from the epic.',
  },
  DEPENDENCY_REFERENCES_MISSING_SPRINT: {
    severity: 'P1',
    why: 'RepoKernel cannot prove dependency readiness for a missing sprint.',
    expected: 'Every depends_on entry points to an existing sprint.',
    fix: 'Create the dependency sprint or remove the stale dependency.',
  },
  DEPENDENCY_CYCLE: {
    severity: 'P1',
    why: 'A dependency cycle means no sprint in the cycle can become safely runnable first.',
    expected: 'Sprint dependencies must form an acyclic graph.',
    fix: 'Break the cycle by removing or correcting one dependency edge.',
  },
  QUEUED_DEPENDENCY_NOT_SHIPPED: {
    severity: 'P1',
    why: 'Queued work must not start before hard dependencies have shipped.',
    expected: 'Every dependency of a queued sprint is shipped.',
    fix: 'Ship the dependency first or remove the dependency if it is wrong.',
  },
  SPRINT_STATUS_NOT_ALLOWED: {
    severity: 'P1',
    why: 'The project policy restricts which lifecycle states are allowed.',
    expected: 'Sprint status must be canonical and allowed by config.',
    fix: 'Change the sprint status or update the policy intentionally.',
  },
  ACTIVE_SPRINT_MISSING_STARTED_AT: {
    severity: 'P1',
    why: 'Started-at records when active work began and helps humans audit lifecycle state.',
    expected: 'Active sprints include started_at.',
    fix: 'Add the start timestamp or start the sprint through the lifecycle command when available.',
    command: 'repokernel start <SPRINT_ID>',
  },
  ACTIVE_SPRINT_MISSING_BASE_SHA: {
    severity: 'P1',
    why: 'RepoKernel cannot compute a trusted review diff without knowing where the sprint started.',
    expected: 'Active sprints include base_sha.',
    fix: 'If the sprint is newly starting, capture the current commit SHA. If it was migrated manually, add the commit where the sprint began.',
    command: 'repokernel start <SPRINT_ID>',
  },
  MULTIPLE_ACTIVE_SPRINTS_IN_LANE: {
    severity: 'P1',
    why: 'A lane with multiple active sprints has no single safe execution target.',
    expected: 'At most one active sprint per lane unless policy explicitly allows more.',
    fix: 'Ship, reopen, cancel, or move all but one active sprint.',
  },
  SHIPPED_SPRINT_MISSING_CLOSED_AT: {
    severity: 'P1',
    why: 'Shipped work needs a closure timestamp for auditability.',
    expected: 'Shipped sprints include closed_at.',
    fix: 'Add the close timestamp from when the sprint shipped.',
  },
  SHIPPED_SPRINT_MISSING_END_SHA: {
    severity: 'P1',
    why: 'Review evidence must point to the exact commit that shipped.',
    expected: 'Shipped sprints include end_sha.',
    fix: 'Add the commit SHA where the sprint closed.',
  },
  SHIPPED_SPRINT_MISSING_REVIEW: {
    severity: 'P1',
    why: 'Required reviews are part of the shipped-state proof.',
    expected: 'A shipped review-required sprint has an accepted review.',
    fix: 'Create or link an accepted review before marking the sprint shipped.',
  },
  REVIEW_REFERENCES_MISSING_SPRINT: {
    severity: 'P1',
    why: 'A review without its sprint cannot prove anything about shipped work.',
    expected: 'Every review references an existing sprint.',
    fix: 'Correct the review sprint_id or restore the sprint file.',
  },
  SPRINT_REVIEW_ID_MISSING_REVIEW: {
    severity: 'P1',
    why: 'The sprint claims review evidence that RepoKernel cannot find.',
    expected: 'review_id points to an existing review.',
    fix: 'Create the review file or clear the stale review_id.',
  },
  SPRINT_REVIEW_ID_WRONG_SPRINT: {
    severity: 'P1',
    why: 'A sprint must not borrow review evidence from another sprint.',
    expected: 'The linked review references the same sprint.',
    fix: 'Point review_id at the correct review or fix the review sprint_id.',
  },
  SHIPPED_SPRINT_REVIEW_NOT_ACCEPTED: {
    severity: 'P1',
    why: 'A shipped sprint with required review must have accepted evidence.',
    expected: 'At least one linked review has verdict accepted.',
    fix: 'Get the review accepted or move the sprint out of shipped.',
  },
  REVIEW_BASE_SHA_MISMATCH: {
    severity: 'P1',
    why: 'The review diff base must match the sprint diff base.',
    expected: 'Sprint base_sha and review base_sha are identical.',
    fix: 'Correct the stale SHA on the sprint or review.',
  },
  REVIEW_END_SHA_MISMATCH: {
    severity: 'P1',
    why: 'The review diff end must match the sprint shipped commit.',
    expected: 'Sprint end_sha and review end_sha are identical.',
    fix: 'Correct the stale SHA on the sprint or review.',
  },
  SPRINT_WITHOUT_EPIC: {
    severity: 'P1',
    why: 'Every sprint needs an owning epic so work has a product context.',
    expected: 'sprint.epic_id points to an existing epic.',
    fix: 'Create the epic or change epic_id to an existing epic.',
  },
  SPRINT_IN_MULTIPLE_EPICS: {
    severity: 'P1',
    why: 'A sprint should have one clear epic owner.',
    expected: 'A sprint appears in only one epic membership list.',
    fix: 'Remove the sprint from the extra epic list.',
  },
  SPRINT_EPIC_CLOSED: {
    severity: 'P1',
    why: 'A sprint assigned to a closed epic (done or cancelled) has no path to ship through that epic. The work is effectively orphaned.',
    expected: 'sprint.epic_id points to an epic with status planned, active, or on_hold.',
    fix: 'Reassign epic_id to an active epic, or run `rk cancel <sprint>` if the work is no longer wanted.',
  },
  EPIC_FULLY_SHIPPED_BUT_NOT_DONE: {
    severity: 'P2',
    why: 'All sprints in this epic are shipped, but the epic itself is still active. The audit trail is incomplete: downstream tools (rk ls epics --unshipped, NEXT.md, dashboards) still treat the epic as in-flight.',
    expected: 'When every sprint in an epic is shipped, the epic transitions to status: done.',
    fix: 'Run `rk epic ship <id>` to close the epic, validate, and check registry.',
    command: 'rk epic ship',
  },
  SPRINT_REVIEW_REQUIRED_BY_POLICY: {
    severity: 'P1',
    why: 'The project policy requires reviews from a given sprint number onward (policies.requireReviewForShippedFromSprintId), but this sprint sets review_required: false.',
    expected: 'Sprints at or above the policy threshold have review_required: true.',
    fix: 'Set review_required: true on the sprint frontmatter, or lower the policy threshold if the requirement should not apply.',
  },
  PENDING_SPRINT_IN_QUEUE_AS_RUNNABLE: {
    severity: 'P1',
    why: 'Pending work is not ready to be considered runnable queue work.',
    expected: 'Queue slots contain active or queued work, not pending work.',
    fix: 'Move the sprint to queued when it is ready or remove it from the queue.',
  },
  SHIPPED_SPRINT_IN_QUEUE: {
    severity: 'P2',
    why: 'Completed work left in the queue creates noise and can confuse humans.',
    expected: 'Shipped sprints are removed from queues.',
    fix: 'Remove the shipped sprint from the queue.',
  },
  CANCELLED_SPRINT_IN_QUEUE: {
    severity: 'P2',
    why: 'Cancelled work left in the queue creates noise and can confuse humans.',
    expected: 'Cancelled sprints are removed from queues.',
    fix: 'Remove the cancelled sprint from the queue.',
  },
  ACTIVE_SPRINT_NOT_IN_QUEUE: {
    severity: 'P2',
    why: 'Active work should be visible in its lane queue.',
    expected: 'Every active sprint appears in a queue.',
    fix: 'Add the active sprint to the correct lane queue.',
  },
  DUPLICATE_QUEUE_ORDER: {
    severity: 'P2',
    why: 'Duplicate queue orders make queue position ambiguous.',
    expected: 'Each queue slot order is unique within a queue.',
    fix: 'Renumber the queue slots.',
  },
  DUPLICATE_QUEUE_SLOT_ID: {
    severity: 'P2',
    why: 'Duplicate slot IDs make queue diagnostics ambiguous.',
    expected: 'Each queue slot ID is unique.',
    fix: 'Rename one of the duplicate queue slot IDs.',
  },
  DUPLICATE_QUEUE_SPRINT: {
    severity: 'P2',
    why: 'A sprint should appear once in a lane queue.',
    expected: 'Each sprint appears at most once per queue.',
    fix: 'Remove the duplicate queue slot.',
  },
  MULTIPLE_QUEUE_FILES_FOR_LANE: {
    severity: 'P1',
    why: 'A lane with multiple queue files has ambiguous ordering.',
    expected: 'Each lane is declared by one queue file.',
    fix: 'Merge or remove duplicate queue files for the lane.',
  },
  QUEUE_FILE_LANE_MISMATCH: {
    severity: 'P3',
    why: 'Filename and lane mismatch is confusing during local editing.',
    expected: 'Queue filename matches the lane field.',
    fix: 'Rename the file or update the lane field.',
  },
  QUEUE_SLOT_ORDER_GAP: {
    severity: 'P3',
    why: 'Contiguous queue ordering makes diffs and inspection easier.',
    expected: 'Queue slot orders start at 0 and increase by 1.',
    fix: 'Renumber queue slots as 0, 1, 2, and so on.',
  },
  SPRINT_LANE_HAS_NO_QUEUE: {
    severity: 'P2',
    why: 'A lane with no queue file cannot receive work from the scheduler.',
    expected: 'Every sprint lane has a corresponding queue file or lane file.',
    fix: 'Create a queue file for the lane (e.g. queues/<lane>.md) or add a lane file.',
  },
  SPRINT_REVIEW_VERDICT_CONFLICT: {
    severity: 'P2',
    why: 'Conflicting verdicts (accepted + rejected/changes_requested) on the same sprint leave its review state ambiguous.',
    expected: 'All terminal verdicts for a sprint agree.',
    fix: 'Supersede or remove the outdated review so only one verdict is authoritative.',
  },
  SPRINT_GATE_BLOCKED: {
    severity: 'P1',
    why: 'A gate is an explicit human checkpoint before queued work may start.',
    expected: 'Gated sprints are not runnable until the gate is resolved.',
    fix: 'Run: rk gate resolve <gate-name>  (or rk gate ls to see all active gates)',
  },
  SPRINT_HAS_UNVALIDATED_PATH_CONSTRAINTS: {
    severity: 'P3',
    why: 'Path constraints need lifecycle-time diff checks rather than static validation.',
    expected: 'allowed_paths and denied_paths are enforced when a sprint enters review.',
    fix: 'Run lifecycle commands so RepoKernel can check the actual diff.',
  },
  CONFIG_POLICY_EMPTY_ALLOWED_STATUSES: {
    severity: 'P2',
    why: 'An empty allowedStatuses list disallows every sprint status, making the project permanently invalid.',
    expected: 'policies.allowedStatuses contains at least one valid status.',
    fix: 'Add at least one status to allowedStatuses in repokernel.config.yaml or remove the key to use the default.',
  },
  BLOCKED_BY_REFERENCES_MISSING_SPRINT: {
    severity: 'P1',
    why: 'RepoKernel cannot evaluate blocker readiness for a sprint that does not exist.',
    expected: 'Every blocked_by entry points to an existing sprint.',
    fix: 'Create the missing sprint or remove the stale blocked_by entry.',
  },
  BLOCKED_BY_CYCLE: {
    severity: 'P2',
    why: 'A cycle in blocked_by means no sprint in the cycle can be unblocked first.',
    expected: 'blocked_by relationships must form an acyclic graph.',
    fix: 'Break the cycle by removing or correcting one blocked_by edge.',
  },
  REGISTRY_DRIFT: {
    severity: 'P2',
    why: 'The generated registry no longer matches source project state.',
    expected: 'Registry content matches the current project graph.',
    fix: 'Regenerate the registry after reviewing the source changes.',
    command: 'repokernel registry --write',
  },
  SPRINT_WORKTREE_LEAKED: {
    severity: 'P2',
    why: 'A stale sprint worktree can hide unmerged work or confuse future parallel runs.',
    expected: 'Sprint worktrees are removed after their sprint is merged or no longer active.',
    fix: 'Inspect the worktree, preserve any needed changes, then remove it with git worktree remove.',
    command: 'repokernel validate',
  },
  UNKNOWN_FRONTMATTER_FIELD: {
    severity: 'P3',
    why: 'Unknown fields may be typos that humans or agents accidentally rely on.',
    expected: 'Frontmatter contains only fields supported by the schema.',
    fix: 'Remove the unknown field or add schema support intentionally.',
  },
  FILENAME_ID_MISMATCH: {
    severity: 'P3',
    why: 'Filename and ID mismatch makes files harder to find and review.',
    expected: 'Entity filenames start with their ID.',
    fix: 'Rename the file to match the entity ID.',
  },
  NEXT_MD_PARSE_ERROR: {
    severity: 'P0',
    why: 'NEXT.md could not be parsed — slot data is unreadable.',
    expected: 'NEXT.md has valid YAML frontmatter and slot sections.',
    fix: 'Repair the NEXT.md file or regenerate it.',
    command: 'rk next generate --force',
  },
  NEXT_MD_SPRINT_MISSING: {
    severity: 'P1',
    why: 'A sprint ID in NEXT.md does not exist in the project.',
    expected: 'All sprint IDs in NEXT.md correspond to real sprints.',
    fix: 'Remove or correct the stale sprint ID in NEXT.md.',
  },
  NEXT_MD_DRIFT: {
    severity: 'P2',
    why: 'NEXT.md slot order does not match the queue order or top-N queued sprints.',
    expected: 'NEXT.md non-vacant slots match the top N queued sprints in order.',
    fix: 'Run rk next sync to reorder the queue, or rk next generate --force to overwrite NEXT.md.',
    command: 'rk next sync',
  },
  NEXT_MD_SLOT_MULTIPLE_SPRINTS: {
    severity: 'P1',
    why: 'A slot can hold at most one sprint.',
    expected: 'Each ## Slot N section contains zero or one sprint bullet.',
    fix: 'Remove the extra sprint bullet from the slot.',
  },
  NEXT_MD_DUPLICATE_SPRINT: {
    severity: 'P1',
    why: 'The same sprint ID appears in more than one slot.',
    expected: 'Each sprint ID appears at most once across all slots.',
    fix: 'Remove the duplicate sprint ID.',
  },
  NEXT_MD_INVALID_ID: {
    severity: 'P0',
    why: 'A sprint bullet does not match the S-NNN format.',
    expected: 'Sprint bullets follow the pattern: - S-NNN',
    fix: 'Correct or remove the malformed sprint ID.',
  },
  NEXT_MD_WRONG_SLOT_COUNT: {
    severity: 'P1',
    why: 'Number of ## Slot N sections does not match the slots: field in frontmatter.',
    expected: 'Exactly slots: N slot sections are present.',
    fix: 'Add or remove slot sections to match the declared count.',
  },
  NEXT_MD_LANE_MISMATCH: {
    severity: 'P2',
    why: 'The lane declared in NEXT.md has no queue in the project.',
    expected: 'NEXT.md lane matches a known queue lane.',
    fix: 'Update the lane field in NEXT.md or create the missing queue.',
  },
  REVIEW_PANEL_VERDICT_CONFLICT: {
    severity: 'P1',
    why: 'The panel_aggregate and verdict fields are in a logically impossible state.',
    expected: 'GREEN/YELLOW aggregate → accepted; RED aggregate → changes_requested.',
    fix: 'Re-run the panel or correct the verdict manually.',
    command: 'rk review-panel run <sprint-id>',
  },
  REVIEW_INVALID_VERDICT: {
    severity: 'P0',
    why: 'The review verdict field is set to a value outside the allowed enum (e.g. "yellow", "green", "red").',
    expected: 'verdict is one of: pending | accepted | changes_requested | rejected.',
    fix: 'Edit the review file to use a valid verdict value, then re-run validation.',
    command: 'rk review-verdict <review-id> accepted',
  },
  REVIEW_INVALID_FINDING_SHAPE: {
    severity: 'P0',
    why: 'A findings entry uses the legacy nested shape (e.g. {severity, category, data:{message}}) which is no longer accepted.',
    expected: 'Each finding is a flat object: {severity, message} with optional data:{...}.',
    fix: 'Remove all entries from the findings: frontmatter field — leave it as findings: []. Add finding detail in the body markdown ## Findings section instead.',
  },
  DEPRECATED_FIELD: {
    severity: 'P3',
    why: 'A config key that has been removed in a current release was found in the YAML.',
    expected: 'The deprecated key has been replaced; the file should not declare it.',
    fix: 'Remove the deprecated field, or run rk fix --apply to strip it automatically.',
    command: 'rk fix --apply',
  },
  UNKNOWN_LANE: {
    severity: 'P2',
    why: 'A sprint references a lane that has neither a lane file nor any queue, so the runner cannot see it.',
    expected: 'Every sprint lane appears in lanes/<name>.md or queues/<name>.md.',
    fix: 'Create the missing lane or queue file, or correct the lane name in the sprint frontmatter.',
  },
  SHIPPED_SPRINT_MISSING_BASE_SHA: {
    severity: 'P2',
    why: 'A shipped sprint without base_sha has no auditable starting point for its diff.',
    expected: 'Shipped sprints carry the base_sha captured at start.',
    fix: 'Reconstruct base_sha from run state, the linked review, or pass --base-sha on rk fix --apply.',
    command: 'rk fix --apply --base-sha <sha> --sprint <id>',
  },
  EPIC_SPRINT_BACK_POINTER_CONFLICT: {
    severity: 'P2',
    why: "The epic's ordering hint lists a sprint that declares a different epic_id. The sprint will not be treated as a member of this epic.",
    expected: 'Every sprint in epic.sprints[] has epic_id pointing back to this epic.',
    fix: 'Remove the sprint from this epic ordering hint or correct the sprint epic_id.',
  },
  EPIC_SPRINT_NOT_IN_ORDERING: {
    severity: 'P2',
    why: "Sprint membership is derived from sprint.epic_id, but this sprint is absent from the epic's sprints[] ordering hint. It will be appended at the end of the epic's sprint list.",
    expected:
      "Sprints with a back-pointer to this epic are listed in the epic's sprints[] ordering hint.",
    fix: 'Add the sprint ID to the epic sprints[] field in the desired position.',
  },
  CONFIG_REQUIRES_NOT_MET: {
    severity: 'P1',
    why: 'The project config declares a minimum rk version via requires: that the installed rk does not satisfy.',
    expected: 'Installed rk satisfies the semver range specified in requires:.',
    fix: 'Upgrade rk to a version that satisfies the requires: range, or remove/lower the requires: constraint.',
    command: 'npm install -g repokernel@latest',
  },
} satisfies Record<FindingCode, Omit<FindingExplanation, 'code'>>;

export function explainCode(code: string): FindingExplanation | null {
  if (!isFindingCode(code)) return null;
  return { code, ...CATALOG[code] };
}

export function explainFinding(finding: Finding): FindingExplanation {
  return (
    explainCode(finding.code) ?? {
      code: finding.code as FindingCode,
      severity: finding.severity,
      why: 'RepoKernel found a project-state issue that needs human attention.',
      expected: 'Project files should satisfy RepoKernel validation rules.',
      fix: finding.suggestion ?? 'Review the finding message and correct the source file.',
    }
  );
}

export function allFindingCodes(): FindingCode[] {
  return Object.values(FINDING_CODES).sort();
}

function isFindingCode(code: string): code is FindingCode {
  return Object.values(FINDING_CODES).includes(code as FindingCode);
}
