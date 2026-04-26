import { z } from 'zod';
import { EpicIdSchema, SprintIdSchema } from './ids.js';

export const EPIC_STATUSES = ['planned', 'active', 'on_hold', 'done', 'cancelled'] as const;

export const EpicStatusSchema = z.enum(EPIC_STATUSES);
export type EpicStatus = z.infer<typeof EpicStatusSchema>;

export const EPIC_EXECUTION_STRATEGIES = ['sequential', 'parallel'] as const;
export const EpicExecutionStrategySchema = z.enum(EPIC_EXECUTION_STRATEGIES);
export type EpicExecutionStrategy = z.infer<typeof EpicExecutionStrategySchema>;

export const EpicFrontmatterSchema = z
  .object({
    id: EpicIdSchema,
    title: z.string().min(1),
    status: EpicStatusSchema,
    gate: z.string().min(1).optional(),
    adr_links: z.array(z.string().min(1)).default([]),
    sprints: z.array(SprintIdSchema).default([]),
    execution_strategy: EpicExecutionStrategySchema.optional(),
    parallel_limit: z.number().int().positive().optional(),
  })
  .strict();

export type EpicFrontmatter = z.infer<typeof EpicFrontmatterSchema>;

export interface Epic extends EpicFrontmatter {
  readonly file: string;
  readonly body: string;
}
