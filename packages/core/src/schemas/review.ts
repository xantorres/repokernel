import { z } from 'zod';
import { ReviewIdSchema, ShaSchema, SprintIdSchema } from './ids.js';

export const REVIEW_VERDICTS = ['pending', 'accepted', 'changes_requested', 'rejected'] as const;

export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewFindingSchema = z
  .object({
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    message: z.string().min(1),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewFrontmatterSchema = z
  .object({
    id: ReviewIdSchema,
    sprint_id: SprintIdSchema,
    verdict: ReviewVerdictSchema,
    reviewer: z.string().min(1),
    findings: z.array(ReviewFindingSchema).default([]),
    base_sha: ShaSchema.optional(),
    end_sha: ShaSchema.optional(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type ReviewFrontmatter = z.infer<typeof ReviewFrontmatterSchema>;

export interface Review extends ReviewFrontmatter {
  readonly file: string;
  readonly body: string;
}
