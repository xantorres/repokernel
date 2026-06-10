import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EpicExecutionStrategySchema, EpicStatusSchema } from './epic.js';
import {
  type Finding,
  FindingSchema,
  SEVERITY_RANK,
  type Severity,
  SeveritySchema,
} from './finding.js';
import { EpicIdSchema, ReviewIdSchema, type SprintId, SprintIdSchema } from './ids.js';
import { TrackerProviderSchema } from './integration.js';
import { RepoRelativeGlobSchema } from './path.js';
import { type QueueSlot, QueueSlotSchema } from './queue.js';
import { ReviewVerdictSchema } from './review.js';
import { type SprintStatus, SprintStatusSchema } from './sprint.js';

export const REGISTRY_SCHEMA_VERSION = 3;

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

/**
 * Reverse index from tracker ticket → ingested epic + sprint(s).
 *
 * Populated by `generateRegistry` whenever an epic frontmatter carries
 * `extras.tracker_source` + `extras.external_id` (the shape `synthesizeTaskState`
 * already writes for `--from-tracker` epics). Lets `rk intake` and operators
 * answer "have I already ingested this ticket?" without rescanning every
 * epic file.
 *
 * `sprint_ids` is derived from the epic's child sprints, so it stays in sync
 * across registry regeneration without duplicate metadata on each sprint.
 */
export const RegistryTrackerIndexEntrySchema = z
  .object({
    source: TrackerProviderSchema,
    external_id: z.string().min(1),
    epic_id: EpicIdSchema,
    sprint_ids: z.array(SprintIdSchema),
  })
  .strict();

export const REGISTRY_SCHEMA_VERSIONS_SUPPORTED = [2, REGISTRY_SCHEMA_VERSION] as const;

const registryPayloadShape = {
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
  tracker_index: z.array(RegistryTrackerIndexEntrySchema).optional(),
} as const;

const RegistryV3Schema = z
  .object({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    ...registryPayloadShape,
  })
  .strict();

const RegistryV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...registryPayloadShape,
  })
  .strict()
  .transform((registry) => ({
    ...registry,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
  }));

export const RegistrySchema = z.union([RegistryV3Schema, RegistryV2Schema]);

export type Registry = z.output<typeof RegistrySchema>;
export type RegistrySprint = z.infer<typeof RegistrySprintSchema>;
export type RegistryEpic = z.infer<typeof RegistryEpicSchema>;
export type RegistryReview = z.infer<typeof RegistryReviewSchema>;
export type RegistryLane = z.infer<typeof RegistryLaneSchema>;
export type RegistryNext = z.infer<typeof RegistryNextSchema>;
export type RegistryTrackerIndexEntry = z.infer<typeof RegistryTrackerIndexEntrySchema>;

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
  | 'status_divergence'
  | 'delete_modify'
  | 'queue_id_collision'
  | 'tracker_index_collision';

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

/**
 * Symmetric resolution for the registry's `project` block. Two snapshots
 * agree on identity in the common case; when they don't (concurrent
 * project rename, or ID drift across a config change), pick by composite
 * key so mergeRegistries(a, b) and mergeRegistries(b, a) produce the same
 * winner regardless of side. Both fields participate so a name change
 * with the same id is also commutative — the prior implementation only
 * tied on id and let `local.project` win on name drift.
 */
function pickProject<T extends { id: string; name: string }>(a: T, b: T): T {
  if (a.id === b.id && a.name === b.name) return a;
  // Use JSON.stringify on a fixed-shape object as the composite key. Injective
  // for all string values regardless of NUL or whitespace embedded in id/name.
  const aKey = JSON.stringify({ id: a.id, name: a.name });
  const bKey = JSON.stringify({ id: b.id, name: b.name });
  return aKey <= bKey ? a : b;
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

/**
 * Resolve a divergent optional value via an explicit precedence-aware comparator.
 *
 * Generic over the value type, and forces the caller to supply a `compare`
 * function so the tie-break is never accidentally lex-min on a domain-specific
 * enum. `compare(a, b)` should return a negative number when `a` is the more
 * conservative / preferred winner. Always emits a conflict on real divergence.
 */
function resolveOptionalDivergent<T>(args: {
  readonly id: string;
  readonly field: string;
  readonly kind: MergeConflictKind;
  readonly a: T | undefined;
  readonly b: T | undefined;
  readonly compare: (a: T, b: T) => number;
  readonly conflicts: MergeConflict[];
}): T | undefined {
  if (args.a === undefined) return args.b;
  if (args.b === undefined) return args.a;
  if (args.a === args.b) return args.a;
  args.conflicts.push({
    kind: args.kind,
    id: args.id,
    field: args.field,
    local: args.a,
    remote: args.b,
  });
  return args.compare(args.a, args.b) <= 0 ? args.a : args.b;
}

// Conservative-by-default precedence for epic execution strategy.
// `sequential` enforces ordering between sprints; `parallel` is the
// looser default. On a real divergence we pick the stricter side so a
// branch that introduced explicit ordering does not lose its constraint
// to a stale parallel-default snapshot.
const EXECUTION_STRATEGY_PRECEDENCE: Record<'sequential' | 'parallel', number> = {
  sequential: 0,
  parallel: 1,
};
function compareExecutionStrategy(
  a: 'sequential' | 'parallel',
  b: 'sequential' | 'parallel',
): number {
  return EXECUTION_STRATEGY_PRECEDENCE[a] - EXECUTION_STRATEGY_PRECEDENCE[b];
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
  const executionStrategy = resolveOptionalDivergent({
    id: a.id,
    field: 'execution_strategy',
    kind: 'epic_diverged',
    a: a.execution_strategy,
    b: b.execution_strategy,
    compare: compareExecutionStrategy,
    conflicts,
  });
  // Conservative-by-default: smaller numeric parallel_limit wins (less concurrency).
  const parallelLimit = resolveOptionalDivergent({
    id: a.id,
    field: 'parallel_limit',
    kind: 'epic_diverged',
    a: a.parallel_limit,
    b: b.parallel_limit,
    compare: (x, y) => x - y,
    conflicts,
  });

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
    ...(executionStrategy !== undefined ? { execution_strategy: executionStrategy } : {}),
    ...(parallelLimit !== undefined ? { parallel_limit: parallelLimit } : {}),
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

/**
 * Merge per-lane queue slots. Identity is `sprint_id`. The slot `id` is opaque
 * outside of display, but historic divergent branches may have assigned the
 * same `id` to different sprints; the post-pass below detects duplicate ids
 * across the merged slots and regenerates them deterministically (and emits
 * a `queue_id_collision` conflict for caller awareness).
 */
function mergeQueueSlots(
  lane: string,
  localSlots: readonly QueueSlot[],
  remoteSlots: readonly QueueSlot[],
  conflicts: MergeConflict[],
): QueueSlot[] {
  const bySprint = new Map<string, QueueSlot>();
  for (const slot of localSlots) bySprint.set(slot.sprint_id, slot);
  for (const slot of remoteSlots) {
    const existing = bySprint.get(slot.sprint_id);
    if (!existing) {
      bySprint.set(slot.sprint_id, slot);
      continue;
    }
    bySprint.set(slot.sprint_id, {
      ...existing,
      id: existing.id <= slot.id ? existing.id : slot.id,
      order: Math.min(existing.order, slot.order),
    });
  }
  const merged = [...bySprint.values()].sort(
    (a, b) => a.order - b.order || a.sprint_id.localeCompare(b.sprint_id),
  );

  // Detect duplicate slot ids produced by cross-sprint id borrow across
  // diverged branches (e.g. local Q-001/S-1 + Q-002/S-2 vs remote Q-001/S-2 +
  // Q-003/S-1 → both merged slots end up id=Q-001). Regenerate the loser's id
  // deterministically by appending the sprint_id, and surface as a conflict
  // so callers can refuse a clean merge if they want stricter semantics.
  const seenIds = new Map<string, QueueSlot>();
  const repaired: QueueSlot[] = [];
  for (const slot of merged) {
    const prior = seenIds.get(slot.id);
    if (!prior) {
      seenIds.set(slot.id, slot);
      repaired.push(slot);
      continue;
    }
    conflicts.push({
      kind: 'queue_id_collision',
      id: `${lane}:${slot.id}`,
      field: 'queue',
      local: prior,
      remote: slot,
    });
    // Keep the lex-min sprint_id slot under the original id; rename the other.
    if (prior.sprint_id <= slot.sprint_id) {
      const renamed: QueueSlot = { ...slot, id: `${slot.id}-${slot.sprint_id}` };
      seenIds.set(renamed.id, renamed);
      repaired.push(renamed);
    } else {
      // Replace the prior winner with `slot` (lex-min sprint_id) under the
      // original id, and rename `prior` so its id remains unique.
      const idx = repaired.indexOf(prior);
      const renamedPrior: QueueSlot = { ...prior, id: `${prior.id}-${prior.sprint_id}` };
      if (idx >= 0) repaired[idx] = renamedPrior;
      seenIds.delete(prior.id);
      seenIds.set(renamedPrior.id, renamedPrior);
      seenIds.set(slot.id, slot);
      repaired.push(slot);
    }
  }
  return repaired.sort(
    (a, b) =>
      a.order - b.order || a.id.localeCompare(b.id) || a.sprint_id.localeCompare(b.sprint_id),
  );
}

function mergeFindings(local: readonly Finding[], remote: readonly Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  const key = (f: Finding) =>
    [f.code, f.severity, f.entityId ?? '', f.file ?? '', f.message].join('\x01');
  for (const f of local) seen.set(key(f), f);
  for (const f of remote) if (!seen.has(key(f))) seen.set(key(f), f);
  return [...seen.values()].sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    return key(a).localeCompare(key(b));
  });
}

interface ReconciledArray<T, K extends string> {
  readonly local: T[];
  readonly remote: T[];
  readonly deletedKeys: ReadonlySet<K>;
}

function sameEntry(a: unknown, b: unknown): boolean {
  // Structural deep-equals so logically-equal entities with different key
  // insertion orders (e.g. older generateRegistry output vs newer) do not
  // produce false delete_modify conflicts.
  return isDeepStrictEqual(a, b);
}

function reconcileDeletedEntries<T, K extends string>(args: {
  readonly field: string;
  readonly base: readonly T[];
  readonly local: readonly T[];
  readonly remote: readonly T[];
  readonly keyOf: (entry: T) => K;
  readonly conflicts: MergeConflict[];
}): ReconciledArray<T, K> {
  const baseByKey = new Map(args.base.map((entry) => [args.keyOf(entry), entry] as const));
  const localByKey = new Map(args.local.map((entry) => [args.keyOf(entry), entry] as const));
  const remoteByKey = new Map(args.remote.map((entry) => [args.keyOf(entry), entry] as const));
  const dropLocal = new Set<K>();
  const dropRemote = new Set<K>();
  const deletedKeys = new Set<K>();

  for (const [key, baseEntry] of baseByKey) {
    const localEntry = localByKey.get(key);
    const remoteEntry = remoteByKey.get(key);

    if (localEntry === undefined && remoteEntry !== undefined) {
      if (sameEntry(baseEntry, remoteEntry)) {
        // Clean delete vs unchanged → drop on both sides; mark deleted.
        dropRemote.add(key);
        deletedKeys.add(key);
      } else {
        // delete vs modify → record conflict AND drop the modified side too,
        // so the merged registry reflects the deletion. The conflict[] entry
        // is the caller's signal to refuse a clean write; without dropping
        // the modified side here, the merged blob would resurrect the entity.
        args.conflicts.push({
          kind: 'delete_modify',
          id: key,
          field: args.field,
          local: null,
          remote: remoteEntry,
        });
        dropRemote.add(key);
        deletedKeys.add(key);
      }
    } else if (remoteEntry === undefined && localEntry !== undefined) {
      if (sameEntry(baseEntry, localEntry)) {
        dropLocal.add(key);
        deletedKeys.add(key);
      } else {
        args.conflicts.push({
          kind: 'delete_modify',
          id: key,
          field: args.field,
          local: localEntry,
          remote: null,
        });
        dropLocal.add(key);
        deletedKeys.add(key);
      }
    }
  }

  return {
    local: args.local.filter((entry) => !dropLocal.has(args.keyOf(entry))),
    remote: args.remote.filter((entry) => !dropRemote.has(args.keyOf(entry))),
    deletedKeys,
  };
}

function copyQueue(queue: Registry['queue']): Registry['queue'] {
  return Object.fromEntries(Object.entries(queue).map(([lane, slots]) => [lane, [...slots]]));
}

function removeSprintReferences(
  registry: Registry,
  deletedSprintIds: ReadonlySet<string>,
): Registry {
  if (deletedSprintIds.size === 0) return registry;
  return {
    ...registry,
    epics: registry.epics.map((epic) => ({
      ...epic,
      sprints: epic.sprints.filter((id) => !deletedSprintIds.has(id)),
    })),
    reviews: registry.reviews.filter((review) => !deletedSprintIds.has(review.sprint_id)),
    queue: Object.fromEntries(
      Object.entries(registry.queue).map(([lane, slots]) => [
        lane,
        slots.filter((slot) => !deletedSprintIds.has(slot.sprint_id)),
      ]),
    ),
    next: registry.next.map((entry) =>
      entry.sprint_id !== null && deletedSprintIds.has(entry.sprint_id)
        ? { ...entry, result: 'none', sprint_id: null, blockers: [] }
        : entry,
    ),
  };
}

function removeTrackerIndexReferences(
  registry: Registry,
  deletedEpicIds: ReadonlySet<string>,
  deletedSprintIds: ReadonlySet<string>,
): Registry {
  if (
    registry.tracker_index === undefined ||
    (deletedEpicIds.size === 0 && deletedSprintIds.size === 0)
  ) {
    return registry;
  }

  const trackerIndex = registry.tracker_index
    .filter((entry) => !deletedEpicIds.has(entry.epic_id))
    .map((entry) => ({
      ...entry,
      sprint_ids: entry.sprint_ids.filter((id) => !deletedSprintIds.has(id)),
    }));

  const { tracker_index: _trackerIndex, ...withoutTrackerIndex } = registry;
  return trackerIndex.length > 0
    ? { ...registry, tracker_index: trackerIndex }
    : withoutTrackerIndex;
}

function removeReviewReferences(
  registry: Registry,
  deletedReviewIds: ReadonlySet<string>,
): Registry {
  if (deletedReviewIds.size === 0) return registry;
  return {
    ...registry,
    sprints: registry.sprints.map((sprint) =>
      sprint.review_id !== null && deletedReviewIds.has(sprint.review_id)
        ? { ...sprint, review_id: null }
        : sprint,
    ),
  };
}

function reconcileQueueDeletions(args: {
  readonly base: Registry['queue'];
  readonly local: Registry['queue'];
  readonly remote: Registry['queue'];
  readonly conflicts: MergeConflict[];
}): { readonly local: Registry['queue']; readonly remote: Registry['queue'] } {
  const local = copyQueue(args.local);
  const remote = copyQueue(args.remote);

  for (const [lane, baseSlots] of Object.entries(args.base)) {
    const localSlots = local[lane] ?? [];
    const remoteSlots = remote[lane] ?? [];
    const localBySprint = new Map(localSlots.map((slot) => [slot.sprint_id, slot] as const));
    const remoteBySprint = new Map(remoteSlots.map((slot) => [slot.sprint_id, slot] as const));

    for (const baseSlot of baseSlots) {
      const localSlot = localBySprint.get(baseSlot.sprint_id);
      const remoteSlot = remoteBySprint.get(baseSlot.sprint_id);

      if (localSlot === undefined && remoteSlot !== undefined) {
        if (sameEntry(baseSlot, remoteSlot)) {
          remote[lane] = (remote[lane] ?? []).filter(
            (slot) => slot.sprint_id !== baseSlot.sprint_id,
          );
        } else {
          args.conflicts.push({
            kind: 'delete_modify',
            id: `${lane}:${baseSlot.sprint_id}`,
            field: 'queue',
            local: null,
            remote: remoteSlot,
          });
          // Drop modified-side too so the merged queue honors the deletion.
          remote[lane] = (remote[lane] ?? []).filter(
            (slot) => slot.sprint_id !== baseSlot.sprint_id,
          );
        }
      } else if (remoteSlot === undefined && localSlot !== undefined) {
        if (sameEntry(baseSlot, localSlot)) {
          local[lane] = (local[lane] ?? []).filter((slot) => slot.sprint_id !== baseSlot.sprint_id);
        } else {
          args.conflicts.push({
            kind: 'delete_modify',
            id: `${lane}:${baseSlot.sprint_id}`,
            field: 'queue',
            local: localSlot,
            remote: null,
          });
          local[lane] = (local[lane] ?? []).filter((slot) => slot.sprint_id !== baseSlot.sprint_id);
        }
      }
    }
  }

  return { local, remote };
}

export function mergeRegistriesThreeWay(
  base: Registry,
  local: Registry,
  remote: Registry,
): MergeRegistryResult {
  const conflicts: MergeConflict[] = [];

  const sprints = reconcileDeletedEntries({
    field: 'sprints',
    base: base.sprints,
    local: local.sprints,
    remote: remote.sprints,
    keyOf: (entry) => entry.id,
    conflicts,
  });
  const epics = reconcileDeletedEntries({
    field: 'epics',
    base: base.epics,
    local: local.epics,
    remote: remote.epics,
    keyOf: (entry) => entry.id,
    conflicts,
  });
  const reviews = reconcileDeletedEntries({
    field: 'reviews',
    base: base.reviews,
    local: local.reviews,
    remote: remote.reviews,
    keyOf: (entry) => entry.id,
    conflicts,
  });
  const lanes = reconcileDeletedEntries({
    field: 'lanes',
    base: base.lanes,
    local: local.lanes,
    remote: remote.lanes,
    keyOf: (entry) => entry.name,
    conflicts,
  });

  let adjustedLocal: Registry = {
    ...local,
    sprints: sprints.local,
    epics: epics.local,
    reviews: reviews.local,
    lanes: lanes.local,
  };
  let adjustedRemote: Registry = {
    ...remote,
    sprints: sprints.remote,
    epics: epics.remote,
    reviews: reviews.remote,
    lanes: lanes.remote,
  };

  adjustedLocal = removeSprintReferences(adjustedLocal, sprints.deletedKeys);
  adjustedRemote = removeSprintReferences(adjustedRemote, sprints.deletedKeys);
  adjustedLocal = removeTrackerIndexReferences(
    adjustedLocal,
    epics.deletedKeys,
    sprints.deletedKeys,
  );
  adjustedRemote = removeTrackerIndexReferences(
    adjustedRemote,
    epics.deletedKeys,
    sprints.deletedKeys,
  );
  adjustedLocal = removeReviewReferences(adjustedLocal, reviews.deletedKeys);
  adjustedRemote = removeReviewReferences(adjustedRemote, reviews.deletedKeys);

  const queue = reconcileQueueDeletions({
    base: base.queue,
    local: adjustedLocal.queue,
    remote: adjustedRemote.queue,
    conflicts,
  });
  adjustedLocal = { ...adjustedLocal, queue: queue.local };
  adjustedRemote = { ...adjustedRemote, queue: queue.remote };

  const result = mergeRegistries(adjustedLocal, adjustedRemote);
  return { registry: result.registry, conflicts: [...conflicts, ...result.conflicts] };
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
    queue[lane] = mergeQueueSlots(lane, localSlots, remoteSlots, conflicts);
  }

  const findings = mergeFindings(local.findings, remote.findings);

  // health is recomputed from the merged findings against the default P1
  // threshold. A custom-threshold project that has NO P1+ findings but still
  // wants to be blocked must regenerate via `rk registry --write` after the
  // merge — propagating a sticky `blocked: true` across merges makes the bit
  // monotonically true and breaks the documented recovery path. We DO carry
  // an input `blocked: true` forward when that side STILL has findings that
  // could justify it, so a custom-threshold P2 finding present on either side
  // keeps the project blocked until that finding is resolved.
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity]++;
  let maxSeverity: Severity | null = null;
  for (const f of findings) {
    if (maxSeverity === null || SEVERITY_RANK[f.severity] < SEVERITY_RANK[maxSeverity]) {
      maxSeverity = f.severity;
    }
  }
  const localContributes = local.health.blocked && local.findings.length > 0;
  const remoteContributes = remote.health.blocked && remote.findings.length > 0;
  const blocked =
    localContributes ||
    remoteContributes ||
    findings.some((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK.P1);

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

  const trackerIndex = mergeTrackerIndex(local.tracker_index, remote.tracker_index, conflicts);

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
    project: pickProject(local.project, remote.project),
    health: { maxSeverity, findingCounts: counts, blocked },
    epics,
    sprints,
    reviews,
    queue,
    lanes,
    next,
    findings,
    ...(trackerIndex !== undefined ? { tracker_index: trackerIndex } : {}),
  };

  return { registry: merged, conflicts };
}

/**
 * Union two tracker_index lists by `(source, external_id)`. Same-key entries
 * for the same epic union `sprint_ids`; same-key entries owned by different
 * epics record a conflict and keep the lexicographically-first owner so the
 * merged artifact remains commutative. Returns `undefined` when both sides
 * omit the field, so a v3 registry with no tracker entries does not gain an
 * empty array post-merge.
 */
function mergeTrackerIndex(
  local: readonly RegistryTrackerIndexEntry[] | undefined,
  remote: readonly RegistryTrackerIndexEntry[] | undefined,
  conflicts: MergeConflict[],
): RegistryTrackerIndexEntry[] | undefined {
  if (local === undefined && remote === undefined) return undefined;
  const byKey = new Map<string, RegistryTrackerIndexEntry>();
  for (const entry of local ?? []) byKey.set(`${entry.source}:${entry.external_id}`, entry);
  for (const entry of remote ?? []) {
    const key = `${entry.source}:${entry.external_id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    const epicConflict = existing.epic_id !== entry.epic_id;
    if (epicConflict) {
      conflicts.push({
        kind: 'tracker_index_collision',
        id: key,
        field: 'tracker_index',
        local: existing,
        remote: entry,
      });
    }

    const winner = existing.epic_id <= entry.epic_id ? existing : entry;
    const sprintIds = epicConflict
      ? [...winner.sprint_ids].sort()
      : uniqSortedIds(existing.sprint_ids, entry.sprint_ids);
    byKey.set(key, {
      source: winner.source,
      external_id: winner.external_id,
      epic_id: winner.epic_id,
      sprint_ids: sprintIds,
    });
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.source}:${a.external_id}`.localeCompare(`${b.source}:${b.external_id}`),
  );
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
    | 'epic_sprints_mismatch'
    | 'queue_duplicate_slot_id'
    | 'tracker_index_missing_epic'
    | 'tracker_index_missing_sprint'
    | 'tracker_index_sprint_epic_mismatch';
  readonly id: string;
  readonly missing: string;
}

export function checkRegistryIntegrity(reg: Registry): RegistryIntegrityIssue[] {
  const issues: RegistryIntegrityIssue[] = [];
  const sprintIds = new Set(reg.sprints.map((s) => s.id));
  const epicIds = new Set(reg.epics.map((e) => e.id));
  const reviewIds = new Set(reg.reviews.map((r) => r.id));
  const sprintById = new Map(reg.sprints.map((s) => [s.id, s] as const));

  // Build epic → sprint reverse index so we can detect sprints that claim
  // membership in an epic whose `sprints[]` array does not list them, and
  // epics that list a sprint id which does not exist as a sprint entry.
  const sprintsByEpic = new Map<string, Set<SprintId>>();
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
    const idSeen = new Map<string, string>();
    for (const slot of slots) {
      if (!sprintIds.has(slot.sprint_id)) {
        issues.push({
          kind: 'queue_missing_sprint',
          id: `${lane}:${slot.id}`,
          missing: slot.sprint_id,
        });
      }
      const priorSprintId = idSeen.get(slot.id);
      if (priorSprintId !== undefined && priorSprintId !== slot.sprint_id) {
        issues.push({
          kind: 'queue_duplicate_slot_id',
          id: `${lane}:${slot.id}`,
          missing: slot.sprint_id,
        });
      } else {
        idSeen.set(slot.id, slot.sprint_id);
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
    const referencingSprints = sprintsByEpic.get(e.id) ?? new Set<SprintId>();
    for (const sid of referencingSprints) {
      if (!declaredOnEpic.has(sid)) {
        issues.push({ kind: 'epic_sprints_mismatch', id: e.id, missing: sid });
      }
    }
  }
  for (const entry of reg.tracker_index ?? []) {
    const trackerId = `${entry.source}:${entry.external_id}`;
    const entryEpicExists = epicIds.has(entry.epic_id);
    if (!entryEpicExists) {
      issues.push({
        kind: 'tracker_index_missing_epic',
        id: trackerId,
        missing: entry.epic_id,
      });
    }
    for (const sprintId of entry.sprint_ids) {
      const sprint = sprintById.get(sprintId);
      if (sprint === undefined) {
        issues.push({
          kind: 'tracker_index_missing_sprint',
          id: trackerId,
          missing: sprintId,
        });
      } else if (entryEpicExists && sprint.epic_id !== entry.epic_id) {
        issues.push({
          kind: 'tracker_index_sprint_epic_mismatch',
          id: trackerId,
          missing: sprintId,
        });
      }
    }
  }
  return issues;
}
