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
  .strict();

export type ReviewPathsChecked = z.infer<typeof ReviewPathsCheckedSchema>;

export const PanelVerdictSchema = z.enum(['GREEN', 'YELLOW', 'RED']);
export type PanelVerdict = z.infer<typeof PanelVerdictSchema>;

const PanelReviewerFindingSchema = z
  .object({
    severity: z.string().min(1),
    message: z.string().min(1),
    code: z.string().optional(),
    suggestion: z.string().optional(),
  })
  .strict();

export type PanelReviewerFinding = z.infer<typeof PanelReviewerFindingSchema>;

const PanelReviewerRunSchema = z
  .object({
    reviewer_id: z.string().min(1),
    verdict: PanelVerdictSchema,
    findings: z.array(PanelReviewerFindingSchema).default([]),
    completed_at: z.string().datetime({ offset: true }),
    error: z.string().min(1).optional(),
  })
  .strict();

export type PanelReviewerRun = z.infer<typeof PanelReviewerRunSchema>;

const PanelPolicySnapshotSchema = z
  .object({
    yellow_blocks_close: z.boolean(),
  })
  .strict();

export type PanelPolicySnapshot = z.infer<typeof PanelPolicySnapshotSchema>;

const PanelRunSchema = z
  .object({
    round: z.number().int().positive(),
    aggregate: PanelVerdictSchema,
    completed_at: z.string().datetime({ offset: true }),
    reviewers: z.array(PanelReviewerRunSchema),
    policy_snapshot: PanelPolicySnapshotSchema.optional(),
  })
  .strict();

export type PanelRun = z.infer<typeof PanelRunSchema>;

export const CommandEvidenceStatusSchema = z.enum(['passed', 'failed', 'skipped']);
export type CommandEvidenceStatus = z.infer<typeof CommandEvidenceStatusSchema>;

export const CommandEvidenceSchema = z
  .object({
    label: z.string().min(1),
    command: z.string().min(1).optional(),
    exit_code: z.number().int().nullable().optional(),
    status: CommandEvidenceStatusSchema,
    ran_at: z.string().datetime({ offset: true }),
    summary: z.string().min(1).optional(),
    /**
     * True when this evidence was captured during a transitional window
     * (e.g. a validator that goes red because a queued dependent is still
     * waiting on this sprint to ship — the very transition this review
     * authorizes). Transitional failures are surfaced in the run record but
     * do NOT gate the reviewer verdict. Defaults to false (blocking) for
     * forward compatibility with evidence written by older RKs.
     */
    transitional: z.boolean().optional(),
  })
  .strict();
export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;

/**
 * Partition `command_evidence` into the subset that gates the verdict
 * (`blocking_failures`) and the subset captured during transitional windows
 * (`transitional_failures`). A passed/skipped entry never appears in either
 * — only `failed` ones do. Used by `rk gates` rendering and review-verdict
 * propagation.
 */
export function partitionCommandEvidence(evidence: readonly CommandEvidence[]): {
  readonly blocking_failures: readonly CommandEvidence[];
  readonly transitional_failures: readonly CommandEvidence[];
} {
  const blocking: CommandEvidence[] = [];
  const transitional: CommandEvidence[] = [];
  for (const item of evidence) {
    if (item.status !== 'failed') continue;
    if (item.transitional === true) transitional.push(item);
    else blocking.push(item);
  }
  return { blocking_failures: blocking, transitional_failures: transitional };
}

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
    reviewed_at: z.string().datetime({ offset: true }).optional(),
    changed_files: z.array(RepoRelativePathSchema).optional(),
    paths_checked: ReviewPathsCheckedSchema.optional(),
    command_evidence: z.array(CommandEvidenceSchema).default([]),
    panel_runs: optionalNullable(z.array(PanelRunSchema)),
    panel_aggregate: optionalNullable(PanelVerdictSchema),
    panel_policy_snapshot: optionalNullable(PanelPolicySnapshotSchema),
    extras: z.record(z.unknown()).default({}),
  })
  .strict();

export type ReviewFrontmatter = z.infer<typeof ReviewFrontmatterSchema>;

export interface Review extends ReviewFrontmatter {
  readonly file: string;
  readonly body: string;
}
