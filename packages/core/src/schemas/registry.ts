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
// status for each id. The graph-level fix (regenerate from entity files
// after merge) is the canonical recovery; this function exists so that
// purely-derived metadata (timestamps, finding lists, lane state) can be
// reconciled without re-parsing every entity file.
//
// Properties:
// - Idempotent: mergeRegistries(r, r) is content-identical to r.
// - Commutative on the merged set: same ids → same output regardless of
//   which side is local vs remote, modulo any conflict-resolution side that
//   surfaces on different fields (callers can normalize ordering).
// - Total: never throws on schema-valid inputs. Conflicts on immutable
//   fields (title, file path, epic_id) are surfaced via `MergeConflict[]`,
//   not exceptions, so the caller decides whether to abort.

export type MergeConflictKind =
  | 'sprint_immutable'
  | 'epic_immutable'
  | 'review_immutable'
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

const SPRINT_PROGRESS_RANK: Record<SprintStatus, number> = {
  planned: 0,
  pending: 1,
  reopened: 2,
  queued: 3,
  active: 4,
  review: 5,
  shipped: 6,
  cancelled: 7,
};

function pickFurthestStatus(local: SprintStatus, remote: SprintStatus): SprintStatus {
  // Cancelled and shipped are both terminal. Shipped beats cancelled because
  // shipping implies the work landed; a concurrent cancel was racing a
  // committed close.
  if (local === remote) return local;
  if (local === 'shipped' || remote === 'shipped') return 'shipped';
  if (local === 'cancelled') return remote;
  if (remote === 'cancelled') return local;
  return SPRINT_PROGRESS_RANK[local] >= SPRINT_PROGRESS_RANK[remote] ? local : remote;
}

function pickLater(localIso: string | null, remoteIso: string | null): string | null {
  if (localIso === null) return remoteIso;
  if (remoteIso === null) return localIso;
  return localIso >= remoteIso ? localIso : remoteIso;
}

function uniqSortedIds<T extends string>(local: readonly T[], remote: readonly T[]): T[] {
  return [...new Set([...local, ...remote])].sort() as T[];
}

function uniqSortedStrings(local: readonly string[], remote: readonly string[]): string[] {
  return [...new Set([...local, ...remote])].sort();
}

function mergeSprintEntries(
  local: RegistrySprint,
  remote: RegistrySprint,
  conflicts: MergeConflict[],
): RegistrySprint {
  // Immutable fields — divergence is a real conflict. Local wins for output
  // continuity, but the conflict is recorded so callers can surface it.
  for (const field of ['title', 'epic_id', 'lane', 'file'] as const) {
    if (local[field] !== remote[field]) {
      conflicts.push({
        kind: 'sprint_immutable',
        id: local.id,
        field,
        local: local[field],
        remote: remote[field],
      });
    }
  }

  return {
    id: local.id,
    title: local.title,
    epic_id: local.epic_id,
    status: pickFurthestStatus(local.status, remote.status),
    lane: local.lane,
    gate: local.gate ?? remote.gate,
    depends_on: uniqSortedIds(local.depends_on, remote.depends_on),
    blocked_by: uniqSortedIds(local.blocked_by, remote.blocked_by),
    allowed_paths: uniqSortedStrings(local.allowed_paths, remote.allowed_paths),
    denied_paths: uniqSortedStrings(local.denied_paths, remote.denied_paths),
    generated_paths: uniqSortedStrings(local.generated_paths, remote.generated_paths),
    review_required: local.review_required || remote.review_required,
    review_id: local.review_id ?? remote.review_id,
    started_at: pickLater(local.started_at, remote.started_at),
    closed_at: pickLater(local.closed_at, remote.closed_at),
    base_sha: local.base_sha ?? remote.base_sha,
    end_sha: local.end_sha ?? remote.end_sha,
    file: local.file,
  };
}

function mergeEpicEntries(
  local: RegistryEpic,
  remote: RegistryEpic,
  conflicts: MergeConflict[],
): RegistryEpic {
  for (const field of ['title', 'file'] as const) {
    if (local[field] !== remote[field]) {
      conflicts.push({
        kind: 'epic_immutable',
        id: local.id,
        field,
        local: local[field],
        remote: remote[field],
      });
    }
  }
  return {
    ...local,
    sprints: uniqSortedIds(local.sprints, remote.sprints),
    adr_links: uniqSortedStrings(local.adr_links, remote.adr_links),
  };
}

function mergeReviewEntries(
  local: RegistryReview,
  remote: RegistryReview,
  conflicts: MergeConflict[],
): RegistryReview {
  for (const field of ['sprint_id', 'reviewer', 'file'] as const) {
    if (local[field] !== remote[field]) {
      conflicts.push({
        kind: 'review_immutable',
        id: local.id,
        field,
        local: local[field],
        remote: remote[field],
      });
    }
  }
  // Verdict precedence: any non-pending overrides pending; if both non-pending
  // and divergent, prefer the more conservative (rejected > changes_requested
  // > accepted) so reviewers can't silently lose a rejection.
  const verdict =
    local.verdict === remote.verdict
      ? local.verdict
      : [local.verdict, remote.verdict].includes('rejected')
        ? 'rejected'
        : [local.verdict, remote.verdict].includes('changes_requested')
          ? 'changes_requested'
          : [local.verdict, remote.verdict].includes('accepted')
            ? 'accepted'
            : 'pending';
  return {
    ...local,
    verdict,
    base_sha: local.base_sha ?? remote.base_sha,
    end_sha: local.end_sha ?? remote.end_sha,
  };
}

function mergeLaneEntries(
  local: RegistryLane,
  remote: RegistryLane,
  conflicts: MergeConflict[],
): RegistryLane {
  // Two divergent claims are a true conflict — both runs believe they own
  // the lane. We surface and keep `local` for determinism; the caller is
  // expected to release the loser via lifecycle commands.
  if (
    local.claimed_by !== null &&
    remote.claimed_by !== null &&
    local.claimed_by !== remote.claimed_by
  ) {
    conflicts.push({
      kind: 'lane_claim',
      id: local.name,
      field: 'claimed_by',
      local: local.claimed_by,
      remote: remote.claimed_by,
    });
  }
  return {
    name: local.name,
    claimed_by: local.claimed_by ?? remote.claimed_by,
    claimed_at: pickLater(local.claimed_at, remote.claimed_at),
    inferred: local.inferred && remote.inferred,
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

function pickLaterIso(a: string, b: string): string {
  return a >= b ? a : b;
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

  // health is recomputed from the merged finding set so it stays consistent
  // with the visible entries; this prevents the downstream registry consumer
  // from seeing a maxSeverity that no merged finding actually claims.
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity]++;
  let maxSeverity: Severity | null = null;
  for (const f of findings) {
    if (maxSeverity === null || SEVERITY_RANK[f.severity] < SEVERITY_RANK[maxSeverity]) {
      maxSeverity = f.severity;
    }
  }
  const blocked = local.health.blocked || remote.health.blocked;

  // `next` is a derived view (resolveNextRunnableSprint) — once entity files
  // are merged the canonical recovery is to regenerate. For the in-memory
  // merge result we keep the per-lane union, preferring local on collision.
  const nextByLane = new Map<string, RegistryNext>();
  for (const slot of remote.next) nextByLane.set(slot.lane, slot);
  for (const slot of local.next) nextByLane.set(slot.lane, slot);
  const next = [...nextByLane.values()].sort((a, b) => a.lane.localeCompare(b.lane));

  const merged: Registry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedBy:
      local.generatedBy === remote.generatedBy
        ? local.generatedBy
        : `${local.generatedBy}+${remote.generatedBy}`,
    generatedAt: pickLaterIso(local.generatedAt, remote.generatedAt),
    project: local.project,
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
    | 'sprint_missing_review';
  readonly id: string;
  readonly missing: string;
}

export function checkRegistryIntegrity(reg: Registry): RegistryIntegrityIssue[] {
  const issues: RegistryIntegrityIssue[] = [];
  const sprintIds = new Set(reg.sprints.map((s) => s.id));
  const epicIds = new Set(reg.epics.map((e) => e.id));
  const reviewIds = new Set(reg.reviews.map((r) => r.id));

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
  return issues;
}
