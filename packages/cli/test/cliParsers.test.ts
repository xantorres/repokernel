import { describe, expect, it } from 'vitest';
import {
  parseRunMode,
  parseRunStatus,
  severityFailOnOrThrow,
  severityOrThrow,
} from '../src/index.js';

describe('severityOrThrow', () => {
  it('returns undefined for undefined input', () => {
    expect(severityOrThrow('--only', undefined)).toBeUndefined();
  });

  it('parses single severity', () => {
    expect(severityOrThrow('--only', 'P0')).toBe('P0');
    expect(severityOrThrow('--only', 'P3')).toBe('P3');
  });

  it('throws on invalid severity', () => {
    expect(() => severityOrThrow('--only', 'P9')).toThrow(/invalid --only value/);
  });

  it('rejects comma list — single-value parser only', () => {
    expect(() => severityOrThrow('--only', 'P0,P1')).toThrow(/invalid --only value/);
  });
});

describe('severityFailOnOrThrow', () => {
  it('returns undefined for undefined input', () => {
    expect(severityFailOnOrThrow('--fail-on', undefined)).toBeUndefined();
  });

  it('parses single severity (back-compat)', () => {
    expect(severityFailOnOrThrow('--fail-on', 'P0')).toBe('P0');
    expect(severityFailOnOrThrow('--fail-on', 'P1')).toBe('P1');
  });

  it('comma list collapses to least-severe (highest rank) — P0,P1 → P1', () => {
    expect(severityFailOnOrThrow('--fail-on', 'P0,P1')).toBe('P1');
  });

  it('comma list collapses to least-severe — P0,P1,P2 → P2', () => {
    expect(severityFailOnOrThrow('--fail-on', 'P0,P1,P2')).toBe('P2');
  });

  it('out-of-order comma list still picks least-severe — P3,P0,P1 → P3', () => {
    expect(severityFailOnOrThrow('--fail-on', 'P3,P0,P1')).toBe('P3');
  });

  it('tolerates whitespace around commas', () => {
    expect(severityFailOnOrThrow('--fail-on', 'P0 , P1')).toBe('P1');
  });

  it('throws on invalid severity in list', () => {
    expect(() => severityFailOnOrThrow('--fail-on', 'P0,P9')).toThrow(/invalid --fail-on value/);
  });

  it('throws on bare comma (empty list)', () => {
    expect(() => severityFailOnOrThrow('--fail-on', ',')).toThrow(/invalid --fail-on value/);
  });

  it('throws on wholly invalid input', () => {
    expect(() => severityFailOnOrThrow('--fail-on', 'oops')).toThrow(/invalid --fail-on value/);
  });
});

describe('parseRunMode', () => {
  it('returns undefined for undefined input', () => {
    expect(parseRunMode('--mode', undefined)).toBeUndefined();
  });

  it('accepts assisted', () => {
    expect(parseRunMode('--mode', 'assisted')).toBe('assisted');
  });

  it('accepts autonomous', () => {
    expect(parseRunMode('--mode', 'autonomous')).toBe('autonomous');
  });

  it('throws EXIT_USAGE for typo (autonomus → autonomous)', () => {
    expect(() => parseRunMode('--mode', 'autonomus')).toThrow(/invalid --mode value "autonomus"/);
  });

  it('throws on empty string', () => {
    expect(() => parseRunMode('--mode', '')).toThrow(/invalid --mode value/);
  });
});

describe('parseRunStatus', () => {
  it('returns undefined for undefined input', () => {
    expect(parseRunStatus('--status', undefined)).toBeUndefined();
  });

  it.each(['running', 'paused', 'completed', 'aborted', 'failed'])('accepts %s', (value) => {
    expect(parseRunStatus('--status', value)).toBe(value);
  });

  it('throws EXIT_USAGE for unknown status', () => {
    expect(() => parseRunStatus('--status', 'nope')).toThrow(/invalid --status value "nope"/);
  });
});
