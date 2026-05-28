import { z } from 'zod';
import { EpicIdSchema, ReviewIdSchema, ShaSchema, SprintIdSchema } from './ids.js';
import { LaneNameSchema, RepoRelativeGlobSchema } from './path.js';

export const SPRINT_STATUSES = [
  'planned',
  'pending',
  'queued',
  'active',
  'review',
  'shipped',
  'reopened',
  'cancelled',
] as const;

export const SprintStatusSchema = z.enum(SPRINT_STATUSES);
export type SprintStatus = z.infer<typeof SprintStatusSchema>;

function optionalNullable<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}

const OptionalNullableDateTimeSchema = optionalNullable(z.string().datetime({ offset: true }));

export const SprintBudgetSchema = z
  .object({
    max_files: z.number().int().positive().optional(),
    max_loc: z.number().int().positive().optional(),
    test_cmd: z.string().min(1).optional(),
  })
  .strict();

export type SprintBudget = z.infer<typeof SprintBudgetSchema>;

export const SprintFrontmatterSchema = z
  .object({
    id: SprintIdSchema,
    title: z.string().min(1),
    epic_id: EpicIdSchema,
    status: SprintStatusSchema,
    lane: LaneNameSchema,
    gate: z.string().min(1).optional(),
    depends_on: z.array(SprintIdSchema).default([]),
    blocked_by: z.array(SprintIdSchema).default([]),
    allowed_paths: z.array(RepoRelativeGlobSchema).default([]),
    denied_paths: z.array(RepoRelativeGlobSchema).default([]),
    generated_paths: z.array(RepoRelativeGlobSchema).default([]),
    budget: SprintBudgetSchema.optional(),
    review_required: z.boolean().default(true),
    review_id: optionalNullable(ReviewIdSchema),
    started_at: OptionalNullableDateTimeSchema,
    closed_at: OptionalNullableDateTimeSchema,
    cancel_reason: z.string().min(1).optional(),
    base_sha: optionalNullable(ShaSchema),
    end_sha: optionalNullable(ShaSchema),
    target_date: optionalNullable(z.string().date()),
    adr_links: z.array(z.string().min(1)).default([]),
    extras: z.record(z.unknown()).default({}),
  })
  .strict();

export type SprintFrontmatter = z.infer<typeof SprintFrontmatterSchema>;

export interface Sprint extends SprintFrontmatter {
  readonly file: string;
  readonly body: string;
}
