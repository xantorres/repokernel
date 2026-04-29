import { z } from 'zod';

/**
 * Cost-aware agent routing primitives. Vendor-agnostic by design — no model
 * IDs (Claude/GPT/etc.) appear here or anywhere downstream in core/cli. Tier
 * names are abstract strings owned by the consumer; the mapping from tier →
 * concrete model ID lives in the consumer's skill or config.
 *
 * See ADR/plan: cost-aware agent routing v1.8.
 */

export const DEFAULT_TIERS = ['light', 'standard', 'heavy'] as const;
export const TIER_MIN_LENGTH = 2;
export const TIER_MAX_LENGTH = 8;

/**
 * Structural validator only — does not enumerate values. Tier names are
 * cross-validated against the configured `routing.tiers` set at load time.
 */
export const TierNameSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_-]*$/, {
    message: 'tier names must be lowercase, start with a letter, and contain only [a-z0-9_-]',
  });

export type TierName = z.infer<typeof TierNameSchema>;

export const ComplexityHintSchema = z.enum(['trivial', 'standard', 'deep']);
export type ComplexityHint = z.infer<typeof ComplexityHintSchema>;

export const RoutingFanoutEntrySchema = z
  .object({
    id: z.string().min(1).max(60),
    tier: TierNameSchema,
  })
  .strict();
export type RoutingFanoutEntry = z.infer<typeof RoutingFanoutEntrySchema>;

/**
 * The opt-in shape stored under `extras.routing` on sprint/epic frontmatter.
 * Lives inside the existing `extras` jar so adoption requires no schema
 * migration. `.strict()` ensures typos surface as findings rather than
 * silently fall through.
 */
export const RoutingExtraSchema = z
  .object({
    complexity: ComplexityHintSchema.optional(),
    prefer_tier: TierNameSchema.optional(),
    pin_tier: TierNameSchema.optional(),
    fanout: z.array(RoutingFanoutEntrySchema).max(8).optional(),
  })
  .strict();
export type RoutingExtra = z.infer<typeof RoutingExtraSchema>;

/**
 * Reasons a tier was selected, in resolver-priority order.
 *   pinned  — extras.routing.pin_tier honored as hard override
 *   rule    — a config policy rule matched
 *   hinted  — extras.routing.prefer_tier or .complexity drove the choice
 *   scored  — derived from deterministic signal score
 *   default — fallback (no signals, missing config)
 */
export const RoutingReasonSchema = z.enum(['pinned', 'rule', 'hinted', 'scored', 'default']);
export type RoutingReason = z.infer<typeof RoutingReasonSchema>;

export const RoutingSignalsSchema = z
  .object({
    profile: z.enum(['implement', 'review', 'wave']),
    estimated_tokens: z.number().int().nonnegative(),
    allowed_paths_count: z.number().int().nonnegative(),
    depends_on_count: z.number().int().nonnegative(),
    ac_count: z.number().int().nonnegative(),
    review_required: z.boolean(),
  })
  .strict();
export type RoutingSignals = z.infer<typeof RoutingSignalsSchema>;

/**
 * Embedded in ContextPacket when --with-routing is passed. `tier_set` is
 * included so consumers seeing `tier: "mid"` can resolve their mapping
 * unambiguously without re-reading config. `score` is exposed so tier-drift
 * is auditable.
 *
 * Fanout dispatch contract (binding for skills): if `fanout` is present, it
 * IS the execution plan — spawn one agent per entry in parallel and ignore
 * the top-level `tier` for dispatch. The top-level `tier` is the summary
 * value for fanout-unaware consumers.
 */
export const RoutingHintSchema = z
  .object({
    tier: TierNameSchema,
    tier_set: z.array(TierNameSchema).min(TIER_MIN_LENGTH).max(TIER_MAX_LENGTH),
    reason: RoutingReasonSchema,
    rule_id: z.string().min(1).optional(),
    fanout: z.array(RoutingFanoutEntrySchema).max(8).optional(),
    signals: RoutingSignalsSchema,
    score: z.number().int(),
  })
  .strict();
export type RoutingHint = z.infer<typeof RoutingHintSchema>;

/**
 * Read `extras.routing` without throwing. Callers receive the parsed value
 * plus a list of issues describing parse problems for downstream finding
 * emission. Tier-name cross-validation against the configured `tiers` is
 * NOT done here — the caller (resolver) does it because the tier set is
 * config-scoped, not extras-scoped.
 */
export interface RoutingExtraIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface ReadRoutingExtraResult {
  readonly value: RoutingExtra;
  readonly issues: readonly RoutingExtraIssue[];
}

export function readRoutingExtra(
  extras: Record<string, unknown> | undefined | null,
): ReadRoutingExtraResult {
  const raw = extras?.routing;
  if (raw === undefined || raw === null) {
    return { value: {}, issues: [] };
  }
  const parsed = RoutingExtraSchema.safeParse(raw);
  if (parsed.success) {
    return { value: parsed.data, issues: [] };
  }
  const issues: RoutingExtraIssue[] = parsed.error.issues.map((issue) => ({
    path: ['routing', ...issue.path],
    message: issue.message,
  }));
  return { value: {}, issues };
}
