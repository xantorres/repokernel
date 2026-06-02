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

/**
 * Verdict a reviewer gate (e.g. Codex) emits in its sentinel block. Excludes
 * `pending` — a reviewer always returns a decision. `findings` reuse the
 * `ReviewFinding` shape so they write straight to the review frontmatter. This
 * is the "built-in verdict schema" used when `reviewers.<name>.schemaPath` is null.
 */
export const ReviewerGateVerdictSchema = z.enum(['accepted', 'changes_requested', 'rejected']);
export type ReviewerGateVerdict = z.infer<typeof ReviewerGateVerdictSchema>;

export const ReviewerGateOutputSchema = z
  .object({
    verdict: ReviewerGateVerdictSchema,
    findings: z.array(ReviewFindingSchema).default([]),
    summary: z.string().min(1).optional(),
  })
  .strict();
export type ReviewerGateOutput = z.infer<typeof ReviewerGateOutputSchema>;

/**
 * Immutable, signed record of one reviewer-gate run, stored in the review
 * frontmatter under `reviewer_gate` — separate from the mutable
 * `verdict`/`findings` fields that the built-in rule eval, the panel, and the
 * manual override own. The gate is the only producer of this object, so a later
 * `review-sprint`/panel/`review-verdict`/`re-review` pass cannot overwrite the
 * gate decision: those writers touch sibling keys, not this one.
 *
 * `signature` is an HMAC-SHA256 (hex) over a canonical payload bound to the
 * review id, sprint id, attempt, verdict, base_sha, end_sha, reviewed_at, and
 * findings, keyed by a machine-local secret kept outside the repo. A snapshot
 * hand-written into a committed review file therefore cannot be forged, lifted
 * into another review, or replayed across commit ranges. `review_attempt` binds
 * the snapshot to one attempt: `re-review` bumps the attempt, which invalidates
 * any earlier snapshot and forces a fresh gate run.
 */
export const ReviewerGateSnapshotSchema = z
  .object({
    reviewer: z.string().min(1),
    review_attempt: z.number().int().min(1),
    verdict: ReviewerGateVerdictSchema,
    findings: z.array(ReviewFindingSchema).default([]),
    base_sha: ShaSchema,
    end_sha: ShaSchema,
    reviewed_at: z.string().datetime({ offset: true }),
    summary: z.string().min(1).optional(),
    signature: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type ReviewerGateSnapshot = z.infer<typeof ReviewerGateSnapshotSchema>;

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
    source: z.enum(['executed', 'imported']).default('imported'),
    cwd: z.string().min(1).optional(),
    duration_ms: z.number().int().nonnegative().optional(),
    stdout_bytes: z.number().int().nonnegative().optional(),
    stderr_bytes: z.number().int().nonnegative().optional(),
    stdout_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    stderr_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    timed_out: z.boolean().optional(),
    previous_evidence_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .optional(),
    evidence_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    supersedes: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    supersede_reason: z.string().min(1).optional(),
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
  const superseded = new Set(
    evidence
      .map((item) => item.supersedes)
      .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0),
  );
  for (const item of evidence) {
    if (item.status !== 'failed') continue;
    if (item.evidence_hash !== undefined && superseded.has(item.evidence_hash)) continue;
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
    review_attempt: z.number().int().min(1).default(1),
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
    reviewer_gate: optionalNullable(ReviewerGateSnapshotSchema),
    extras: z.record(z.unknown()).default({}),
  })
  .strict();

export type ReviewFrontmatter = z.infer<typeof ReviewFrontmatterSchema>;

export interface Review extends ReviewFrontmatter {
  readonly file: string;
  readonly body: string;
}
