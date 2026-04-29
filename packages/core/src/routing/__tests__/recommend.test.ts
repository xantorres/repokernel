// biome-ignore-all lint/suspicious/noThenProperty: routing rule fixtures use `then` as a config field name.
import { describe, expect, it } from 'vitest';
import { type RoutingPolicy, RoutingPolicySchema } from '../../config/schema.js';
import type { RoutingExtra } from '../../schemas/routing.js';
import { type RouteInput, recommend } from '../recommend.js';

function policy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return RoutingPolicySchema.parse({
    tiers: overrides.tiers ?? ['light', 'standard', 'heavy'],
    rules: overrides.rules ?? [],
  });
}

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    profile: 'implement',
    estimated_tokens: 3000,
    allowed_paths_count: 3,
    depends_on_count: 0,
    ac_count: 2,
    review_required: true,
    extras_routing: {} as RoutingExtra,
    policy: policy(),
    ...overrides,
  };
}

describe('recommend — pinned tier', () => {
  it('honors valid pin_tier as hard override', () => {
    const result = recommend(
      input({
        extras_routing: { pin_tier: 'heavy' },
      }),
    );
    expect(result.hint.tier).toBe('heavy');
    expect(result.hint.reason).toBe('pinned');
    expect(result.findings).toHaveLength(0);
  });

  it('emits P1 finding and falls back when pin_tier is unknown', () => {
    const result = recommend(
      input({
        extras_routing: { pin_tier: 'unknown_tier' },
      }),
    );
    expect(result.hint.reason).toBe('scored');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('P1');
  });

  it('pin_tier wins over a matching policy rule', () => {
    const p = policy({
      rules: [
        {
          id: 'small',
          when: { est_tokens_lt: 5000 },
          then: { tier: 'light' },
        },
      ],
    });
    const result = recommend(
      input({
        policy: p,
        estimated_tokens: 1000,
        extras_routing: { pin_tier: 'heavy' },
      }),
    );
    expect(result.hint.tier).toBe('heavy');
    expect(result.hint.reason).toBe('pinned');
  });
});

describe('recommend — config rules', () => {
  it('returns matching rule with rule_id', () => {
    const p = policy({
      rules: [
        {
          id: 'small-and-uncritical',
          when: { est_tokens_lt: 3000, ac_count_lte: 3, review_required: false },
          then: { tier: 'light' },
        },
      ],
    });
    const result = recommend(
      input({
        policy: p,
        estimated_tokens: 1500,
        ac_count: 2,
        review_required: false,
      }),
    );
    expect(result.hint.tier).toBe('light');
    expect(result.hint.reason).toBe('rule');
    expect(result.hint.rule_id).toBe('small-and-uncritical');
  });

  it('first matching rule wins', () => {
    const p = policy({
      rules: [
        { id: 'a', when: { profile: 'implement' }, then: { tier: 'standard' } },
        { id: 'b', when: { profile: 'implement' }, then: { tier: 'heavy' } },
      ],
    });
    const result = recommend(input({ policy: p }));
    expect(result.hint.rule_id).toBe('a');
    expect(result.hint.tier).toBe('standard');
  });

  it('attaches fanout from rule to hint', () => {
    const p = policy({
      rules: [
        {
          id: 'review-panel',
          when: { profile: 'review', ac_count_gte: 5 },
          then: {
            tier: 'standard',
            fanout: [
              { id: 'fast', tier: 'light' },
              { id: 'deep', tier: 'standard' },
            ],
          },
        },
      ],
    });
    const result = recommend(
      input({
        profile: 'review',
        policy: p,
        ac_count: 7,
      }),
    );
    expect(result.hint.fanout).toEqual([
      { id: 'fast', tier: 'light' },
      { id: 'deep', tier: 'standard' },
    ]);
  });

  it('skips rule with non-matching scalar value', () => {
    const p = policy({
      rules: [{ id: 'review-only', when: { profile: 'review' }, then: { tier: 'light' } }],
    });
    const result = recommend(input({ profile: 'implement', policy: p }));
    expect(result.hint.reason).toBe('scored');
  });

  it('matches numeric operators (_lt, _lte, _gt, _gte)', () => {
    const p = policy({
      rules: [
        {
          id: 'big',
          when: { est_tokens_gte: 6000, allowed_paths_count_gt: 5 },
          then: { tier: 'heavy' },
        },
      ],
    });
    const result = recommend(
      input({
        policy: p,
        estimated_tokens: 7000,
        allowed_paths_count: 6,
      }),
    );
    expect(result.hint.tier).toBe('heavy');
    expect(result.hint.rule_id).toBe('big');
  });

  it('matches gate and lane signals', () => {
    const p = policy({
      rules: [{ id: 'infra-lane', when: { lane: 'infra' }, then: { tier: 'standard' } }],
    });
    const result = recommend(
      input({
        policy: p,
        lane: 'infra',
      }),
    );
    expect(result.hint.rule_id).toBe('infra-lane');
  });

  it('rule with extras_complexity matches when extras_routing has complexity', () => {
    const p = policy({
      rules: [
        {
          id: 'deep',
          when: { extras_complexity: 'deep' },
          then: { tier: 'heavy' },
        },
      ],
    });
    const result = recommend(
      input({
        policy: p,
        extras_routing: { complexity: 'deep' },
      }),
    );
    expect(result.hint.rule_id).toBe('deep');
    expect(result.hint.tier).toBe('heavy');
  });
});

describe('recommend — prefer_tier hint', () => {
  it('honors valid prefer_tier when no rule matches', () => {
    const result = recommend(
      input({
        extras_routing: { prefer_tier: 'heavy' },
      }),
    );
    expect(result.hint.tier).toBe('heavy');
    expect(result.hint.reason).toBe('hinted');
  });

  it('emits P1 finding for unknown prefer_tier and falls back', () => {
    const result = recommend(
      input({
        extras_routing: { prefer_tier: 'gigantic' },
      }),
    );
    expect(result.hint.reason).toBe('scored');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('P1');
  });
});

describe('recommend — complexity ordinal mapping', () => {
  it('trivial maps to tiers[0]', () => {
    const result = recommend(input({ extras_routing: { complexity: 'trivial' } }));
    expect(result.hint.tier).toBe('light');
    expect(result.hint.reason).toBe('hinted');
  });

  it('standard maps to middle tier', () => {
    const result = recommend(input({ extras_routing: { complexity: 'standard' } }));
    expect(result.hint.tier).toBe('standard');
  });

  it('deep maps to last tier', () => {
    const result = recommend(input({ extras_routing: { complexity: 'deep' } }));
    expect(result.hint.tier).toBe('heavy');
  });

  it('works with custom tier names (vendor-agnostic)', () => {
    const p = policy({ tiers: ['cheap', 'mid', 'expensive'] });
    const result = recommend(
      input({
        policy: p,
        extras_routing: { complexity: 'deep' },
      }),
    );
    expect(result.hint.tier).toBe('expensive');
    expect(result.hint.tier_set).toEqual(['cheap', 'mid', 'expensive']);
  });
});

describe('recommend — score-based fallback (3 tiers)', () => {
  it('low score on review profile → tiers[0]', () => {
    const result = recommend(
      input({
        profile: 'review',
        estimated_tokens: 1000,
        allowed_paths_count: 1,
        depends_on_count: 0,
      }),
    );
    expect(result.hint.tier).toBe('light');
    expect(result.hint.reason).toBe('scored');
    expect(result.hint.score).toBeLessThanOrEqual(0);
  });

  it('mid score on implement → middle tier', () => {
    const result = recommend(
      input({
        profile: 'implement',
        estimated_tokens: 3000,
        allowed_paths_count: 3,
        depends_on_count: 1,
      }),
    );
    expect(result.hint.tier).toBe('standard');
  });

  it('high score on wave with large allowed_paths → heavy', () => {
    const result = recommend(
      input({
        profile: 'wave',
        estimated_tokens: 7000,
        allowed_paths_count: 10,
        depends_on_count: 3,
      }),
    );
    expect(result.hint.tier).toBe('heavy');
    expect(result.hint.score).toBeGreaterThanOrEqual(3);
  });
});

describe('recommend — score-based fallback (2 tiers)', () => {
  it('score <= 0 → tiers[0]', () => {
    const p = policy({ tiers: ['cheap', 'expensive'] });
    const result = recommend(
      input({
        policy: p,
        profile: 'review',
        estimated_tokens: 1000,
      }),
    );
    expect(result.hint.tier).toBe('cheap');
  });

  it('score > 0 → tiers[1]', () => {
    const p = policy({ tiers: ['cheap', 'expensive'] });
    const result = recommend(
      input({
        policy: p,
        profile: 'wave',
        estimated_tokens: 7000,
      }),
    );
    expect(result.hint.tier).toBe('expensive');
  });
});

describe('recommend — fanout from extras', () => {
  it('attaches fanout from extras when no rule fires', () => {
    const result = recommend(
      input({
        extras_routing: {
          fanout: [
            { id: 'a', tier: 'light' },
            { id: 'b', tier: 'standard' },
          ],
        },
      }),
    );
    expect(result.hint.fanout).toEqual([
      { id: 'a', tier: 'light' },
      { id: 'b', tier: 'standard' },
    ]);
  });

  it('drops fanout entries with unknown tier names', () => {
    const result = recommend(
      input({
        extras_routing: {
          fanout: [
            { id: 'a', tier: 'light' },
            { id: 'b', tier: 'phantom' },
          ],
        },
      }),
    );
    expect(result.hint.fanout).toEqual([{ id: 'a', tier: 'light' }]);
  });

  it('omits fanout field entirely when extras has no fanout', () => {
    const result = recommend(input());
    expect(result.hint.fanout).toBeUndefined();
  });
});

describe('recommend — output shape invariants', () => {
  it('always includes tier_set in hint', () => {
    const result = recommend(input());
    expect(result.hint.tier_set).toEqual(['light', 'standard', 'heavy']);
  });

  it('always includes signals snapshot', () => {
    const result = recommend(
      input({
        profile: 'review',
        estimated_tokens: 1234,
        allowed_paths_count: 5,
        depends_on_count: 1,
        ac_count: 3,
        review_required: true,
      }),
    );
    expect(result.hint.signals).toEqual({
      profile: 'review',
      estimated_tokens: 1234,
      allowed_paths_count: 5,
      depends_on_count: 1,
      ac_count: 3,
      review_required: true,
    });
  });

  it('exposes score on every result', () => {
    const result = recommend(input());
    expect(typeof result.hint.score).toBe('number');
    expect(Number.isInteger(result.hint.score)).toBe(true);
  });
});
