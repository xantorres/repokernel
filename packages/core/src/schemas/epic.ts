import { z } from 'zod';
import { EpicIdSchema, SprintIdSchema } from './ids.js';

export const EPIC_STATUSES = ['planned', 'active', 'on_hold', 'done', 'cancelled'] as const;

export const EpicStatusSchema = z.enum(EPIC_STATUSES);
export type EpicStatus = z.infer<typeof EpicStatusSchema>;

export const EPIC_EXECUTION_STRATEGIES = ['sequential', 'parallel'] as const;
export const EpicExecutionStrategySchema = z.enum(EPIC_EXECUTION_STRATEGIES);
export type EpicExecutionStrategy = z.infer<typeof EpicExecutionStrategySchema>;

export const QUALITY_RULE_TYPES = [
  'required_files',
  'forbidden_paths',
  'no_secrets',
  'panel_review',
] as const;

const PanelReviewerConfigSchema = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutSeconds: z.number().int().positive().default(300),
    failure_verdict: z.enum(['YELLOW', 'RED']).default('RED'),
    env_passthrough: z.array(z.string()).default([]),
  })
  .strict();

export type PanelReviewerConfig = z.infer<typeof PanelReviewerConfigSchema>;

export const PanelReviewQualityRuleSchema = z
  .object({
    type: z.literal('panel_review'),
    reviewers: z.array(PanelReviewerConfigSchema).min(1),
    yellow_blocks_close: z.boolean().default(false),
  })
  .strict();

export type PanelReviewQualityRule = z.infer<typeof PanelReviewQualityRuleSchema>;

export const QualityRuleSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('required_files'), globs: z.array(z.string().min(1)).min(1) })
    .strict(),
  z
    .object({ type: z.literal('forbidden_paths'), globs: z.array(z.string().min(1)).min(1) })
    .strict(),
  z.object({ type: z.literal('no_secrets') }).strict(),
  PanelReviewQualityRuleSchema,
]);

export type QualityRule = z.infer<typeof QualityRuleSchema>;

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
    quality_rules: z.array(QualityRuleSchema).optional(),
  })
  .strict();

export type EpicFrontmatter = z.infer<typeof EpicFrontmatterSchema>;

export interface Epic extends EpicFrontmatter {
  readonly file: string;
  readonly body: string;
}
