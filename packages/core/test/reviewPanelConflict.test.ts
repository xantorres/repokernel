import { describe, expect, it } from 'vitest';
import type { Review } from '../src/index.js';
import { reviewPanelConflictRule } from '../src/validator/rules/reviewPanelConflict.js';

function review(overrides: Partial<Review> & Record<string, unknown>): Review {
  return {
    id: 'R-001',
    sprint_id: 'S-001',
    verdict: 'pending',
    reviewer: 'agent',
    findings: [],
    created_at: '2026-04-25T10:00:00Z',
    extras: {},
    file: 'reviews/R-001.md',
    body: '',
    ...overrides,
  } as Review;
}

const ctx = (reviews: Review[]) => ({
  graph: {} as never,
  parsed: {
    sprints: [],
    epics: [],
    reviews,
    queues: [],
    lanes: [],
    nextMd: null,
    findings: [],
  },
  config: {} as never,
});

describe('reviewPanelConflictRule', () => {
  it('flags RED panel + accepted verdict as corrupt', () => {
    const findings = reviewPanelConflictRule(
      ctx([review({ panel_aggregate: 'RED', verdict: 'accepted' })]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('RED');
  });

  it('flags GREEN panel + changes_requested verdict as corrupt', () => {
    const findings = reviewPanelConflictRule(
      ctx([review({ panel_aggregate: 'GREEN', verdict: 'changes_requested' })]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('GREEN');
  });

  it('does NOT flag YELLOW + changes_requested when policy snapshot says yellow_blocks_close', () => {
    const findings = reviewPanelConflictRule(
      ctx([
        review({
          panel_aggregate: 'YELLOW',
          verdict: 'changes_requested',
          panel_policy_snapshot: { yellow_blocks_close: true },
        }),
      ]),
    );
    expect(findings).toHaveLength(0);
  });

  it('flags YELLOW + changes_requested when snapshot says yellow does NOT block', () => {
    const findings = reviewPanelConflictRule(
      ctx([
        review({
          panel_aggregate: 'YELLOW',
          verdict: 'changes_requested',
          panel_policy_snapshot: { yellow_blocks_close: false },
        }),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('YELLOW');
  });

  it('legacy review without snapshot defaults to non-blocking — flags YELLOW + changes_requested', () => {
    const findings = reviewPanelConflictRule(
      ctx([review({ panel_aggregate: 'YELLOW', verdict: 'changes_requested' })]),
    );
    expect(findings).toHaveLength(1);
  });

  it('no finding when there is no panel_aggregate', () => {
    const findings = reviewPanelConflictRule(ctx([review({ verdict: 'accepted' })]));
    expect(findings).toHaveLength(0);
  });
});
