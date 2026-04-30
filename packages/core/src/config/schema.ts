// biome-ignore-all lint/suspicious/noThenProperty: routing rules use a when/then matcher; `then` is a config field, not a Promise then().
import { z } from 'zod';
import { SeveritySchema } from '../schemas/finding.js';
import { SprintIdSchema } from '../schemas/ids.js';
import {
  DEFAULT_TIERS,
  TIER_MAX_LENGTH,
  TIER_MIN_LENGTH,
  TierNameSchema,
} from '../schemas/routing.js';
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
    next: RepoRelativePathSchema.optional(),
    generated: RepoRelativePathSchema,
    registry: RepoRelativePathSchema.default('.repokernel/registry.json'),
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
    /**
     * Sprint IDs reserved as gaps in the numbering. The allocator skips
     * these when picking the next ID at `rk create sprint`. Useful when a
     * project intentionally retires an ID range (e.g. cancelled designs)
     * but wants the gap to remain visible in the numbering.
     */
    skippedSprintIds: z.array(SprintIdSchema).default([]),
    /**
     * Threshold sprint number at and above which a review file is required
     * to ship. When set, `rk close S-NNN` and the review-by-policy validate
     * rule treat the sprint as if `review_required: true` whenever the
     * numeric portion of its ID is >= this value, regardless of the
     * frontmatter flag. Off by default (legacy projects keep current
     * behavior). Example: 38 enforces ADR 26 from S-038 onward.
     */
    requireReviewForShippedFromSprintId: z.number().int().positive().optional(),
  })
  .strict();

export const GitPolicySchema = z
  .object({
    requireCleanWorkingTreeForClose: z.boolean().default(true),
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
  })
  .strict();

export type Worktrees = z.infer<typeof WorktreesSchema>;

export const AutomationSchema = z
  .object({
    allowAutonomousClose: z.boolean().default(false),
    defaultMode: z.enum(['assisted', 'autonomous']).default('assisted'),
    defaultAgent: z.string().min(1).default('manual'),
    checksCmd: z.string().optional(),
    /**
     * Wall-clock timeout (seconds) for the configured `checksCmd` invocation.
     * On expiry the process is sent SIGTERM, then SIGKILL after a short
     * grace period. Default 1800s (30 min) — long enough for full test
     * suites, short enough that a wedged check cannot stall the close
     * pipeline indefinitely.
     */
    checksTimeoutSeconds: z.number().int().positive().default(1800),
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
    /**
     * Extra env-var names that the parent process may pass through to the
     * spawned agent. By default, external agents receive only a minimal
     * allowlist (PATH, HOME, SHELL, TERM, TMPDIR, TEMP, CI) — no API keys,
     * tokens, or other repo-irrelevant secrets. Add explicit names here
     * when an agent needs OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.
     */
    envPassthrough: z.array(z.string().min(1)).default([]),
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

/**
 * Cost-aware agent routing policy. Vendor-agnostic by design — `routing.tiers`
 * holds opaque tier names ordered cheap → expensive; the consumer maps tier
 * names to concrete model IDs in their skill or local config.
 *
 * Closed sets enforced here to keep the rule shape brutally flat:
 *   - allowed `when` keys: see ROUTING_RULE_WHEN_KEYS
 *   - allowed operator suffixes: _eq | _lt | _lte | _gt | _gte (bare = _eq)
 *   - `then` may set `tier` (required) and `fanout` (optional, ≤8)
 *   - max 16 rules per project; first match wins; AND across keys
 */
export const ROUTING_RULE_WHEN_KEYS = [
  'profile',
  'est_tokens',
  'allowed_paths_count',
  'depends_on_count',
  'ac_count',
  'review_required',
  'gate',
  'lane',
  'extras_complexity',
] as const;
export type RoutingRuleWhenKey = (typeof ROUTING_RULE_WHEN_KEYS)[number];

export const ROUTING_RULE_OPERATOR_SUFFIXES = ['_eq', '_lt', '_lte', '_gt', '_gte'] as const;
export type RoutingRuleOperatorSuffix = (typeof ROUTING_RULE_OPERATOR_SUFFIXES)[number];

export const ROUTING_RULES_MAX = 16;
export const ROUTING_FANOUT_MAX = 8;

export const RoutingRuleFanoutEntrySchema = z
  .object({
    id: z.string().min(1).max(60),
    tier: TierNameSchema,
  })
  .strict();

export const RoutingRuleThenSchema = z
  .object({
    tier: TierNameSchema,
    fanout: z.array(RoutingRuleFanoutEntrySchema).max(ROUTING_FANOUT_MAX).optional(),
  })
  .strict();
export type RoutingRuleThen = z.infer<typeof RoutingRuleThenSchema>;

/**
 * `when` is a flat scalar map. We accept it as a record and validate keys +
 * value shapes during config load, where we can emit per-key findings; here
 * we only enforce the structural envelope. Unknown keys / operators surface
 * as P1 findings via the load path, not Zod errors, to give actionable
 * messages (and so we can apply caps that Zod can't easily express).
 */
export const RoutingRuleWhenValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const RoutingRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z][a-z0-9_-]*$/, {
        message: 'rule id must be lowercase, start with a letter, and contain only [a-z0-9_-]',
      }),
    when: z.record(RoutingRuleWhenValueSchema),
    then: RoutingRuleThenSchema,
  })
  .strict();
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

export const RoutingPolicySchema = z
  .object({
    tiers: z
      .array(TierNameSchema)
      .min(TIER_MIN_LENGTH)
      .max(TIER_MAX_LENGTH)
      .default([...DEFAULT_TIERS])
      .refine((tiers) => new Set(tiers).size === tiers.length, {
        message: 'routing.tiers must be unique',
      }),
    rules: z.array(RoutingRuleSchema).max(ROUTING_RULES_MAX).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const tierSet = new Set(policy.tiers);
    const ruleIds = new Set<string>();
    for (let i = 0; i < policy.rules.length; i += 1) {
      const rule = policy.rules[i];
      if (!rule) continue;
      if (ruleIds.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', i, 'id'],
          message: `duplicate routing rule id "${rule.id}"`,
        });
      }
      ruleIds.add(rule.id);
      if (!tierSet.has(rule.then.tier)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', i, 'then', 'tier'],
          message: `rule then.tier "${rule.then.tier}" is not in routing.tiers`,
        });
      }
      const fanout = rule.then.fanout ?? [];
      for (let j = 0; j < fanout.length; j += 1) {
        const entry = fanout[j];
        if (!entry) continue;
        if (!tierSet.has(entry.tier)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rules', i, 'then', 'fanout', j, 'tier'],
            message: `rule then.fanout[${j}].tier "${entry.tier}" is not in routing.tiers`,
          });
        }
      }
      const whenIssues = validateRoutingRuleWhen(rule.when);
      for (const issue of whenIssues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', i, 'when', ...issue.path],
          message: issue.message,
        });
      }
    }
  });
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

interface RoutingWhenIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * Strip an operator suffix (`_lt`, `_lte`, `_gt`, `_gte`, `_eq`) from a
 * `when` key, returning the bare signal name and the resolved operator. A
 * key with no recognized suffix is treated as `_eq`.
 */
export function parseRoutingRuleWhenKey(
  key: string,
): { signal: string; operator: RoutingRuleOperatorSuffix } | { error: string } {
  for (const suffix of ROUTING_RULE_OPERATOR_SUFFIXES) {
    if (suffix === '_eq') continue;
    if (key.endsWith(suffix)) {
      const signal = key.slice(0, -suffix.length);
      if (signal.length === 0) {
        return { error: `when key "${key}" has operator suffix but no signal name` };
      }
      return { signal, operator: suffix };
    }
  }
  // Reject explicit `_eq` suffixes for now — bare key form is canonical, and
  // accepting both would create two ways to spell the same predicate.
  if (key.endsWith('_eq')) {
    return { error: `when key "${key}" — use bare key for equality (drop "_eq")` };
  }
  return { signal: key, operator: '_eq' };
}

function validateRoutingRuleWhen(
  when: Record<string, string | number | boolean>,
): readonly RoutingWhenIssue[] {
  const issues: RoutingWhenIssue[] = [];
  if (Object.keys(when).length === 0) {
    issues.push({ path: [], message: 'when must have at least one key' });
  }
  for (const key of Object.keys(when)) {
    const parsed = parseRoutingRuleWhenKey(key);
    if ('error' in parsed) {
      issues.push({ path: [key], message: parsed.error });
      continue;
    }
    if (!ROUTING_RULE_WHEN_KEYS.includes(parsed.signal as RoutingRuleWhenKey)) {
      issues.push({
        path: [key],
        message: `unknown when signal "${parsed.signal}" — allowed: ${ROUTING_RULE_WHEN_KEYS.join(', ')}`,
      });
    }
  }
  return issues;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  tiers: [...DEFAULT_TIERS],
  rules: [],
};

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    requires: z.string().min(1).optional(),
    paths: PathsSchema,
    policies: PoliciesSchema.default({}),
    git: GitPolicySchema.default({}),
    generated: GeneratedSchema.default({}),
    chaining: ChainingSchema.default({}),
    worktrees: WorktreesSchema.default({}),
    automation: AutomationSchema.default({}),
    parallel: ParallelConfigSchema.default({}),
    agents: AgentsSchema.default({}),
    routing: RoutingPolicySchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

/**
 * Map of removed config keys to migration guidance. The path is dotted from
 * the top of the config object. When loadConfig() encounters a path here, it
 * emits a P3 DEPRECATED_FIELD finding and strips the key before Zod validation.
 *
 * Add new entries here as fields are removed across versions. Truly-unknown
 * keys (no path match) still surface as P0 CONFIG_INVALID via .strict().
 */
export const KNOWN_DEPRECATED_FIELDS: ReadonlyArray<{
  readonly path: readonly string[];
  readonly reason: string;
  readonly replacement?: string;
}> = [
  {
    path: ['policies', 'blockUnassignedDirtyFiles'],
    reason: 'replaced by sprint allowed_paths/denied_paths frontmatter',
  },
  {
    path: ['policies', 'protectedPaths'],
    reason: 'replaced by sprint denied_paths frontmatter',
  },
  {
    path: ['blockUnassignedDirtyFiles'],
    reason: 'replaced by sprint allowed_paths/denied_paths frontmatter',
  },
  {
    path: ['protectedPaths'],
    reason: 'replaced by sprint denied_paths frontmatter',
  },
];
