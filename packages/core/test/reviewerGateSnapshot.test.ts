import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config/index.js';
import { AutomationSchema } from '../src/config/index.js';
import {
  composeVerdict,
  gateRequired,
  reviewerGateConfigFor,
  signGatePayload,
  verifyGateSignature,
} from '../src/gate/index.js';
import {
  type ReviewerGateSnapshot,
  ReviewerGateSnapshotSchema,
  ReviewFrontmatterSchema,
} from '../src/schemas/index.js';
import { sid } from './helpers/brand.js';

const SECRET = 'a'.repeat(64);
const SHA_A = '1111111111111111111111111111111111111111';
const SHA_B = '2222222222222222222222222222222222222222';

function signedSnapshot(over: Partial<ReviewerGateSnapshot> = {}): ReviewerGateSnapshot {
  const base = {
    reviewer: 'codex',
    review_attempt: 1,
    verdict: 'accepted' as const,
    findings: [],
    base_sha: SHA_A,
    end_sha: SHA_B,
    reviewed_at: '2026-06-02T00:00:00.000Z',
    ...over,
  };
  const signature = signGatePayload(SECRET, { ...base, review_id: 'R-1', sprint_id: 'S-1' });
  return ReviewerGateSnapshotSchema.parse({ ...base, signature });
}

const REVIEW_BASE = {
  id: 'R-1',
  sprint_id: 'S-1',
  verdict: 'pending' as const,
  reviewer: 'codex',
  created_at: '2026-06-02T00:00:00.000Z',
};

describe('ReviewerGateSnapshotSchema', () => {
  it('parses a well-formed signed snapshot', () => {
    const snap = signedSnapshot();
    expect(snap.verdict).toBe('accepted');
    expect(snap.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a non-hex64 signature and unknown keys (strict)', () => {
    expect(() =>
      ReviewerGateSnapshotSchema.parse({ ...signedSnapshot(), signature: 'nope' }),
    ).toThrow();
    expect(() => ReviewerGateSnapshotSchema.parse({ ...signedSnapshot(), extra: 1 })).toThrow();
  });

  it('rejects the pending verdict (a gate always decides)', () => {
    expect(() => signedSnapshot({ verdict: 'pending' as never })).toThrow();
  });
});

describe('ReviewFrontmatterSchema migration', () => {
  it('parses a legacy review file with no reviewer_gate', () => {
    const r = ReviewFrontmatterSchema.parse(REVIEW_BASE);
    expect(r.reviewer_gate).toBeUndefined();
  });

  it('parses a review file carrying a reviewer_gate snapshot', () => {
    const r = ReviewFrontmatterSchema.parse({ ...REVIEW_BASE, reviewer_gate: signedSnapshot() });
    expect(r.reviewer_gate?.verdict).toBe('accepted');
  });

  it('coerces reviewer_gate: null to undefined (optionalNullable)', () => {
    const r = ReviewFrontmatterSchema.parse({ ...REVIEW_BASE, reviewer_gate: null });
    expect(r.reviewer_gate).toBeUndefined();
  });
});

describe('gate signature', () => {
  it('round-trips: a freshly signed snapshot verifies', () => {
    const snap = signedSnapshot();
    expect(verifyGateSignature(SECRET, snap, { review_id: 'R-1', sprint_id: 'S-1' })).toBe(true);
  });

  it('fails when the verdict is tampered after signing', () => {
    const snap = { ...signedSnapshot(), verdict: 'changes_requested' as const };
    expect(verifyGateSignature(SECRET, snap, { review_id: 'R-1', sprint_id: 'S-1' })).toBe(false);
  });

  it('fails when lifted into another review (binding mismatch)', () => {
    const snap = signedSnapshot();
    expect(verifyGateSignature(SECRET, snap, { review_id: 'R-2', sprint_id: 'S-1' })).toBe(false);
    expect(verifyGateSignature(SECRET, snap, { review_id: 'R-1', sprint_id: 'S-2' })).toBe(false);
  });

  it('fails under a different secret', () => {
    const snap = signedSnapshot();
    expect(verifyGateSignature('b'.repeat(64), snap, { review_id: 'R-1', sprint_id: 'S-1' })).toBe(
      false,
    );
  });

  it('is order-independent for nested finding data (survives YAML key reordering)', () => {
    const findings = [{ severity: 'HIGH' as const, message: 'x', data: { a: 1, b: 2 } }];
    const snap = signedSnapshot({ findings });
    const reordered: ReviewerGateSnapshot = {
      ...snap,
      findings: [{ severity: 'HIGH', message: 'x', data: { b: 2, a: 1 } }],
    };
    expect(verifyGateSignature(SECRET, reordered, { review_id: 'R-1', sprint_id: 'S-1' })).toBe(
      true,
    );
  });
});

describe('gateRequired / composeVerdict', () => {
  const policiesOn = { requireReviewForShipped: true } as Config['policies'];
  const policiesOff = { requireReviewForShipped: false } as Config['policies'];
  const automationGated = AutomationSchema.parse({
    defaultReviewer: 'codex',
    reviewers: { codex: {} },
  });
  const automationUngated = AutomationSchema.parse({ defaultReviewer: 'codex' });

  it('requires a gate when review is required AND a default gate is configured', () => {
    expect(
      gateRequired(
        { id: sid('S-1'), review_required: true },
        { policies: policiesOn, automation: automationGated },
      ),
    ).toBe(true);
  });

  it('does not require a gate when no reviewer gate is configured', () => {
    expect(
      gateRequired(
        { id: sid('S-1'), review_required: true },
        { policies: policiesOn, automation: automationUngated },
      ),
    ).toBe(false);
  });

  it('does not require a gate when review is not required', () => {
    expect(
      gateRequired(
        { id: sid('S-1'), review_required: false },
        { policies: policiesOff, automation: automationGated },
      ),
    ).toBe(false);
  });

  it('resolves the configured gate for a reviewer, undefined for an unconfigured one', () => {
    expect(reviewerGateConfigFor(automationGated, 'codex')).toBeDefined();
    expect(reviewerGateConfigFor(automationGated, 'agent')).toBeUndefined();
  });

  it('composes most-restrictive-wins', () => {
    expect(composeVerdict('accepted', 'changes_requested')).toBe('changes_requested');
    expect(composeVerdict('accepted', 'rejected')).toBe('rejected');
    expect(composeVerdict('changes_requested', 'rejected')).toBe('rejected');
    expect(composeVerdict('accepted', 'accepted')).toBe('accepted');
    expect(composeVerdict('accepted', 'pending')).toBe('accepted');
  });
});
