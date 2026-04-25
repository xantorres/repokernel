import { z } from 'zod';
import { EpicStatusSchema } from './epic.js';
import { FindingSchema, SeveritySchema } from './finding.js';
import { EpicIdSchema, ReviewIdSchema, SprintIdSchema } from './ids.js';
import { QueueSlotSchema } from './queue.js';
import { ReviewVerdictSchema } from './review.js';
import { SprintStatusSchema } from './sprint.js';

export const REGISTRY_SCHEMA_VERSION = 1;

export const RegistryProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const RegistryHealthSchema = z
  .object({
    maxSeverity: SeveritySchema.nullable(),
    findingCounts: z.object({
      P0: z.number().int().nonnegative(),
      P1: z.number().int().nonnegative(),
      P2: z.number().int().nonnegative(),
      P3: z.number().int().nonnegative(),
    }),
    blocked: z.boolean(),
  })
  .strict();

export const RegistrySprintSchema = z
  .object({
    id: SprintIdSchema,
    title: z.string(),
    epic_id: EpicIdSchema,
    status: SprintStatusSchema,
    lane: z.string(),
    gate: z.string().nullable(),
    depends_on: z.array(SprintIdSchema),
    review_id: ReviewIdSchema.nullable(),
    started_at: z.string().nullable(),
    closed_at: z.string().nullable(),
    base_sha: z.string().nullable(),
    end_sha: z.string().nullable(),
    file: z.string(),
  })
  .strict();

export const RegistryEpicSchema = z
  .object({
    id: EpicIdSchema,
    title: z.string(),
    status: EpicStatusSchema,
    gate: z.string().nullable(),
    adr_links: z.array(z.string()),
    sprints: z.array(SprintIdSchema),
    file: z.string(),
  })
  .strict();

export const RegistryReviewSchema = z
  .object({
    id: ReviewIdSchema,
    sprint_id: SprintIdSchema,
    verdict: ReviewVerdictSchema,
    reviewer: z.string(),
    base_sha: z.string().nullable(),
    end_sha: z.string().nullable(),
    file: z.string(),
  })
  .strict();

export const RegistryLaneSchema = z
  .object({
    name: z.string(),
    claimed_by: z.string().nullable(),
    claimed_at: z.string().nullable(),
    inferred: z.boolean(),
  })
  .strict();

export const RegistryNextSchema = z
  .object({
    lane: z.string(),
    result: z.enum(['runnable', 'blocked', 'none']),
    sprint_id: SprintIdSchema.nullable(),
    blockers: z.array(FindingSchema),
  })
  .strict();

export const RegistrySchema = z
  .object({
    schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
    generatedBy: z.string(),
    generatedAt: z.string().datetime({ offset: true }),
    project: RegistryProjectSchema,
    health: RegistryHealthSchema,
    epics: z.array(RegistryEpicSchema),
    sprints: z.array(RegistrySprintSchema),
    reviews: z.array(RegistryReviewSchema),
    queue: z.record(z.string(), z.array(QueueSlotSchema)),
    lanes: z.array(RegistryLaneSchema),
    next: z.array(RegistryNextSchema),
    findings: z.array(FindingSchema),
  })
  .strict();

export type Registry = z.infer<typeof RegistrySchema>;
export type RegistrySprint = z.infer<typeof RegistrySprintSchema>;
export type RegistryEpic = z.infer<typeof RegistryEpicSchema>;
export type RegistryReview = z.infer<typeof RegistryReviewSchema>;
export type RegistryLane = z.infer<typeof RegistryLaneSchema>;
export type RegistryNext = z.infer<typeof RegistryNextSchema>;
