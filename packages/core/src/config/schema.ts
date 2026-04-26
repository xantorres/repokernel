import { z } from 'zod';
import { SeveritySchema } from '../schemas/finding.js';
import { SPRINT_STATUSES } from '../schemas/sprint.js';

export const CONFIG_SCHEMA_VERSION = 1;

const RepoRelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'path must not contain NUL bytes')
  .refine((value) => !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value), {
    message: 'path must be relative to the project root',
  })
  .refine(
    (value) =>
      !value
        .replaceAll('\\', '/')
        .split('/')
        .some((part) => part === '..'),
    { message: 'path must not contain .. segments' },
  );

export const PathsSchema = z
  .object({
    epics: RepoRelativePathSchema,
    sprints: RepoRelativePathSchema,
    reviews: RepoRelativePathSchema,
    queues: RepoRelativePathSchema,
    lanes: RepoRelativePathSchema,
    decisions: RepoRelativePathSchema.optional(),
    backlog: RepoRelativePathSchema.optional(),
    next: RepoRelativePathSchema.optional(),
    generated: RepoRelativePathSchema,
    registry: RepoRelativePathSchema,
  })
  .strict();

export const PoliciesSchema = z
  .object({
    allowedStatuses: z.array(z.enum(SPRINT_STATUSES)).default([...SPRINT_STATUSES]),
    requireReviewForShipped: z.boolean().default(true),
    requireBaseShaForActive: z.boolean().default(true),
    requireEndShaForShipped: z.boolean().default(true),
    allowMultipleActivePerLane: z.boolean().default(false),
    defaultLane: z.string().min(1).default('main'),
    severityFailThreshold: SeveritySchema.default('P1'),
  })
  .strict();

export const GitPolicySchema = z
  .object({
    requireCleanWorkingTreeForClose: z.boolean().default(true),
    blockUnassignedDirtyFiles: z.boolean().default(true),
    protectedPaths: z.array(z.string()).default([]),
  })
  .strict();

export const GeneratedSchema = z
  .object({
    files: z.array(z.string()).default([]),
  })
  .strict();

export const ChainingSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxSprintsPerRun: z.number().int().positive().default(1),
    requireReviewBetweenSprints: z.boolean().default(true),
    stopOnSeverity: SeveritySchema.default('P1'),
    sameEpicOnly: z.boolean().default(true),
    sameLaneOnly: z.boolean().default(true),
  })
  .strict();

export type Chaining = z.infer<typeof ChainingSchema>;

export const WorktreesSchema = z
  .object({
    root: z.string().min(1).default('../.repokernel-worktrees'),
    branchPrefix: z.string().min(1).default('rk/'),
    baseBranch: z.string().min(1).default('main'),
    autoAcquire: z.boolean().default(true),
    autoRelease: z.boolean().default(false),
  })
  .strict();

export type Worktrees = z.infer<typeof WorktreesSchema>;

export const AutomationSchema = z
  .object({
    allowAutonomousClose: z.boolean().default(false),
    defaultMode: z.enum(['assisted', 'autonomous']).default('assisted'),
    defaultAgent: z.string().min(1).default('manual'),
  })
  .strict();

export type Automation = z.infer<typeof AutomationSchema>;

export const AgentDefinitionSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Only sentinel-json is supported in v1. */
    resultFormat: z.enum(['sentinel-json']).default('sentinel-json'),
    timeoutSeconds: z.number().int().positive().default(1800),
  })
  .strict();

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentsSchema = z.record(z.string().min(1), AgentDefinitionSchema);

export const ParallelConfigSchema = z
  .object({
    maxConcurrentSprints: z.number().int().positive().default(4),
    // v1: only 'block' is supported — overlap always blocks parallel execution
    conflictStrategy: z.literal('block').default('block'),
    // must be true before --allow-overlap CLI flag is accepted
    allowOverlapFlag: z.boolean().default(false),
  })
  .strict();

export type ParallelConfig = z.infer<typeof ParallelConfigSchema>;

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    paths: PathsSchema,
    policies: PoliciesSchema.default({}),
    git: GitPolicySchema.default({}),
    generated: GeneratedSchema.default({}),
    chaining: ChainingSchema.default({}),
    worktrees: WorktreesSchema.default({}),
    automation: AutomationSchema.default({}),
    parallel: ParallelConfigSchema.default({}),
    agents: AgentsSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
