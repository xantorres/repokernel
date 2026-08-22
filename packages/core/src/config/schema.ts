// biome-ignore-all lint/suspicious/noThenProperty: routing rules use a when/then matcher; `then` is a config field, not a Promise then().
import { z } from 'zod';
import { RepoKernelError } from '../errors/RepoKernelError.js';
import { SeveritySchema } from '../schemas/finding.js';
import { SprintIdSchema } from '../schemas/ids.js';
import { LaneNameSchema, RepoRelativeGlobSchema, RepoRelativePathSchema } from '../schemas/path.js';
import {
  DEFAULT_TIERS,
  TIER_MAX_LENGTH,
  TIER_MIN_LENGTH,
  TierNameSchema,
} from '../schemas/routing.js';
import { SPRINT_STATUSES } from '../schemas/sprint.js';

export const CONFIG_SCHEMA_VERSION = 1;

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
    defaultLane: LaneNameSchema.default('main'),
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

/**
 * Project-level path-scope escape hatches, merged into every sprint's effective
 * policy at gate time. For cross-cutting files that nearly every sprint touches
 * in a monorepo — chiefly the root lockfile — so a normal artifact stops reading
 * as an out-of-scope violation without polluting each sprint's `allowed_paths`.
 *
 * - `alwaysGenerated`: treated as generated output for every sprint (e.g.
 *   `pnpm-lock.yaml`). RepoKernel control paths are still filtered out.
 * - `alwaysAllowed`: in scope for every sprint that declares `allowed_paths`.
 */
export const PathPolicySchema = z
  .object({
    alwaysAllowed: z.array(RepoRelativeGlobSchema).default([]),
    alwaysGenerated: z.array(RepoRelativeGlobSchema).default([]),
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

export interface BranchPatternContext {
  readonly branchPrefix: string;
  readonly epicId: string;
  readonly sprintId?: string;
}

interface WorktreePatternConfig {
  readonly branchPrefix: string;
  readonly branchPattern?: string | undefined;
  readonly epicBranchPattern?: string | undefined;
  readonly sprintBranchPattern?: string | undefined;
}

const FUTURE_BRANCH_PATTERN_TOKENS = new Set(['ticket', 'slug']);
const CURRENT_BRANCH_PATTERN_TOKENS = new Set(['branchPrefix', 'epicId', 'sprintId']);
const TOKEN_RE = /\{([a-zA-Z]+)\}/g;

function branchPatternTokens(pattern: string): readonly string[] {
  return [...pattern.matchAll(TOKEN_RE)].map((m) => m[1] ?? '');
}

function hasToken(pattern: string, token: string): boolean {
  return branchPatternTokens(pattern).includes(token);
}

function hasOnlyCurrentTokens(pattern: string): boolean {
  return branchPatternTokens(pattern).every((token) => CURRENT_BRANCH_PATTERN_TOKENS.has(token));
}

export function epicBranchPatternFor(worktrees: WorktreePatternConfig): string {
  if (worktrees.epicBranchPattern !== undefined) return worktrees.epicBranchPattern;
  if (worktrees.branchPattern !== undefined && !hasToken(worktrees.branchPattern, 'sprintId')) {
    return worktrees.branchPattern;
  }
  return '{branchPrefix}epic/{epicId}';
}

export function sprintBranchPatternFor(worktrees: WorktreePatternConfig): string {
  if (worktrees.sprintBranchPattern !== undefined) return worktrees.sprintBranchPattern;
  if (worktrees.branchPattern !== undefined && hasToken(worktrees.branchPattern, 'sprintId')) {
    return worktrees.branchPattern;
  }
  return '{branchPrefix}sprint/{epicId}/{sprintId}';
}

export function renderBranchPattern(pattern: string, ctx: BranchPatternContext): string {
  return pattern.replace(TOKEN_RE, (_match, token: string) => {
    if (FUTURE_BRANCH_PATTERN_TOKENS.has(token)) {
      throw new RepoKernelError(
        'CONFIG_INVALID',
        `worktrees branch pattern token \`{${token}}\` is reserved for v1.14 and not yet supported — current tokens: {branchPrefix}, {epicId}, {sprintId}`,
      );
    }
    if (token === 'branchPrefix') return ctx.branchPrefix;
    if (token === 'epicId') return ctx.epicId;
    if (token === 'sprintId') {
      if (ctx.sprintId === undefined) {
        throw new RepoKernelError(
          'CONFIG_INVALID',
          'worktrees epic branch pattern cannot use `{sprintId}` — set `sprintBranchPattern` for sprint worktrees',
        );
      }
      return ctx.sprintId;
    }
    throw new RepoKernelError(
      'CONFIG_INVALID',
      `worktrees branch pattern contains unknown token \`{${token}}\` — supported tokens: {branchPrefix}, {epicId}, {sprintId}`,
    );
  });
}

export function isValidGitBranchRef(value: string): boolean {
  if (value.length === 0) return false;
  if (value === '@') return false;
  if (value.startsWith('-')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value.endsWith('.') || value.includes('..') || value.includes('//')) return false;
  if (value.includes('@{') || value.includes('\\')) return false;
  if (/[~^:?*[\]]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return false;
  }
  for (const part of value.split('/')) {
    if (part.length === 0) return false;
    if (part === '.' || part === '..') return false;
    if (part.startsWith('.')) return false;
    if (part.endsWith('.lock')) return false;
  }
  return true;
}

function refsConflict(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

const ID_TOKEN_RE = /\{(?:epicId|sprintId)\}/;

/**
 * The branch namespace a worktree pattern generates into: everything up to its
 * first id token, with `{branchPrefix}` substituted.
 *
 * `isPrefix` is false when the pattern carries no id token at all — it then
 * names a single fixed branch rather than a namespace, so containment has to be
 * tested as a ref conflict instead of a string prefix.
 *
 * Cutting at the first id token rather than matching rendered ids keeps the
 * test on the namespace RepoKernel claims, so a hand-made `rk/epic/legacy` is
 * caught alongside `rk/epic/E-001` while a base that merely shares the
 * configured `branchPrefix` (`release/current` under prefix `release/`) is not.
 */
function generatedBranchNamespace(
  pattern: string,
  branchPrefix: string,
): { readonly value: string; readonly isPrefix: boolean } {
  const idToken = ID_TOKEN_RE.exec(pattern);
  const head = idToken === null ? pattern : pattern.slice(0, idToken.index);
  return {
    value: head.replace(/\{branchPrefix\}/g, branchPrefix),
    isPrefix: idToken !== null,
  };
}

/**
 * Validate a `worktrees.branchPattern` template string.
 *
 * The pattern is rendered into a git branch ref by substituting the
 * supported tokens (`{branchPrefix}`, `{epicId}`, `{sprintId}`). All
 * substituted values are controlled by RepoKernel and known-safe
 * (`rk/`, `E-001`, `S-001`), so ref-format safety is fully determined
 * by the pattern itself. Rejecting unsafe characters here means the
 * runtime branch helpers can stay sync and never need to shell out to
 * `git check-ref-format`.
 *
 * Rules mirror `git check-ref-format` for branch names:
 * - no whitespace, NUL, or ASCII control chars
 * - no `..`, `@{`, `\\`, `//`
 * - no leading `/`, no trailing `/`, no trailing `.`, no trailing `.lock`
 * - no `^`, `~`, `:`, `?`, `*`, `[` outside of literal substitution tokens
 *
 * The `{...}` token braces themselves are allowed; they're consumed at
 * render time. We forbid `?`, `*`, `[` in the rest of the string only.
 */
function isValidBranchPattern(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value.endsWith('.') || value.endsWith('.lock')) return false;
  if (value.includes('..') || value.includes('//') || value.includes('\\')) return false;
  if (value.includes('@{')) return false;
  // Strip token literals before scanning for forbidden chars so `{`/`}` and
  // identifier chars inside tokens don't trip checks.
  const stripped = value.replace(/\{[a-zA-Z]+\}/g, '');
  if (/\s/.test(stripped)) return false;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    if (code <= 31 || code === 127) return false;
  }
  if (/[~^:?*[\]\\]/.test(stripped)) return false;
  // Reject any leftover unmatched braces — every `{` must have closed via the
  // strip above. A surviving `{` or `}` means malformed token syntax.
  if (stripped.includes('{') || stripped.includes('}')) return false;
  return true;
}

function PatternSchema(label: string) {
  return z
    .string()
    .min(1)
    .refine(isValidBranchPattern, {
      message: `${label} is not a valid git ref pattern — must not contain whitespace, control chars, \`..\`, \`@{\`, \`\\\`, \`//\`, \`~\`, \`^\`, \`:\`, \`?\`, \`*\`, \`[\`, \`]\`, leading \`/\`, trailing \`/\` or \`.\`, or trailing \`.lock\``,
    })
    .optional();
}

export const WorktreesSchema = z
  .object({
    root: z.string().min(1).default('../.repokernel-worktrees'),
    branchPrefix: z.string().min(1).default('rk/'),
    baseBranch: z.string().min(1).default('main'),
    autoAcquire: z.boolean().default(true),
    /**
     * Compatibility shorthand for branch-name templates.
     *
     * If it omits `{sprintId}`, it applies to epic branches and sprint
     * branches keep the default. If it includes `{sprintId}`, it applies to
     * sprint branches and epic branches keep the default. Prefer explicit
     * `epicBranchPattern` + `sprintBranchPattern` for new custom naming.
     */
    branchPattern: PatternSchema('branchPattern'),
    /**
     * Explicit epic worktree branch pattern. Cannot use `{sprintId}`.
     * Prefer this with `sprintBranchPattern` for team-specific naming.
     */
    epicBranchPattern: PatternSchema('epicBranchPattern'),
    /**
     * Explicit sprint worktree branch pattern. Must include `{sprintId}`.
     */
    sprintBranchPattern: PatternSchema('sprintBranchPattern'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const branchPrefixProbe = `${value.branchPrefix}probe`;
    if (!isValidGitBranchRef(branchPrefixProbe)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['branchPrefix'],
        message: `branchPrefix renders invalid git branch prefix \`${value.branchPrefix}\``,
      });
    }

    if (!isValidGitBranchRef(value.baseBranch)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseBranch'],
        message: `baseBranch \`${value.baseBranch}\` is not a valid git branch name`,
      });
    }

    const epicPattern = epicBranchPatternFor(value);
    const sprintPattern = sprintBranchPatternFor(value);
    if (hasToken(epicPattern, 'sprintId')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['epicBranchPattern'],
        message: 'epicBranchPattern cannot contain `{sprintId}`',
      });
    }
    if (!hasToken(sprintPattern, 'sprintId')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sprintBranchPattern'],
        message: 'sprintBranchPattern must contain `{sprintId}`',
      });
    }

    if (!hasOnlyCurrentTokens(epicPattern) || !hasOnlyCurrentTokens(sprintPattern)) return;

    // A base inside the worktree branch namespace makes every worktree branch
    // merged into it look merged into trunk, so cleanup deletes work that never
    // reached the real base.
    for (const [pattern, label] of [
      [epicPattern, 'epic'],
      [sprintPattern, 'sprint'],
    ] as const) {
      const namespace = generatedBranchNamespace(pattern, value.branchPrefix);
      const collides = namespace.isPrefix
        ? value.baseBranch.startsWith(namespace.value)
        : refsConflict(value.baseBranch, namespace.value);
      if (collides) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseBranch'],
          message: `baseBranch \`${value.baseBranch}\` sits inside the ${label} worktree branch namespace \`${namespace.value}\` — RepoKernel creates and deletes branches there, so the base must live outside it`,
        });
        break;
      }
    }

    const sampleCtx = { branchPrefix: value.branchPrefix, epicId: 'E-001', sprintId: 'S-001' };
    const epicRef = renderBranchPattern(epicPattern, sampleCtx);
    const sprintRef = renderBranchPattern(sprintPattern, sampleCtx);
    if (!isValidGitBranchRef(epicRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.epicBranchPattern !== undefined ? ['epicBranchPattern'] : ['branchPattern'],
        message: `epic branch pattern renders invalid git branch \`${epicRef}\``,
      });
    }
    if (!isValidGitBranchRef(sprintRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.sprintBranchPattern !== undefined ? ['sprintBranchPattern'] : ['branchPattern'],
        message: `sprint branch pattern renders invalid git branch \`${sprintRef}\``,
      });
    }
    if (
      isValidGitBranchRef(epicRef) &&
      isValidGitBranchRef(sprintRef) &&
      refsConflict(epicRef, sprintRef)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.sprintBranchPattern !== undefined ? ['sprintBranchPattern'] : ['branchPattern'],
        message: `epic and sprint branch patterns conflict as git refs (\`${epicRef}\` vs \`${sprintRef}\`)`,
      });
    }
  });

export type Worktrees = z.infer<typeof WorktreesSchema>;

/**
 * `rk start` worktree-acquisition policy.
 *
 * - `never`  — `rk start` only mutates sprint metadata (legacy behavior).
 * - `always` — `rk start` acquires an isolated sprint worktree, unless the
 *              caller is already inside a worktree.
 * - `auto`   — acquire only when RepoKernel owns the execution environment:
 *              not already inside a worktree, and not under an external
 *              agent/editor (Cursor, Claude Code, Codex, VS Code).
 *
 * Governs `rk start` only. `worktrees.*` still supplies acquisition mechanics
 * and `worktrees.autoAcquire` still governs `rk run`.
 */
export const StartSchema = z
  .object({
    worktree: z.enum(['auto', 'always', 'never']).default('auto'),
  })
  .strict();

export type Start = z.infer<typeof StartSchema>;

/**
 * Phased checks shape — alternative to the flat `checksCmd`. Operators that
 * want explicit per-phase visibility (lint vs typecheck vs build vs test) can
 * supply each one separately; gates evidence then records pass/fail per
 * phase, which is far more actionable than a single rolled-up exit code.
 * `checksCmd` and `checksPhases` are mutually exclusive at config-load time.
 */
export const ChecksPhasesSchema = z
  .object({
    check: z.string().min(1).optional(),
    typecheck: z.string().min(1).optional(),
    build: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.check !== undefined ||
      value.typecheck !== undefined ||
      value.build !== undefined ||
      value.test !== undefined,
    'checksPhases must define at least one of check, typecheck, build, test',
  );
export type ChecksPhases = z.infer<typeof ChecksPhasesSchema>;

const REVIEWER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Per-reviewer gate policy for `automation.reviewers.<name>`. Carries only
 * non-privileged knobs — the executable `command`/`args`/`env`/`timeout` come
 * from the user-local trust grant (`resolveTrustedReviewer`), never from repo
 * config, so a cloned repo cannot make `rk review` run an arbitrary command.
 */
export const ReviewerGateConfigSchema = z
  .object({
    /** Model id passed to the reviewer as `--model <id>`. Constrained to a safe argv token. */
    model: z
      .string()
      .min(1)
      .regex(REVIEWER_MODEL_RE, 'model must match [A-Za-z0-9][A-Za-z0-9._-]*')
      .optional(),
    /**
     * Path to a custom verdict JSON schema. `null` (default) uses rk's built-in
     * reviewer-gate verdict schema. Custom schema loading is not yet wired — a
     * non-null value is rejected at gate time with a clear error.
     */
    schemaPath: z.string().min(1).nullable().default(null),
    /**
     * Codex auth mode. `chatgpt` validates `CODEX_HOME/auth.json` and never
     * passes an OpenAI API key to the reviewer; `apikey` requires
     * `OPENAI_API_KEY` to be both granted and present.
     */
    authMode: z.enum(['chatgpt', 'apikey']).default('chatgpt'),
    /** Optional project-specific rubric text appended to the built-in review rubric. */
    rubricExtras: z.string().min(1).nullable().default(null),
  })
  .strict();

export type ReviewerGateConfig = z.infer<typeof ReviewerGateConfigSchema>;

export const AutomationSchema = z
  .object({
    allowAutonomousClose: z.boolean().default(false),
    defaultMode: z.enum(['assisted', 'autonomous']).default('assisted'),
    defaultAgent: z.string().min(1).default('manual'),
    defaultReviewer: z.string().min(1).default('agent'),
    /**
     * Optional explicit identity for the reviewer field stamped onto review
     * stubs created by `rk review-create` / `rk start`. Falls back to
     * `defaultReviewer` when unset, but takes precedence so a project that
     * runs `codex` as its reviewer can stop the `agent` placeholder from
     * leaking into every fresh review. Production feedback item #12.
     */
    reviewer: z.string().min(1).optional(),
    /**
     * Absolute path or PATH-resolvable name of the `rk` binary this project
     * expects to run against. `rk doctor` resolves the running binary via
     * `which` (or `where` on Windows) and surfaces a mismatch as
     * `RK_BINARY_MISMATCH`. Useful when multiple rk installations coexist
     * (`pnpm link --global` overlapping with `npm i -g`). Production
     * feedback item #16.
     */
    binary: z.string().min(1).optional(),
    checksCmd: z.string().optional(),
    /**
     * Phased alternative to `checksCmd`. Mutually exclusive — set one or
     * the other, not both. Production feedback item #17.
     */
    checksPhases: ChecksPhasesSchema.optional(),
    /**
     * Wall-clock timeout (seconds) for the configured `checksCmd` invocation.
     * On expiry the process is sent SIGTERM, then SIGKILL after a short
     * grace period. Default 1800s (30 min) — long enough for full test
     * suites, short enough that a wedged check cannot stall the close
     * pipeline indefinitely.
     */
    checksTimeoutSeconds: z.number().int().positive().default(1800),
    /**
     * Project-level reviewer gates, keyed by reviewer name. When
     * `effectiveReviewer(automation)` names a key here, `rk review` /
     * `rk review-create` invoke that gate. Empty/absent ⇒ no gate runs.
     */
    reviewers: z.record(z.string().min(1), ReviewerGateConfigSchema).optional(),
  })
  .strict()
  .refine(
    (value) => !(value.checksCmd !== undefined && value.checksPhases !== undefined),
    'automation.checksCmd and automation.checksPhases are mutually exclusive — pick one',
  );

export type Automation = z.infer<typeof AutomationSchema>;

export const ReviewAutoSchema = z
  .object({
    when: z.enum(['gates_green', 'never']).default('never'),
  })
  .strict();

export const ReviewPolicySchema = z
  .object({
    auto: ReviewAutoSchema.default({}),
  })
  .strict();

export type ReviewPolicy = z.infer<typeof ReviewPolicySchema>;

/**
 * Resolve the effective reviewer identity for review-stub creation.
 * `automation.reviewer` (explicit override) takes precedence over
 * `automation.defaultReviewer` (general default), so a project that runs
 * `codex` as its reviewer can stop the `agent` placeholder from leaking
 * into every fresh review. Pure function — no side effects.
 */
export function effectiveReviewer(automation: Automation): string {
  return automation.reviewer ?? automation.defaultReviewer;
}

/**
 * Resolve the project-level reviewer gate, if one is configured. Returns the
 * gate whose name equals `effectiveReviewer(automation)` and that has a
 * matching `automation.reviewers.<name>` entry; otherwise null (no gate runs).
 * Pure function.
 */
export function resolveReviewerGate(
  automation: Automation,
): { readonly name: string; readonly config: ReviewerGateConfig } | null {
  const name = effectiveReviewer(automation);
  const config = automation.reviewers?.[name];
  return config ? { name, config } : null;
}

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
    /**
     * Per-state concurrency caps. Bottleneck mitigation for workloads where
     * different sprint states have different cost profiles — review-state
     * sprints are typically expensive (panel + reviewer LLMs) while
     * planned/pending are cheap. The cap applied to a sprint is the
     * minimum of `maxConcurrentSprints` and the per-state value, if any.
     *
     * Empty / undefined keeps the legacy single-cap behaviour.
     */
    maxConcurrentSprintsByState: z
      .record(z.enum(SPRINT_STATUSES), z.number().int().positive())
      .default({}),
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
    pathPolicy: PathPolicySchema.default({}),
    chaining: ChainingSchema.default({}),
    worktrees: WorktreesSchema.default({}),
    start: StartSchema.default({}),
    automation: AutomationSchema.default({}),
    review: ReviewPolicySchema.default({}),
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
  {
    path: ['parallel', 'stallThresholdMs'],
    reason: 'stall detection was never wired into the parallel runner; key has no effect',
  },
  {
    path: ['parallel', 'stallPollIntervalMs'],
    reason: 'stall detection was never wired into the parallel runner; key has no effect',
  },
];
