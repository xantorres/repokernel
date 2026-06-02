import { describe, expect, it } from 'vitest';
import {
  AutomationSchema,
  ReviewerGateConfigSchema,
  resolveReviewerGate,
} from '../src/config/index.js';
import { ReviewerGateOutputSchema } from '../src/schemas/index.js';

describe('ReviewerGateConfigSchema', () => {
  it('applies defaults (authMode chatgpt, schemaPath null, rubricExtras null)', () => {
    const c = ReviewerGateConfigSchema.parse({});
    expect(c.authMode).toBe('chatgpt');
    expect(c.schemaPath).toBeNull();
    expect(c.rubricExtras).toBeNull();
    expect(c.model).toBeUndefined();
  });

  it('accepts a valid model token and rejects argv-injection-y ones', () => {
    expect(ReviewerGateConfigSchema.parse({ model: 'gpt-5.5' }).model).toBe('gpt-5.5');
    expect(() => ReviewerGateConfigSchema.parse({ model: '-rm' })).toThrow();
    expect(() => ReviewerGateConfigSchema.parse({ model: 'a b' })).toThrow();
    expect(() => ReviewerGateConfigSchema.parse({ model: 'a;b' })).toThrow();
  });

  it('rejects unknown keys including command (strict — command comes from trust)', () => {
    expect(() => ReviewerGateConfigSchema.parse({ command: 'codex' })).toThrow();
  });

  it('rejects an unknown authMode', () => {
    expect(() => ReviewerGateConfigSchema.parse({ authMode: 'oauth' })).toThrow();
  });
});

describe('AutomationSchema.reviewers', () => {
  it('accepts a reviewers map', () => {
    const a = AutomationSchema.parse({
      defaultReviewer: 'codex',
      reviewers: { codex: { model: 'gpt-5.5', authMode: 'chatgpt' } },
    });
    expect(a.reviewers?.codex?.model).toBe('gpt-5.5');
  });
});

describe('resolveReviewerGate', () => {
  it('returns the gate when effectiveReviewer names a configured reviewer', () => {
    const a = AutomationSchema.parse({ defaultReviewer: 'codex', reviewers: { codex: {} } });
    const gate = resolveReviewerGate(a);
    expect(gate?.name).toBe('codex');
    expect(gate?.config.authMode).toBe('chatgpt');
  });

  it('honors the reviewer override over defaultReviewer', () => {
    const a = AutomationSchema.parse({
      defaultReviewer: 'agent',
      reviewer: 'codex',
      reviewers: { codex: {} },
    });
    expect(resolveReviewerGate(a)?.name).toBe('codex');
  });

  it('returns null when no reviewer gate is configured', () => {
    expect(resolveReviewerGate(AutomationSchema.parse({ defaultReviewer: 'codex' }))).toBeNull();
  });

  it('returns null when effectiveReviewer is not a configured key', () => {
    const a = AutomationSchema.parse({ defaultReviewer: 'manual', reviewers: { codex: {} } });
    expect(resolveReviewerGate(a)).toBeNull();
  });
});

describe('ReviewerGateOutputSchema', () => {
  it('parses a valid verdict + findings', () => {
    const o = ReviewerGateOutputSchema.parse({
      verdict: 'changes_requested',
      findings: [{ severity: 'HIGH', message: 'unbounded loop' }],
      summary: 'one issue',
    });
    expect(o.verdict).toBe('changes_requested');
    expect(o.findings).toHaveLength(1);
  });
  it('defaults findings to []', () => {
    expect(ReviewerGateOutputSchema.parse({ verdict: 'accepted' }).findings).toEqual([]);
  });
  it('rejects pending / unknown verdicts', () => {
    expect(() => ReviewerGateOutputSchema.parse({ verdict: 'pending' })).toThrow();
    expect(() => ReviewerGateOutputSchema.parse({ verdict: 'lgtm' })).toThrow();
  });
  it('rejects unknown keys (strict)', () => {
    expect(() => ReviewerGateOutputSchema.parse({ verdict: 'accepted', extra: 1 })).toThrow();
  });
});
