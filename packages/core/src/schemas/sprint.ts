import { z } from 'zod';
import { EpicIdSchema, ReviewIdSchema, ShaSchema, SprintIdSchema } from './ids.js';

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

export const SprintFrontmatterSchema = z
  .object({
    id: SprintIdSchema,
    title: z.string().min(1),
    epic_id: EpicIdSchema,
    status: SprintStatusSchema,
    lane: z.string().min(1),
    gate: z.string().min(1).optional(),
    depends_on: z.array(SprintIdSchema).default([]),
    blocked_by: z.array(SprintIdSchema).default([]),
    allowed_paths: z.array(z.string()).default([]),
    denied_paths: z.array(z.string()).default([]),
    generated_paths: z.array(z.string()).default([]),
    review_required: z.boolean().default(true),
    review_id: optionalNullable(ReviewIdSchema),
    started_at: OptionalNullableDateTimeSchema,
    closed_at: OptionalNullableDateTimeSchema,
    base_sha: optionalNullable(ShaSchema),
    end_sha: optionalNullable(ShaSchema),
  })
  .strict();

export type SprintFrontmatter = z.infer<typeof SprintFrontmatterSchema>;

export interface Sprint extends SprintFrontmatter {
  readonly file: string;
  readonly body: string;
}
