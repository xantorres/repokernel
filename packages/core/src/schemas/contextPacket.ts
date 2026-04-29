import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EpicStatusSchema } from './epic.js';
import { FindingSchema } from './finding.js';
import { EpicIdSchema, ReviewIdSchema, ShaSchema, SprintIdSchema } from './ids.js';
import { RepoRelativeGlobSchema, RepoRelativePathSchema } from './path.js';
import { ReviewVerdictSchema } from './review.js';
import { RoutingHintSchema } from './routing.js';
import { SprintStatusSchema } from './sprint.js';

export const CONTEXT_PROFILES = ['implement', 'review', 'wave'] as const;
export const ContextProfileSchema = z.enum(CONTEXT_PROFILES);
export type ContextProfile = z.infer<typeof ContextProfileSchema>;

export const ContextOmissionSchema = z
  .object({
    section: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type ContextOmission = z.infer<typeof ContextOmissionSchema>;

export const ContextScopedManifestSchema = z
  .object({
    files: z.array(RepoRelativePathSchema),
    omitted_count: z.number().int().nonnegative(),
    available: z.boolean(),
  })
  .strict();
export type ContextScopedManifest = z.infer<typeof ContextScopedManifestSchema>;

export const ContextDepStatusSchema = z
  .object({
    id: SprintIdSchema,
    status: SprintStatusSchema.or(z.literal('missing')),
  })
  .strict();
export type ContextDepStatus = z.infer<typeof ContextDepStatusSchema>;

export const ContextRelatedSprintSchema = z
  .object({
    id: SprintIdSchema,
    title: z.string(),
    closed_at: z.string().nullable(),
    relation: z.enum(['dep', 'path_overlap']),
  })
  .strict();
export type ContextRelatedSprint = z.infer<typeof ContextRelatedSprintSchema>;

export const ContextImplementPacketSchema = z
  .object({
    profile: z.literal('implement'),
    target: SprintIdSchema,
    capsule: z
      .object({
        id: SprintIdSchema,
        status: SprintStatusSchema,
        lane: z.string(),
        objective: z.string(),
        epic_id: EpicIdSchema,
        epic_title: z.string(),
        allowed_paths: z.array(RepoRelativeGlobSchema),
        denied_paths: z.array(RepoRelativeGlobSchema),
        deps: z.array(ContextDepStatusSchema),
        blockers: z.array(ContextDepStatusSchema),
        review_required: z.boolean(),
        minimal_commands: z.array(z.string()),
      })
      .strict(),
    objective_excerpt: z.string().optional(),
    findings: z.array(FindingSchema),
    related_sprints: z.array(ContextRelatedSprintSchema),
    scoped_manifest: ContextScopedManifestSchema,
    omissions: z.array(ContextOmissionSchema),
    estimated_tokens: z.number().int().nonnegative(),
    effective_budget: z.number().int().positive(),
    routing_hint: RoutingHintSchema.optional(),
  })
  .strict();
export type ContextImplementPacket = z.infer<typeof ContextImplementPacketSchema>;

export const ContextReviewChangedFilesSourceSchema = z.enum([
  'review_committed',
  'git_diff',
  'worktree_head',
  'unavailable',
]);
export type ContextReviewChangedFilesSource = z.infer<typeof ContextReviewChangedFilesSourceSchema>;

export const ContextReviewPacketSchema = z
  .object({
    profile: z.literal('review'),
    target: SprintIdSchema,
    capsule: z
      .object({
        id: SprintIdSchema,
        sprint_status: SprintStatusSchema,
        review_id: ReviewIdSchema.nullable(),
        verdict: ReviewVerdictSchema.nullable(),
        base_sha: ShaSchema.nullable(),
        end_sha: ShaSchema.nullable(),
        acceptance: z.string(),
        changed_files: z.array(RepoRelativePathSchema),
        changed_files_source: ContextReviewChangedFilesSourceSchema,
        changed_files_omitted: z.number().int().nonnegative(),
        verification_commands: z.array(z.string()),
      })
      .strict(),
    review_findings: z.array(FindingSchema),
    omissions: z.array(ContextOmissionSchema),
    estimated_tokens: z.number().int().nonnegative(),
    effective_budget: z.number().int().positive(),
    routing_hint: RoutingHintSchema.optional(),
  })
  .strict();
export type ContextReviewPacket = z.infer<typeof ContextReviewPacketSchema>;

export const ContextWaveSprintSchema = z
  .object({
    id: SprintIdSchema,
    title: z.string(),
    lane: z.string(),
    status: SprintStatusSchema,
    reason: z.string().optional(),
  })
  .strict();
export type ContextWaveSprint = z.infer<typeof ContextWaveSprintSchema>;

export const ContextWavePacketSchema = z
  .object({
    profile: z.literal('wave'),
    target: EpicIdSchema,
    capsule: z
      .object({
        id: EpicIdSchema,
        title: z.string(),
        status: EpicStatusSchema,
        runnable: z.array(ContextWaveSprintSchema),
        blocked: z.array(ContextWaveSprintSchema),
        gated: z.array(ContextWaveSprintSchema),
        planned: z.array(ContextWaveSprintSchema),
        parallel_safe: z.array(ContextWaveSprintSchema),
        parallel_safe_omitted: z.number().int().nonnegative(),
        minimal_commands: z.array(z.string()),
      })
      .strict(),
    findings: z.array(FindingSchema),
    omissions: z.array(ContextOmissionSchema),
    estimated_tokens: z.number().int().nonnegative(),
    effective_budget: z.number().int().positive(),
    routing_hint: RoutingHintSchema.optional(),
  })
  .strict();
export type ContextWavePacket = z.infer<typeof ContextWavePacketSchema>;

export const ContextPacketSchema = z.discriminatedUnion('profile', [
  ContextImplementPacketSchema,
  ContextReviewPacketSchema,
  ContextWavePacketSchema,
]);
export type ContextPacket = z.infer<typeof ContextPacketSchema>;

const CONTEXT_PACKET_SCHEMA_BY_PROFILE = {
  implement: ContextImplementPacketSchema,
  review: ContextReviewPacketSchema,
  wave: ContextWavePacketSchema,
} as const satisfies Record<ContextProfile, z.ZodTypeAny>;

export function contextPacketJsonSchema(profile: ContextProfile): Record<string, unknown> {
  const schema = zodToJsonSchema(CONTEXT_PACKET_SCHEMA_BY_PROFILE[profile], {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  return {
    ...schema,
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://repokernel.dev/schemas/context-packet/${profile}.json`,
    title: `RepoKernel Context Packet — ${profile}`,
  };
}

export const CONTEXT_PROFILE_BUDGETS: Record<ContextProfile, number> = {
  implement: 8000,
  review: 4000,
  wave: 6000,
};

export const CONTEXT_BUDGET_SAFETY_FACTOR = 0.85;

export function effectiveBudget(rawBudget: number): number {
  return Math.floor(rawBudget * CONTEXT_BUDGET_SAFETY_FACTOR);
}

export function estimateTokens(rendered: string): number {
  return Math.ceil(Buffer.byteLength(rendered, 'utf8') / 4);
}

export const CONTEXT_PROFILE_TARGET_RULES: Record<ContextProfile, 'sprint' | 'epic'> = {
  implement: 'sprint',
  review: 'sprint',
  wave: 'epic',
};
