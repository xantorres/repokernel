import { z } from 'zod';

/**
 * Declarative bulk-import plan. A tree of epics and their sprints written with
 * id-less local `alias`es. `rk import` allocates real E-NNN / S-NNN ids and
 * resolves `depends_on` aliases to those ids after allocation; `rk export`
 * emits this same shape with `alias` set to the entity id so a project
 * round-trips.
 *
 * Versioned like the other authored RepoKernel YAML (config v1, registry v3): a
 * breaking change bumps `schemaVersion` and ships a migration rather than
 * silently reinterpreting old files. `.strict()` so a typo'd key fails loudly
 * instead of being dropped.
 */
export const IMPORT_PLAN_SCHEMA_VERSION = 1;

export const ImportSprintSchema = z
  .object({
    /** Local identifier, unique within the plan; referenced by `depends_on`. */
    alias: z.string().min(1),
    title: z.string().min(1),
    lane: z.string().min(1).optional(),
    status: z.enum(['planned', 'pending']).optional(),
    /** Prerequisite sprints, by local alias or an already-existing S-NNN id. */
    depends_on: z.array(z.string().min(1)).optional(),
    allowed_paths: z.array(z.string().min(1)).optional(),
    denied_paths: z.array(z.string().min(1)).optional(),
    adr_links: z.array(z.string().min(1)).optional(),
    target_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'target_date must be yyyy-mm-dd')
      .optional(),
    /** Full sprint body markdown (no frontmatter). */
    body: z.string().optional(),
    /** Project-private metadata passthrough (ADR-49); preserved on round-trip. */
    extras: z.record(z.unknown()).optional(),
  })
  .strict();

export const ImportEpicSchema = z
  .object({
    alias: z.string().min(1),
    title: z.string().min(1),
    adr_links: z.array(z.string().min(1)).optional(),
    extras: z.record(z.unknown()).optional(),
    sprints: z.array(ImportSprintSchema).default([]),
  })
  .strict();

export const ImportPlanSchema = z
  .object({
    schemaVersion: z.literal(IMPORT_PLAN_SCHEMA_VERSION),
    // Empty is valid: `rk export` of a freshly-initialized project (no epics
    // yet) must emit a parseable plan rather than throwing.
    epics: z.array(ImportEpicSchema),
  })
  .strict();

export type ImportPlan = z.infer<typeof ImportPlanSchema>;
export type ImportEpic = z.infer<typeof ImportEpicSchema>;
export type ImportSprint = z.infer<typeof ImportSprintSchema>;
