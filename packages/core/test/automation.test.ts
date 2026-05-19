import { describe, expect, it } from 'vitest';
import { AutomationSchema, ChecksPhasesSchema, effectiveReviewer } from '../src/config/index.js';

describe('AutomationSchema', () => {
  it('rejects checksCmd + checksPhases together', () => {
    expect(() =>
      AutomationSchema.parse({
        checksCmd: 'pnpm test',
        checksPhases: { test: 'pnpm test' },
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('accepts either checksCmd OR checksPhases alone', () => {
    expect(() => AutomationSchema.parse({ checksCmd: 'pnpm test' })).not.toThrow();
    expect(() =>
      AutomationSchema.parse({
        checksPhases: { build: 'pnpm build', test: 'pnpm test' },
      }),
    ).not.toThrow();
  });

  it('exposes the new optional fields with the right shape', () => {
    const a = AutomationSchema.parse({
      reviewer: 'codex',
      binary: '/Users/x/.local/bin/rk',
      checksPhases: { check: 'pnpm check' },
    });
    expect(a.reviewer).toBe('codex');
    expect(a.binary).toBe('/Users/x/.local/bin/rk');
    expect(a.checksPhases?.check).toBe('pnpm check');
  });
});

describe('ChecksPhasesSchema', () => {
  it('requires at least one phase', () => {
    expect(() => ChecksPhasesSchema.parse({})).toThrow(/at least one/);
  });

  it('accepts a single phase', () => {
    expect(() => ChecksPhasesSchema.parse({ test: 'pnpm test' })).not.toThrow();
  });

  it('rejects unknown phase keys (strict)', () => {
    expect(() => ChecksPhasesSchema.parse({ check: 'pnpm check', unknown: 'noop' })).toThrow();
  });
});

describe('effectiveReviewer', () => {
  it('returns automation.reviewer when set', () => {
    const a = AutomationSchema.parse({
      reviewer: 'codex',
      defaultReviewer: 'agent',
    });
    expect(effectiveReviewer(a)).toBe('codex');
  });

  it('falls back to defaultReviewer when reviewer is unset', () => {
    const a = AutomationSchema.parse({ defaultReviewer: 'gpt' });
    expect(effectiveReviewer(a)).toBe('gpt');
  });
});
