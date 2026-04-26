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
