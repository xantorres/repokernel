import { z } from 'zod';
import { ReviewIdSchema, ShaSchema, SprintIdSchema } from './ids.js';
import { RepoRelativePathSchema } from './path.js';

export const REVIEW_VERDICTS = ['pending', 'accepted', 'changes_requested', 'rejected'] as const;

export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReviewFindingSchema = z
  .object({
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    message: z.string().min(1),
    data: z.record(z.unknown()).optional(),
  })
  .strict();
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewPathsCheckedSchema = z
  .object({
    allowed_paths_matched: z.boolean().optional(),
    denied_paths_clean: z.boolean().optional(),
  })
  .passthrough();

export type ReviewPathsChecked = z.infer<typeof ReviewPathsCheckedSchema>;

export const PanelVerdictSchema = z.enum(['GREEN', 'YELLOW', 'RED']);
export type PanelVerdict = z.infer<typeof PanelVerdictSchema>;

const PanelReviewerFindingSchema = z.object({
  severity: z.string().min(1),
  message: z.string().min(1),
  code: z.string().optional(),
  suggestion: z.string().optional(),
});

export type PanelReviewerFinding = z.infer<typeof PanelReviewerFindingSchema>;

const PanelReviewerRunSchema = z.object({
  reviewer_id: z.string().min(1),
  verdict: PanelVerdictSchema,
  findings: z.array(PanelReviewerFindingSchema).default([]),
  completed_at: z.string().datetime({ offset: true }),
});

export type PanelReviewerRun = z.infer<typeof PanelReviewerRunSchema>;

const PanelRunSchema = z.object({
  round: z.number().int().positive(),
  aggregate: PanelVerdictSchema,
  completed_at: z.string().datetime({ offset: true }),
  reviewers: z.array(PanelReviewerRunSchema),
});

export type PanelRun = z.infer<typeof PanelRunSchema>;

function optionalNullable<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}

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
    changed_files: z.array(RepoRelativePathSchema).optional(),
    paths_checked: ReviewPathsCheckedSchema.optional(),
    panel_runs: optionalNullable(z.array(PanelRunSchema)),
    panel_aggregate: optionalNullable(PanelVerdictSchema),
    extras: z.record(z.unknown()).default({}),
  })
  .strict();

export type ReviewFrontmatter = z.infer<typeof ReviewFrontmatterSchema>;

export interface Review extends ReviewFrontmatter {
  readonly file: string;
  readonly body: string;
}
