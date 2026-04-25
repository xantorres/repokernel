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
    review_id: ReviewIdSchema.optional(),
    started_at: z.string().datetime({ offset: true }).optional(),
    closed_at: z.string().datetime({ offset: true }).optional(),
    base_sha: ShaSchema.optional(),
    end_sha: ShaSchema.optional(),
  })
  .strict();

export type SprintFrontmatter = z.infer<typeof SprintFrontmatterSchema>;

export interface Sprint extends SprintFrontmatter {
  readonly file: string;
  readonly body: string;
}
