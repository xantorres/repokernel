import { z } from 'zod';
import { EpicIdSchema, RunIdSchema, SprintIdSchema } from './ids.js';

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
    start_sha: z.string().min(7),
    end_sha: z.string().min(7).nullable(),
  })
  .strict();

export type RunSprintRecord = z.infer<typeof RunSprintRecordSchema>;

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
  })
  .strict();

export type Run = z.infer<typeof RunSchema>;
