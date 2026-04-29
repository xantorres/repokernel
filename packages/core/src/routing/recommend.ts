import {
  parseRoutingRuleWhenKey,
  type RoutingPolicy,
  type RoutingRule,
  type RoutingRuleOperatorSuffix,
  type RoutingRuleWhenKey,
} from '../config/schema.js';
import type { Finding } from '../schemas/finding.js';
import type {
  ComplexityHint,
  RoutingExtra,
  RoutingFanoutEntry,
  RoutingHint,
  RoutingReason,
  RoutingSignals,
  TierName,
} from '../schemas/routing.js';

/**
 * Inputs to the deterministic tier recommender. Caller is responsible for
 * extracting these from the sprint/epic + context packet — the resolver
 * does not touch the filesystem.
 */
export interface RouteInput {
  readonly profile: 'implement' | 'review' | 'wave';
  readonly estimated_tokens: number;
  readonly allowed_paths_count: number;
  readonly depends_on_count: number;
  readonly ac_count: number;
  readonly review_required: boolean;
  readonly gate?: string;
  readonly lane?: string;
  readonly extras_routing: RoutingExtra;
  readonly policy: RoutingPolicy;
}

export interface RouteResult {
  readonly hint: RoutingHint;
  readonly findings: readonly Finding[];
}

/**
 * Single source of truth for scoring thresholds. Tunable in one place; never
 * inline these constants in `recommend()`.
 */
export const ROUTING_THRESHOLDS = {
  profileWeight: { wave: 2, implement: 1, review: 0 },
  allowedPathsHigh: 8,
  dependsOnHigh: 2,
  estTokensHigh: 6000,
  estTokensLow: 1500,
} as const;

export function recommend(input: RouteInput): RouteResult {
  const findings: Finding[] = [];
  const tiers = input.policy.tiers;
  const signals: RoutingSignals = {
    profile: input.profile,
    estimated_tokens: input.estimated_tokens,
    allowed_paths_count: input.allowed_paths_count,
    depends_on_count: input.depends_on_count,
    ac_count: input.ac_count,
    review_required: input.review_required,
  };

  const score = computeScore(signals);

  // 1. Hard pin from extras.routing.pin_tier — escape hatch.
  if (input.extras_routing.pin_tier !== undefined) {
    if (tiers.includes(input.extras_routing.pin_tier)) {
      return {
        hint: buildHint(
          input.extras_routing.pin_tier,
          tiers,
          'pinned',
          signals,
          score,
          input.extras_routing.fanout,
          undefined,
        ),
        findings,
      };
    }
    findings.push({
      severity: 'P1',
      code: 'CONFIG_INVALID',
      message: `routing extras.pin_tier "${input.extras_routing.pin_tier}" is not in routing.tiers (${tiers.join(', ')}); falling back to scoring`,
      entityType: 'config',
    });
  }

  // 2. Config policy rules — first match wins.
  const context: RuleContext = {
    ...(input.gate !== undefined ? { gate: input.gate } : {}),
    ...(input.lane !== undefined ? { lane: input.lane } : {}),
  };
  const ruleHit = matchRules(input.policy.rules, signals, input.extras_routing.complexity, context);
  if (ruleHit) {
    return {
      hint: buildHint(
        ruleHit.then.tier,
        tiers,
        'rule',
        signals,
        score,
        ruleHit.then.fanout,
        ruleHit.id,
      ),
      findings,
    };
  }

  // 3. Soft prefer hint from extras.
  if (input.extras_routing.prefer_tier !== undefined) {
    if (tiers.includes(input.extras_routing.prefer_tier)) {
      return {
        hint: buildHint(
          input.extras_routing.prefer_tier,
          tiers,
          'hinted',
          signals,
          score,
          input.extras_routing.fanout,
          undefined,
        ),
        findings,
      };
    }
    findings.push({
      severity: 'P1',
      code: 'CONFIG_INVALID',
      message: `routing extras.prefer_tier "${input.extras_routing.prefer_tier}" is not in routing.tiers (${tiers.join(', ')}); falling back to scoring`,
      entityType: 'config',
    });
  }

  // 4. Complexity hint — ordinal mapping into the tier list.
  if (input.extras_routing.complexity !== undefined) {
    const tier = complexityToTier(input.extras_routing.complexity, tiers);
    return {
      hint: buildHint(
        tier,
        tiers,
        'hinted',
        signals,
        score,
        input.extras_routing.fanout,
        undefined,
      ),
      findings,
    };
  }

  // 5. Score-based fallback. Length-aware so 2-tier and 4+-tier configs work.
  const tier = scoreToTier(score, tiers);
  return {
    hint: buildHint(tier, tiers, 'scored', signals, score, input.extras_routing.fanout, undefined),
    findings,
  };
}

function buildHint(
  tier: TierName,
  tiers: readonly TierName[],
  reason: RoutingReason,
  signals: RoutingSignals,
  score: number,
  fanout: readonly RoutingFanoutEntry[] | undefined,
  ruleId: string | undefined,
): RoutingHint {
  const validFanout =
    fanout && fanout.length > 0 ? fanout.filter((entry) => tiers.includes(entry.tier)) : undefined;
  const hint: RoutingHint = {
    tier,
    tier_set: [...tiers],
    reason,
    signals,
    score,
  };
  if (ruleId !== undefined) {
    return {
      ...hint,
      rule_id: ruleId,
      ...(validFanout && validFanout.length > 0 ? { fanout: [...validFanout] } : {}),
    };
  }
  if (validFanout && validFanout.length > 0) {
    return { ...hint, fanout: [...validFanout] };
  }
  return hint;
}

function computeScore(signals: RoutingSignals): number {
  let score = ROUTING_THRESHOLDS.profileWeight[signals.profile];
  if (signals.allowed_paths_count > ROUTING_THRESHOLDS.allowedPathsHigh) score += 1;
  if (signals.depends_on_count > ROUTING_THRESHOLDS.dependsOnHigh) score += 1;
  if (signals.estimated_tokens > ROUTING_THRESHOLDS.estTokensHigh) score += 1;
  else if (signals.estimated_tokens < ROUTING_THRESHOLDS.estTokensLow) score -= 1;
  return score;
}

function scoreToTier(score: number, tiers: readonly TierName[]): TierName {
  const n = tiers.length;
  if (n === 2) {
    return tiers[score <= 0 ? 0 : 1] as TierName;
  }
  let idx: number;
  if (score <= 0) idx = 0;
  else if (score <= 2) idx = Math.floor((n - 1) / 2);
  else idx = n - 1;
  return tiers[idx] as TierName;
}

function complexityToTier(complexity: ComplexityHint, tiers: readonly TierName[]): TierName {
  const n = tiers.length;
  switch (complexity) {
    case 'trivial':
      return tiers[0] as TierName;
    case 'standard':
      return tiers[Math.floor((n - 1) / 2)] as TierName;
    case 'deep':
      return tiers[n - 1] as TierName;
  }
}

interface RuleContext {
  readonly gate?: string;
  readonly lane?: string;
}

function matchRules(
  rules: readonly RoutingRule[],
  signals: RoutingSignals,
  complexity: ComplexityHint | undefined,
  context: RuleContext,
): RoutingRule | undefined {
  for (const rule of rules) {
    if (matchRule(rule, signals, complexity, context)) return rule;
  }
  return undefined;
}

function matchRule(
  rule: RoutingRule,
  signals: RoutingSignals,
  complexity: ComplexityHint | undefined,
  context: RuleContext,
): boolean {
  for (const [key, expected] of Object.entries(rule.when)) {
    const parsed = parseRoutingRuleWhenKey(key);
    if ('error' in parsed) return false;
    const actual = readSignal(parsed.signal as RoutingRuleWhenKey, signals, complexity, context);
    if (!compareSignal(actual, expected, parsed.operator)) return false;
  }
  return true;
}

function readSignal(
  key: RoutingRuleWhenKey,
  signals: RoutingSignals,
  complexity: ComplexityHint | undefined,
  context: RuleContext,
): string | number | boolean | undefined {
  switch (key) {
    case 'profile':
      return signals.profile;
    case 'est_tokens':
      return signals.estimated_tokens;
    case 'allowed_paths_count':
      return signals.allowed_paths_count;
    case 'depends_on_count':
      return signals.depends_on_count;
    case 'ac_count':
      return signals.ac_count;
    case 'review_required':
      return signals.review_required;
    case 'gate':
      return context.gate;
    case 'lane':
      return context.lane;
    case 'extras_complexity':
      return complexity;
  }
}

function compareSignal(
  actual: string | number | boolean | undefined,
  expected: string | number | boolean,
  operator: RoutingRuleOperatorSuffix,
): boolean {
  if (operator === '_eq') {
    if (actual === undefined) return false;
    return actual === expected;
  }
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  switch (operator) {
    case '_lt':
      return actual < expected;
    case '_lte':
      return actual <= expected;
    case '_gt':
      return actual > expected;
    case '_gte':
      return actual >= expected;
  }
}
