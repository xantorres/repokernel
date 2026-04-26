import { z } from 'zod';
import { EpicIdSchema, ReviewIdSchema, RunIdSchema, SprintIdSchema } from './ids.js';

export const RUN_STATUSES = ['running', 'paused', 'completed', 'aborted', 'failed'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RUN_MODES = ['assisted', 'autonomous'] as const;
export const RunModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof RunModeSchema>;

export const RUN_AGENTS = ['manual', 'claude'] as const;
export const RunAgentSchema = z.enum(RUN_AGENTS);
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
    // sprint_id → branch name, e.g. { "S-003": "rk/E-001/S-003" }
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
    lane: z.string().min(1),
    status: RunStatusSchema,
    mode: RunModeSchema,
    agent: RunAgentSchema,
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
  })
  .strict();

export type Run = z.infer<typeof RunSchema>;
