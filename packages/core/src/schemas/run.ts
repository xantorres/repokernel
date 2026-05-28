import { z } from 'zod';
import { EpicIdSchema, ReviewIdSchema, RunIdSchema, SprintIdSchema } from './ids.js';
import { LaneNameSchema } from './path.js';
import { SprintStatusSchema } from './sprint.js';

export const RUN_STATUSES = ['running', 'paused', 'completed', 'aborted', 'failed'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RUN_MODES = ['assisted', 'autonomous'] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RunAgentSchema = z.string().min(1);
export type RunAgent = z.infer<typeof RunAgentSchema>;

export const RUN_SPRINT_VERDICTS = [
  'accepted',
  'changes_requested',
  'rejected',
  'aborted',
  'failed',
  'blocked',
] as const;
export const RunSprintVerdictSchema = z.enum(RUN_SPRINT_VERDICTS);
export type RunSprintVerdict = z.infer<typeof RunSprintVerdictSchema>;

export const RunSprintRecordSchema = z
  .object({
    id: SprintIdSchema,
    verdict: RunSprintVerdictSchema,
    summary_path: z.string().min(1),
    start_sha: z.string().min(7).nullable(),
    end_sha: z.string().min(7).nullable(),
  })
  .strict();

export type RunSprintRecord = z.infer<typeof RunSprintRecordSchema>;

// --- Parallel execution types ---

export const PARALLEL_WORKER_STATUSES = ['running', 'completed', 'failed', 'blocked'] as const;
export const ParallelWorkerStatusSchema = z.enum(PARALLEL_WORKER_STATUSES);
export type ParallelWorkerStatus = z.infer<typeof ParallelWorkerStatusSchema>;

export const ParallelWorkerSchema = z
  .object({
    sprint_id: SprintIdSchema,
    worktree: z.string().min(1),
    branch: z.string().min(1),
    status: ParallelWorkerStatusSchema,
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }).optional(),
    agent_pid: z.number().int().positive().optional(),
  })
  .strict();

export type ParallelWorker = z.infer<typeof ParallelWorkerSchema>;

export const PENDING_WAVE_STATUSES = [
  'running',
  'awaiting_reviews',
  'merging',
  'merged',
  'failed',
] as const;
export const PendingWaveStatusSchema = z.enum(PENDING_WAVE_STATUSES);
export type PendingWaveStatus = z.infer<typeof PendingWaveStatusSchema>;

export const PendingWaveSchema = z
  .object({
    index: z.number().int().min(0),
    status: PendingWaveStatusSchema,
    sprint_ids: z.array(SprintIdSchema),
    awaiting_reviews: z.array(ReviewIdSchema).optional(),
    // sprint_id → branch name, e.g. { "S-003": "rk/sprint/E-001/S-003" }
    branches: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

export type PendingWave = z.infer<typeof PendingWaveSchema>;

// --- Run record ---

export const RUN_EXECUTION_STRATEGIES = ['sequential', 'parallel'] as const;
export const RunExecutionStrategySchema = z.enum(RUN_EXECUTION_STRATEGIES);
export type RunExecutionStrategy = z.infer<typeof RunExecutionStrategySchema>;

export const RunSchema = z
  .object({
    id: RunIdSchema,
    epic_id: EpicIdSchema,
    lane: LaneNameSchema,
    status: RunStatusSchema,
    mode: RunModeSchema,
    agent: z.string().min(1), // accepts any agent name; runtime validates against runner registry
    worktree: z.string().min(1),
    branch: z.string().min(1),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }).nullable(),
    current_sprint: SprintIdSchema.nullable(),
    completed_sprints: z.array(RunSprintRecordSchema).default([]),
    halt_reason: z.string().nullable(),
    limit: z.number().int().positive().nullable(),
    sprint_count: z.number().int().min(0),
    // parallel execution fields (default to sequential for backward compat)
    execution_strategy: RunExecutionStrategySchema.default('sequential'),
    wave_index: z.number().int().min(-1).default(-1),
    active_sprints: z.array(SprintIdSchema).default([]),
    parallel_workers: z.array(ParallelWorkerSchema).default([]),
    pending_wave: PendingWaveSchema.optional(),
    owner_pid: z.number().int().positive().optional(),
    abort_requested: z.boolean().default(false),
    checkpoint_sha: z.string().min(7).optional(),
  })
  .strict();

export type Run = z.infer<typeof RunSchema>;

// --- Team status snapshot ---
//
// Snapshot type returned by `rk team status`. It composes data from the
// run files, the registry and the parsed entity files into a single
// dashboard-shaped object so external monitoring (CI dashboards, IDE
// integrations) only has to consume one shape.
//
// Mutable state (run files) drives `runs[]`. Derived state (sprint
// position, registry health) drives `registry`. The shape is permissive
// — a plain `z.object` rather than `.strict()` — so future additions
// don't break consumers parsing today's snapshots.

export const TeamStatusRunSchema = z.object({
  run_id: RunIdSchema,
  epic_id: EpicIdSchema,
  status: RunStatusSchema,
  active_sprints: z.number().int().min(0),
  states: z.object({
    ready: z.number().int().min(0),
    active: z.number().int().min(0),
    review: z.number().int().min(0),
    merging: z.number().int().min(0),
  }),
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }).nullable(),
  eta: z.string().datetime({ offset: true }).nullable(),
});
export type TeamStatusRun = z.infer<typeof TeamStatusRunSchema>;

export const TeamStatusSprintSchema = z.object({
  id: SprintIdSchema,
  title: z.string(),
  status: SprintStatusSchema,
  agent: z.string().nullable(),
  lane: LaneNameSchema,
  run_id: RunIdSchema.nullable(),
  progress: z.string().nullable(),
  started_at: z.string().datetime({ offset: true }).nullable(),
  eta: z.string().datetime({ offset: true }).nullable(),
});
export type TeamStatusSprint = z.infer<typeof TeamStatusSprintSchema>;

export const TeamStatusRegistrySchema = z.object({
  files_changed: z.number().int().min(0),
  conflicts: z.number().int().min(0),
  ready_to_merge: z.boolean(),
  health: z.enum(['OK', 'BLOCKED', 'DEGRADED']),
});
export type TeamStatusRegistry = z.infer<typeof TeamStatusRegistrySchema>;

export const TeamStatusOperationalSchema = z.object({
  live_claims: z.array(
    z.object({
      sprint_id: SprintIdSchema,
      run_id: RunIdSchema,
      claimed_at: z.string(),
    }),
  ),
  corrupt_run_files: z.array(
    z.object({
      file: z.string(),
      reason: z.string(),
    }),
  ),
  leaked_worktrees: z.array(
    z.object({
      kind: z.enum(['sprint', 'epic']),
      id: z.string(),
      path: z.string(),
      branch: z.string().nullable(),
    }),
  ),
  active_worktree_count: z.number().int().min(0),
  /**
   * Errors encountered while collecting operational state. Non-empty means
   * the dashboard is degraded; agents should surface these before dispatch.
   * The bare-catch silent-degradation that v1.14 shipped with collapsed
   * git failures into "no leaks detected" — this field forces the failure
   * to surface in the JSON contract.
   */
  collection_errors: z.array(z.string()).default([]),
});
export type TeamStatusOperational = z.infer<typeof TeamStatusOperationalSchema>;

export const EMPTY_OPERATIONAL: TeamStatusOperational = {
  live_claims: [],
  corrupt_run_files: [],
  leaked_worktrees: [],
  active_worktree_count: 0,
  collection_errors: [],
};

/**
 * `schemaVersion` is the public-contract gate for `rk team status --json`.
 * Bumps document additive changes are safe; consumers branch on the integer.
 * v1: pre-operational shape (1.13.x and earlier)
 * v2: adds `operational` block, defaulted so v1 captures still parse
 */
export const TeamStatusSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  timestamp: z.string().datetime({ offset: true }),
  runs: z.array(TeamStatusRunSchema),
  sprints: z.array(TeamStatusSprintSchema),
  registry: TeamStatusRegistrySchema,
  operational: TeamStatusOperationalSchema.default(EMPTY_OPERATIONAL),
  bottlenecks: z.array(z.string()),
});
export type TeamStatus = z.infer<typeof TeamStatusSchema>;

export const HALT_REASONS = {
  LIMIT_REACHED: 'limit_reached',
  CONFIG_ERROR: 'config_error',
  EPIC_COMPLETED: 'epic_completed',
  EPIC_NOT_FOUND: 'epic_not_found',
  NO_RUNNABLE_SPRINT: 'no_runnable_sprint',
  PATH_CONFLICT: 'path_conflict',
  AWAITING_REVIEW: 'awaiting_review',
  AWAITING_REVIEWS: 'awaiting_reviews',
  REVIEW_NOT_ACCEPTED: 'review_not_accepted',
  USER_ABORT: 'user_abort',
  UNSCOPED_PARALLEL_SPRINT: 'unscoped_parallel_sprint',
  // Prefixes for compound halt_reason values (suffix `:sprintId` or `:gateId`)
  AGENT_FAILED: 'agent_failed',
  AGENT_BLOCKED: 'agent_blocked',
  GATE_BLOCKED: 'gate',
  MERGE_CONFLICT: 'merge_conflict',
  REVIEW_FAILED: 'review_failed',
  CLOSE_FAILED: 'close_failed',
} as const;

export type HaltReason = (typeof HALT_REASONS)[keyof typeof HALT_REASONS];
