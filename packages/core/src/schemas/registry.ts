import { z } from 'zod';
import { EpicExecutionStrategySchema, EpicStatusSchema } from './epic.js';
import {
  type Finding,
  FindingSchema,
  SEVERITY_RANK,
  type Severity,
  SeveritySchema,
} from './finding.js';
import { EpicIdSchema, ReviewIdSchema, SprintIdSchema } from './ids.js';
import { RepoRelativeGlobSchema } from './path.js';
import { QueueSlotSchema } from './queue.js';
import { ReviewVerdictSchema } from './review.js';
import { type SprintStatus, SprintStatusSchema } from './sprint.js';

export const REGISTRY_SCHEMA_VERSION = 2;

export const RegistryProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const RegistryHealthSchema = z
  .object({
    maxSeverity: SeveritySchema.nullable(),
    findingCounts: z.object({
      P0: z.number().int().nonnegative(),
      P1: z.number().int().nonnegative(),
      P2: z.number().int().nonnegative(),
      P3: z.number().int().nonnegative(),
    }),
    blocked: z.boolean(),
  })
  .strict();

export const RegistrySprintSchema = z
  .object({
    id: SprintIdSchema,
    title: z.string(),
    epic_id: EpicIdSchema,
    status: SprintStatusSchema,
    lane: z.string(),
    gate: z.string().nullable(),
    depends_on: z.array(SprintIdSchema),
    blocked_by: z.array(SprintIdSchema),
    allowed_paths: z.array(RepoRelativeGlobSchema),
    denied_paths: z.array(RepoRelativeGlobSchema),
    generated_paths: z.array(RepoRelativeGlobSchema),
    review_required: z.boolean(),
    review_id: ReviewIdSchema.nullable(),
    started_at: z.string().nullable(),
    closed_at: z.string().nullable(),
    base_sha: z.string().nullable(),
    end_sha: z.string().nullable(),
    file: z.string(),
  })
  .strict();

export const RegistryEpicSchema = z
  .object({
    id: EpicIdSchema,
    title: z.string(),
    status: EpicStatusSchema,
    gate: z.string().nullable(),
    adr_links: z.array(z.string()),
    sprints: z.array(SprintIdSchema),
    execution_strategy: EpicExecutionStrategySchema.optional(),
    parallel_limit: z.number().int().positive().optional(),
    file: z.string(),
  })
  .strict();

export const RegistryReviewSchema = z
  .object({
    id: ReviewIdSchema,
    sprint_id: SprintIdSchema,
    verdict: ReviewVerdictSchema,
    reviewer: z.string(),
    base_sha: z.string().nullable(),
    end_sha: z.string().nullable(),
    file: z.string(),
  })
  .strict();

export const RegistryLaneSchema = z
  .object({
    name: z.string(),
    claimed_by: z.string().nullable(),
    claimed_at: z.string().nullable(),
    inferred: z.boolean(),
  })
  .strict();

export const RegistryNextSchema = z
  .object({
    lane: z.string(),
    result: z.enum(['runnable', 'blocked', 'none']),
    sprint_id: SprintIdSchema.nullable(),
    blockers: z.array(FindingSchema),
  })
  .strict();

export const REGISTRY_SCHEMA_VERSIONS_SUPPORTED = [REGISTRY_SCHEMA_VERSION] as const;

export const RegistrySchema = z
  .object({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    generatedBy: z.string(),
    generatedAt: z.string().datetime({ offset: true }),
    project: RegistryProjectSchema,
    health: RegistryHealthSchema,
    epics: z.array(RegistryEpicSchema),
    sprints: z.array(RegistrySprintSchema),
    reviews: z.array(RegistryReviewSchema),
    queue: z.record(z.string(), z.array(QueueSlotSchema)),
    lanes: z.array(RegistryLaneSchema),
    next: z.array(RegistryNextSchema),
    findings: z.array(FindingSchema),
  })
  .strict();

export type Registry = z.infer<typeof RegistrySchema>;
export type RegistrySprint = z.infer<typeof RegistrySprintSchema>;
export type RegistryEpic = z.infer<typeof RegistryEpicSchema>;
export type RegistryReview = z.infer<typeof RegistryReviewSchema>;
export type RegistryLane = z.infer<typeof RegistryLaneSchema>;
export type RegistryNext = z.infer<typeof RegistryNextSchema>;

// ---------------------------------------------------------------------------
// Deterministic merge for two Registry instances
// ---------------------------------------------------------------------------
// Concurrent agents both regenerate registry.json from their local entity
// files. When their branches merge, git sees two divergent JSON blobs and
// stops. The fix at the registry.json level is to compute a deterministic
// resolution that preserves all known entities and picks the most-progressed
// status for each id. Regenerating from entity files
// (rk registry --write) is the canonical recovery for the on-disk
// artifact; mergeRegistries exists so that any caller wanting to fold two
// pre-computed snapshots into one (e.g. the merge driver, an in-process
// sync) gets a deterministic, content-addressed result without re-parsing.
//
// Properties:
// - Idempotent: mergeRegistries(r, r) is content-identical to r.
// - Commutative: mergeRegistries(a, b).registry is structurally equal to
//   mergeRegistries(b, a).registry. Conflict surfacing on the
//   `local` / `remote` sides may swap, but the conflict identity (kind +
//   id + field) is the same on both invocations. Every nullable scalar
//   uses a symmetric tie-breaker (lexicographic min) instead of "left
//   wins". Tests in core/test/registry.test.ts assert this directly.
// - Total: never throws on schema-valid inputs. Conflicts on immutable
//   fields (title, file path, epic_id) and on diverged scalar values
//   (gate, review_id, base_sha, end_sha) are surfaced via
//   `MergeConflict[]`, not exceptions.

export type MergeConflictKind =
  | 'sprint_immutable'
  | 'sprint_diverged'
  | 'epic_immutable'
  | 'epic_diverged'
  | 'review_immutable'
  | 'review_diverged'
  | 'lane_claim'
  | 'status_divergence';

export interface MergeConflict {
  readonly kind: MergeConflictKind;
  readonly id: string;
  readonly field: string;
  readonly local: unknown;
  readonly remote: unknown;
}

export interface MergeRegistryResult {
  readonly registry: Registry;
  readonly conflicts: readonly MergeConflict[];
}

// Sprint-status precedence ladder — lower values are earlier in the work
// pipeline. Used to resolve concurrent status mutations to the more-
// progressed side. Cancelled is intentionally NOT in this table because
// pickFurthestStatus handles cancelled vs. shipped as an explicit case
// (shipped wins) and cancelled vs. anything-else is also short-circuited
// (the non-cancelled side wins).
const SPRINT_PROGRESS_RANK: Record<Exclude<SprintStatus, 'cancelled'>, number> = {
  planned: 0,
  pending: 1,
  reopened: 2,
  queued: 3,
  active: 4,
  review: 5,
  shipped: 6,
};

function pickFurthestStatus(a: SprintStatus, b: SprintStatus): SprintStatus {
  if (a === b) return a;
  // Cancelled vs shipped: shipping committed work; the cancel was racing
  // a successful close. Shipped wins.
  if (a === 'shipped' || b === 'shipped') return 'shipped';
  // Cancelled vs anything else: the live side wins so an in-flight sprint
  // is not silently shelved by a stale cancel.
  if (a === 'cancelled') return b;
  if (b === 'cancelled') return a;
  return SPRINT_PROGRESS_RANK[a] >= SPRINT_PROGRESS_RANK[b] ? a : b;
}

function pickLaterNullable(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

function pickLaterIso(a: string, b: string): string {
  return a >= b ? a : b;
}

function uniqSortedIds<T extends string>(local: readonly T[], remote: readonly T[]): T[] {
  return [...new Set([...local, ...remote])].sort() as T[];
}

function uniqSortedStrings(local: readonly string[], remote: readonly string[]): string[] {
  return [...new Set([...local, ...remote])].sort();
}

/**
 * Resolve a nullable scalar where divergence between two non-null values is
 * a real conflict. Symmetric: returns the lexicographic min on conflict so
 * mergeRegistries(a, b) and mergeRegistries(b, a) agree on the chosen
 * value. The conflict is surfaced for caller inspection regardless.
 */
function resolveDivergent<T extends string | null>(args: {
  readonly id: string;
  readonly field: string;
  readonly kind: MergeConflictKind;
  readonly a: T;
  readonly b: T;
  readonly conflicts: MergeConflict[];
}): T {
  const { a, b } = args;
  if (a === null) return b;
  if (b === null) return a;
  if (a === b) return a;
  args.conflicts.push({
    kind: args.kind,
    id: args.id,
    field: args.field,
    local: a,
    remote: b,
  });
  // Symmetric tie-breaker so the merge is order-independent.
  return ((a as string) <= (b as string) ? a : b) as T;
}

function recordImmutableConflict<T>(args: {
  readonly id: string;
  readonly field: string;
  readonly kind: MergeConflictKind;
  readonly a: T;
  readonly b: T;
  readonly conflicts: MergeConflict[];
}): T {
  const { a, b } = args;
  if (a === b) return a;
  args.conflicts.push({
    kind: args.kind,
    id: args.id,
    field: args.field,
    local: a,
    remote: b,
  });
  // Immutable fields where both sides claim a different value: pick
  // lexicographic min for a deterministic, commutative result. Caller must
  // resolve the conflict before the merged registry can be considered
  // canonical.
  return (
    typeof a === 'string' && typeof b === 'string' ? ((a as string) <= (b as string) ? a : b) : a
  ) as T;
}

function mergeSprintEntries(
  a: RegistrySprint,
  b: RegistrySprint,
  conflicts: MergeConflict[],
): RegistrySprint {
  return {
    id: a.id,
    title: recordImmutableConflict({
      id: a.id,
      field: 'title',
      kind: 'sprint_immutable',
      a: a.title,
      b: b.title,
      conflicts,
    }),
    epic_id: recordImmutableConflict({
      id: a.id,
      field: 'epic_id',
      kind: 'sprint_immutable',
      a: a.epic_id,
      b: b.epic_id,
      conflicts,
    }),
    status: pickFurthestStatus(a.status, b.status),
    lane: recordImmutableConflict({
      id: a.id,
      field: 'lane',
      kind: 'sprint_immutable',
      a: a.lane,
      b: b.lane,
      conflicts,
    }),
    gate: resolveDivergent({
      id: a.id,
      field: 'gate',
      kind: 'sprint_diverged',
      a: a.gate,
      b: b.gate,
      conflicts,
    }),
    depends_on: uniqSortedIds(a.depends_on, b.depends_on),
    blocked_by: uniqSortedIds(a.blocked_by, b.blocked_by),
    allowed_paths: uniqSortedStrings(a.allowed_paths, b.allowed_paths),
    denied_paths: uniqSortedStrings(a.denied_paths, b.denied_paths),
    generated_paths: uniqSortedStrings(a.generated_paths, b.generated_paths),
    review_required: a.review_required || b.review_required,
    review_id: resolveDivergent({
      id: a.id,
      field: 'review_id',
      kind: 'sprint_diverged',
      a: a.review_id,
      b: b.review_id,
      conflicts,
    }),
    started_at: pickLaterNullable(a.started_at, b.started_at),
    closed_at: pickLaterNullable(a.closed_at, b.closed_at),
    base_sha: resolveDivergent({
      id: a.id,
      field: 'base_sha',
      kind: 'sprint_diverged',
      a: a.base_sha,
      b: b.base_sha,
      conflicts,
    }),
    end_sha: resolveDivergent({
      id: a.id,
      field: 'end_sha',
      kind: 'sprint_diverged',
      a: a.end_sha,
      b: b.end_sha,
      conflicts,
    }),
    file: recordImmutableConflict({
      id: a.id,
      field: 'file',
      kind: 'sprint_immutable',
      a: a.file,
      b: b.file,
      conflicts,
    }),
  };
}

function mergeEpicEntries(
  a: RegistryEpic,
  b: RegistryEpic,
  conflicts: MergeConflict[],
): RegistryEpic {
  return {
    id: a.id,
    title: recordImmutableConflict({
      id: a.id,
      field: 'title',
      kind: 'epic_immutable',
      a: a.title,
      b: b.title,
      conflicts,
    }),
    status:
      a.status === b.status
        ? a.status
        : (() => {
            conflicts.push({
              kind: 'epic_diverged',
              id: a.id,
              field: 'status',
              local: a.status,
              remote: b.status,
            });
            // Stable tie-breaker for terminal divergence; "done" outranks
            // "cancelled" outranks "active" outranks "on_hold" outranks
            // "planned" so a won race lands the further-along state.
            return [a.status, b.status].includes('done')
              ? 'done'
              : [a.status, b.status].includes('cancelled')
                ? 'cancelled'
                : [a.status, b.status].includes('active')
                  ? 'active'
                  : [a.status, b.status].includes('on_hold')
                    ? 'on_hold'
                    : 'planned';
          })(),
    gate: resolveDivergent({
      id: a.id,
      field: 'gate',
      kind: 'epic_diverged',
      a: a.gate,
      b: b.gate,
      conflicts,
    }),
    adr_links: uniqSortedStrings(a.adr_links, b.adr_links),
    sprints: uniqSortedIds(a.sprints, b.sprints),
    ...(a.execution_strategy !== undefined
      ? { execution_strategy: a.execution_strategy }
      : b.execution_strategy !== undefined
        ? { execution_strategy: b.execution_strategy }
        : {}),
    ...(a.parallel_limit !== undefined
      ? { parallel_limit: a.parallel_limit }
      : b.parallel_limit !== undefined
        ? { parallel_limit: b.parallel_limit }
        : {}),
    file: recordImmutableConflict({
      id: a.id,
      field: 'file',
      kind: 'epic_immutable',
      a: a.file,
      b: b.file,
      conflicts,
    }),
  };
}

function mergeReviewEntries(
  a: RegistryReview,
  b: RegistryReview,
  conflicts: MergeConflict[],
): RegistryReview {
  // Verdict precedence: rejected > changes_requested > accepted > pending,
  // applied symmetrically so swapping arguments yields the same result.
  const verdict =
    a.verdict === b.verdict
      ? a.verdict
      : [a.verdict, b.verdict].includes('rejected')
        ? 'rejected'
        : [a.verdict, b.verdict].includes('changes_requested')
          ? 'changes_requested'
          : [a.verdict, b.verdict].includes('accepted')
            ? 'accepted'
            : 'pending';
  return {
    id: a.id,
    sprint_id: recordImmutableConflict({
      id: a.id,
      field: 'sprint_id',
      kind: 'review_immutable',
      a: a.sprint_id,
      b: b.sprint_id,
      conflicts,
    }),
    verdict,
    reviewer: recordImmutableConflict({
      id: a.id,
      field: 'reviewer',
      kind: 'review_immutable',
      a: a.reviewer,
      b: b.reviewer,
      conflicts,
    }),
    base_sha: resolveDivergent({
      id: a.id,
      field: 'base_sha',
      kind: 'review_diverged',
      a: a.base_sha,
      b: b.base_sha,
      conflicts,
    }),
    end_sha: resolveDivergent({
      id: a.id,
      field: 'end_sha',
      kind: 'review_diverged',
      a: a.end_sha,
      b: b.end_sha,
      conflicts,
    }),
    file: recordImmutableConflict({
      id: a.id,
      field: 'file',
      kind: 'review_immutable',
      a: a.file,
      b: b.file,
      conflicts,
    }),
  };
}

function mergeLaneEntries(
  a: RegistryLane,
  b: RegistryLane,
  conflicts: MergeConflict[],
): RegistryLane {
  // Two divergent non-null claims are a real conflict. Symmetric resolution
  // picks the lexicographic min so the function is commutative; the caller
  // releases the loser via the lifecycle layer.
  let claimedBy: string | null;
  if (a.claimed_by === null) {
    claimedBy = b.claimed_by;
  } else if (b.claimed_by === null) {
    claimedBy = a.claimed_by;
  } else if (a.claimed_by === b.claimed_by) {
    claimedBy = a.claimed_by;
  } else {
    conflicts.push({
      kind: 'lane_claim',
      id: a.name,
      field: 'claimed_by',
      local: a.claimed_by,
      remote: b.claimed_by,
    });
    claimedBy = a.claimed_by <= b.claimed_by ? a.claimed_by : b.claimed_by;
  }
  return {
    name: a.name,
    claimed_by: claimedBy,
    claimed_at: pickLaterNullable(a.claimed_at, b.claimed_at),
    inferred: a.inferred && b.inferred,
  };
}

function mergeById<T extends { id: string }>(
  local: readonly T[],
  remote: readonly T[],
  combine: (a: T, b: T) => T,
): T[] {
  const out = new Map<string, T>();
  for (const entry of local) out.set(entry.id, entry);
  for (const entry of remote) {
    const existing = out.get(entry.id);
    out.set(entry.id, existing ? combine(existing, entry) : entry);
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeFindings(local: readonly Finding[], remote: readonly Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  const key = (f: Finding) =>
    [f.code, f.severity, f.entityId ?? '', f.file ?? '', f.message].join('');
  for (const f of local) seen.set(key(f), f);
  for (const f of remote) if (!seen.has(key(f))) seen.set(key(f), f);
  return [...seen.values()].sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    return key(a).localeCompare(key(b));
  });
}

export function mergeRegistries(local: Registry, remote: Registry): MergeRegistryResult {
  const conflicts: MergeConflict[] = [];

  const sprints = mergeById(local.sprints, remote.sprints, (a, b) =>
    mergeSprintEntries(a, b, conflicts),
  );
  const epics = mergeById(local.epics, remote.epics, (a, b) => mergeEpicEntries(a, b, conflicts));
  const reviews = mergeById(local.reviews, remote.reviews, (a, b) =>
    mergeReviewEntries(a, b, conflicts),
  );

  const lanesByName = new Map<string, RegistryLane>();
  for (const lane of local.lanes) lanesByName.set(lane.name, lane);
  for (const lane of remote.lanes) {
    const existing = lanesByName.get(lane.name);
    lanesByName.set(lane.name, existing ? mergeLaneEntries(existing, lane, conflicts) : lane);
  }
  const lanes = [...lanesByName.values()].sort((a, b) => a.name.localeCompare(b.name));

  const queueLanes = new Set<string>([...Object.keys(local.queue), ...Object.keys(remote.queue)]);
  const queue: Registry['queue'] = {};
  for (const lane of [...queueLanes].sort()) {
    const localSlots = local.queue[lane] ?? [];
    const remoteSlots = remote.queue[lane] ?? [];
    const byId = new Map<string, (typeof localSlots)[number]>();
    for (const slot of localSlots) byId.set(slot.id, slot);
    for (const slot of remoteSlots) {
      const existing = byId.get(slot.id);
      // Slot order may diverge across sides; pick the lower (earlier) order
      // for determinism. Lifecycle reconcile is responsible for normalising
      // the resulting sequence after merge.
      byId.set(
        slot.id,
        existing ? { ...existing, order: Math.min(existing.order, slot.order) } : slot,
      );
    }
    queue[lane] = [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  const findings = mergeFindings(local.findings, remote.findings);

  // health is recomputed entirely from the merged finding set so the
  // visible entries and the health summary cannot diverge. We do NOT carry
  // forward the input registries' `blocked` flag — the merged finding set
  // is the source of truth, and a finding that was P1 on one side and
  // missing on the other must produce a `blocked: true` based on the
  // presence of that P1 finding alone.
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity]++;
  let maxSeverity: Severity | null = null;
  for (const f of findings) {
    if (maxSeverity === null || SEVERITY_RANK[f.severity] < SEVERITY_RANK[maxSeverity]) {
      maxSeverity = f.severity;
    }
  }
  // Default fail threshold matches PoliciesSchema's default ("P1"). A custom
  // threshold lives on the Config and is not present here; consumers that
  // need a precise re-evaluation should call generateRegistry from entity
  // files instead of merging two pre-derived registries.
  const blocked = findings.some((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK.P1);

  // `next` is a derived view (resolveNextRunnableSprint). Canonical
  // recovery is to regenerate from entity files. For the in-memory merge
  // we union per-lane, picking the higher-priority result (runnable >
  // blocked > none) when both sides disagree, so a freshly-runnable lane
  // is not silently downgraded by a stale blocked snapshot.
  const NEXT_RANK: Record<RegistryNext['result'], number> = {
    runnable: 0,
    blocked: 1,
    none: 2,
  };
  const pickNext = (a: RegistryNext, b: RegistryNext): RegistryNext =>
    NEXT_RANK[a.result] <= NEXT_RANK[b.result] ? a : b;
  const nextByLane = new Map<string, RegistryNext>();
  for (const slot of local.next) nextByLane.set(slot.lane, slot);
  for (const slot of remote.next) {
    const existing = nextByLane.get(slot.lane);
    nextByLane.set(slot.lane, existing ? pickNext(existing, slot) : slot);
  }
  const next = [...nextByLane.values()].sort((a, b) => a.lane.localeCompare(b.lane));

  const merged: Registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedBy:
      local.generatedBy === remote.generatedBy
        ? local.generatedBy
        : // Sort the joined names so mergeRegistries(a, b) and
          // mergeRegistries(b, a) produce the same generatedBy string.
          [local.generatedBy, remote.generatedBy]
            .sort()
            .join('+'),
    generatedAt: pickLaterIso(local.generatedAt, remote.generatedAt),
    // Project metadata is taken from the lexicographically smaller side so
    // the merge stays commutative even if the two snapshots disagree on
    // project id/name (they should not, but a config rename mid-merge is
    // possible).
    project:
      local.project.id === remote.project.id && local.project.name === remote.project.name
        ? local.project
        : local.project.id <= remote.project.id
          ? local.project
          : remote.project,
    health: { maxSeverity, findingCounts: counts, blocked },
    epics,
    sprints,
    reviews,
    queue,
    lanes,
    next,
    findings,
  };

  return { registry: merged, conflicts };
}

// ---------------------------------------------------------------------------
// Post-merge integrity check
// ---------------------------------------------------------------------------
// Ensures that the merged registry has no orphaned cross-references. This is
// the lightweight invariant set checked at merge time; the full validator
// engine still owns project-level rules (cycles, queue ordering, etc).

export interface RegistryIntegrityIssue {
  readonly kind:
    | 'sprint_missing_epic'
    | 'sprint_missing_dep'
    | 'review_missing_sprint'
    | 'queue_missing_sprint'
    | 'sprint_missing_review'
    | 'epic_missing_sprint'
    | 'epic_sprints_mismatch';
  readonly id: string;
  readonly missing: string;
}

export function checkRegistryIntegrity(reg: Registry): RegistryIntegrityIssue[] {
  const issues: RegistryIntegrityIssue[] = [];
  const sprintIds = new Set(reg.sprints.map((s) => s.id));
  const epicIds = new Set(reg.epics.map((e) => e.id));
  const reviewIds = new Set(reg.reviews.map((r) => r.id));

  // Build epic → sprint reverse index so we can detect sprints that claim
  // membership in an epic whose `sprints[]` array does not list them, and
  // epics that list a sprint id which does not exist as a sprint entry.
  const sprintsByEpic = new Map<string, Set<string>>();
  for (const s of reg.sprints) {
    if (!sprintsByEpic.has(s.epic_id)) sprintsByEpic.set(s.epic_id, new Set());
    sprintsByEpic.get(s.epic_id)?.add(s.id);
  }

  for (const s of reg.sprints) {
    if (!epicIds.has(s.epic_id)) {
      issues.push({ kind: 'sprint_missing_epic', id: s.id, missing: s.epic_id });
    }
    for (const dep of s.depends_on) {
      if (!sprintIds.has(dep)) {
        issues.push({ kind: 'sprint_missing_dep', id: s.id, missing: dep });
      }
    }
    if (s.review_id && !reviewIds.has(s.review_id)) {
      issues.push({ kind: 'sprint_missing_review', id: s.id, missing: s.review_id });
    }
  }
  for (const r of reg.reviews) {
    if (!sprintIds.has(r.sprint_id)) {
      issues.push({ kind: 'review_missing_sprint', id: r.id, missing: r.sprint_id });
    }
  }
  for (const [lane, slots] of Object.entries(reg.queue)) {
    for (const slot of slots) {
      if (!sprintIds.has(slot.sprint_id)) {
        issues.push({
          kind: 'queue_missing_sprint',
          id: `${lane}:${slot.id}`,
          missing: slot.sprint_id,
        });
      }
    }
  }

  // Epic-side cross-checks: every entry in epic.sprints must correspond to
  // an existing sprint, and a sprint that names this epic must appear in
  // epic.sprints. The two checks together catch the post-merge case where
  // one branch added a sprint to the epic's array and the other branch
  // added the sprint entry itself.
  for (const e of reg.epics) {
    const declaredOnEpic = new Set(e.sprints);
    for (const sid of e.sprints) {
      if (!sprintIds.has(sid)) {
        issues.push({ kind: 'epic_missing_sprint', id: e.id, missing: sid });
      }
    }
    const referencingSprints = sprintsByEpic.get(e.id) ?? new Set();
    for (const sid of referencingSprints) {
      if (!declaredOnEpic.has(sid)) {
        issues.push({ kind: 'epic_sprints_mismatch', id: e.id, missing: sid });
      }
    }
  }
  return issues;
}
